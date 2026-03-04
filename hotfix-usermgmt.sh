#!/bin/bash
# ╔══════════════════════════════════════════════════════════════╗
# ║  HOTFIX: User Management — DB + Route Check                 ║
# ║  Run from /root/slot-stars:  bash hotfix-usermgmt.sh        ║
# ╚══════════════════════════════════════════════════════════════╝
set -e

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  Hotfix: User Management DB + Routes         ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ─── 1. Check and apply DB migrations directly via node ───
echo "🔧 [1/4] Running DB migrations..."

node -e "
const db = require('./db');
const stmts = [
  \"ALTER TABLE users ADD COLUMN account_status TEXT DEFAULT 'active'\",
  \"ALTER TABLE users ADD COLUMN suspend_reason TEXT\",
  \"ALTER TABLE users ADD COLUMN ban_reason TEXT\",
  \"ALTER TABLE users ADD COLUMN suspended_until DATETIME\",
  \"ALTER TABLE users ADD COLUMN banned_until DATETIME\",
  \"ALTER TABLE users ADD COLUMN admin_notes TEXT DEFAULT ''\",
  \"ALTER TABLE users ADD COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP\"
];
stmts.forEach(s => { try { db.exec(s); console.log('  + ' + s.split(' ')[4]); } catch(e) { /* already exists */ } });

db.exec(\`
  CREATE TABLE IF NOT EXISTS ip_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    ip TEXT NOT NULL,
    user_agent TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_ip_log_user ON ip_log(user_id);
  CREATE INDEX IF NOT EXISTS idx_ip_log_ip ON ip_log(ip);

  CREATE TABLE IF NOT EXISTS user_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_user_id INTEGER,
    target_user_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    reason TEXT,
    duration_hours INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_user_actions_target ON user_actions(target_user_id);

  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at DATETIME NOT NULL,
    used INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_reset_tokens ON password_reset_tokens(token);
\`);

console.log('  ✅ All tables and columns verified');
"

# ─── 2. Verify route file exists ───
echo ""
echo "🔧 [2/4] Checking route file..."
if [ -f routes/user-management.js ]; then
  echo "   ✅ routes/user-management.js exists"
else
  echo "   ⚠️  routes/user-management.js MISSING — re-run patch-user-mgmt.sh"
  exit 1
fi

# ─── 3. Check server.js has the route mounted ───
echo ""
echo "🔧 [3/4] Checking server.js..."

if grep -q "user-management" server.js; then
  echo "   ✅ user-management route mounted"
else
  echo "   ⚠️  Route not mounted. Adding it now..."
  # Find the line with admin routes and add after it
  python3 -c "
content = open('server.js').read()
import re
# Look for admin route mount
m = re.search(r\"(app\.use\(['\\\"]\/api\/admin['\\\"],\s*require\(['\\\"]\.\/routes\/admin['\\\"]\)\);)\", content)
if m:
    insert = m.group(0) + \"\napp.use('/api/admin', require('./routes/user-management'));\"
    content = content.replace(m.group(0), insert, 1)
    open('server.js','w').write(content)
    print('   ✅ Route added after admin mount')
else:
    # Fallback: add before app.listen
    if 'app.listen' in content:
        content = content.replace('app.listen', \"app.use('/api/admin', require('./routes/user-management'));\napp.listen\", 1)
        open('server.js','w').write(content)
        print('   ✅ Route added before app.listen')
    else:
        print('   ⚠️  Could not auto-add — please add manually:')
        print(\"     app.use('/api/admin', require('./routes/user-management'));\")
"
fi

# ─── 4. Test the endpoint ───
echo ""
echo "🔧 [4/4] Testing endpoint..."

# Quick node test to verify the query works
node -e "
const db = require('./db');
try {
  const users = db.prepare(\`
    SELECT u.id, u.username, u.role, u.credits, u.account_status,
      (SELECT ip FROM ip_log WHERE user_id=u.id ORDER BY created_at DESC LIMIT 1) as last_ip,
      (SELECT COUNT(*) FROM spins WHERE user_id=u.id) as total_rounds
    FROM users u ORDER BY u.id DESC LIMIT 3
  \`).all();
  console.log('  ✅ Query works — found ' + users.length + ' users');
  users.forEach(u => console.log('    #' + u.id + ' ' + u.username + ' status=' + (u.account_status||'active')));
} catch(e) {
  console.log('  ❌ Query failed: ' + e.message);
}
"

echo ""
echo "══════════════════════════════════════════════"
echo "  Done. Now restart:  pm2 restart slot-stars"
echo "══════════════════════════════════════════════"
echo ""
