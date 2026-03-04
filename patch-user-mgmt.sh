#!/bin/bash
# ╔══════════════════════════════════════════════════════════════╗
# ║  PATCH: Advanced User Management                            ║
# ║  Run from /root/slot-stars:  bash patch-user-mgmt.sh        ║
# ╚══════════════════════════════════════════════════════════════╝
set -e

TS=$(date +%Y%m%d_%H%M%S)
echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  Advanced User Management System             ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ─── Backup ───
mkdir -p backups/$TS
for f in db.js server.js middleware/auth.js routes/admin.js public/pages/admin.html; do
  [ -f "$f" ] && cp "$f" "backups/$TS/$(basename $f)"
done
echo "📦 Backed up to backups/$TS/"

# ══════════════════════════════════════════════════
# 1. DB MIGRATIONS — add columns + tables
# ══════════════════════════════════════════════════
echo ""
echo "🔧 [1/6] Database migrations..."

python3 << 'PYEOF'
f = 'db.js'
content = open(f).read()
changes = 0

migration_block = """
// ── Advanced User Management migrations ──
try { db.exec("ALTER TABLE users ADD COLUMN account_status TEXT DEFAULT 'active'"); } catch(e) {}
try { db.exec("ALTER TABLE users ADD COLUMN suspend_reason TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE users ADD COLUMN ban_reason TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE users ADD COLUMN suspended_until DATETIME"); } catch(e) {}
try { db.exec("ALTER TABLE users ADD COLUMN banned_until DATETIME"); } catch(e) {}
try { db.exec("ALTER TABLE users ADD COLUMN admin_notes TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE users ADD COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP"); } catch(e) {}

db.exec(`
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
`);
"""

if 'ip_log' not in content:
    # Insert before module.exports
    marker = 'module.exports = db;'
    if marker in content:
        content = content.replace(marker, migration_block + '\n' + marker, 1)
        changes += 1
        print("   ✅ DB migrations added (ip_log, user_actions, password_reset_tokens, user columns)")
else:
    print("   ℹ️  Migrations already present")

if changes > 0:
    open(f, 'w').write(content)
PYEOF

# ══════════════════════════════════════════════════
# 2. COPY ROUTE FILE
# ══════════════════════════════════════════════════
echo ""
echo "🔧 [2/6] Installing user-management routes..."

cat > routes/user-management.js << 'ROUTEOF'
/**
 * Advanced User Management Routes
 * File: routes/user-management.js
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.session.userId);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Not admin' });
  next();
}
router.use(requireAdmin);

router.get('/users-advanced', (req, res) => {
  try {
    const users = db.prepare(`
      SELECT u.id, u.username, u.role, u.credits, u.reseller_credits, u.xp, u.level, u.title,
             u.account_status, u.suspend_reason, u.ban_reason,
             u.suspended_until, u.banned_until, u.admin_notes, u.created_at,
             (SELECT ip FROM ip_log WHERE user_id=u.id ORDER BY created_at DESC LIMIT 1) as last_ip,
             (SELECT created_at FROM ip_log WHERE user_id=u.id ORDER BY created_at DESC LIMIT 1) as last_ip_time,
             (SELECT COUNT(DISTINCT ip) FROM ip_log WHERE user_id=u.id) as unique_ips,
             (SELECT COUNT(*) FROM spins WHERE user_id=u.id) as total_rounds,
             (SELECT COALESCE(SUM(bet),0) FROM spins WHERE user_id=u.id) as total_wagered,
             (SELECT COALESCE(SUM(payout),0) FROM spins WHERE user_id=u.id) as total_won,
             CASE
               WHEN u.account_status='banned' AND (u.banned_until IS NULL OR u.banned_until > datetime('now')) THEN 'banned'
               WHEN u.account_status='suspended' AND (u.suspended_until IS NULL OR u.suspended_until > datetime('now')) THEN 'suspended'
               WHEN u.account_status IN ('banned','suspended') AND
                 ((u.account_status='banned' AND u.banned_until <= datetime('now')) OR
                  (u.account_status='suspended' AND u.suspended_until <= datetime('now'))) THEN 'active'
               ELSE COALESCE(u.account_status, 'active')
             END as effective_status
      FROM users u ORDER BY u.id DESC
    `).all();
    const liveSessions = db.prepare("SELECT user_id FROM active_sessions WHERE last_seen > datetime('now','-3 minutes')").all();
    const liveSet = new Set(liveSessions.map(s => s.user_id));
    users.forEach(u => {
      u.is_online = liveSet.has(u.id);
      if ((u.effective_status === 'active') && (u.account_status === 'banned' || u.account_status === 'suspended')) {
        db.prepare("UPDATE users SET account_status='active', suspend_reason=NULL, ban_reason=NULL WHERE id=?").run(u.id);
        u.account_status = 'active';
      }
    });
    res.json({ users });
  } catch(e) { console.error('Users advanced error:', e); res.status(500).json({ error: e.message }); }
});

router.get('/user/:id', (req, res) => {
  try {
    const user = db.prepare(`
      SELECT u.*,
        (SELECT COUNT(*) FROM spins WHERE user_id=u.id) as total_rounds,
        (SELECT COALESCE(SUM(bet),0) FROM spins WHERE user_id=u.id) as total_wagered,
        (SELECT COALESCE(SUM(payout),0) FROM spins WHERE user_id=u.id) as total_won,
        (SELECT MAX(payout) FROM spins WHERE user_id=u.id) as biggest_win,
        (SELECT game FROM spins WHERE user_id=u.id GROUP BY game ORDER BY COUNT(*) DESC LIMIT 1) as favorite_game,
        (SELECT created_at FROM spins WHERE user_id=u.id ORDER BY created_at DESC LIMIT 1) as last_played
      FROM users u WHERE u.id = ?
    `).get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const ips = db.prepare("SELECT ip, COUNT(*) as times, MIN(created_at) as first_seen, MAX(created_at) as last_seen FROM ip_log WHERE user_id=? GROUP BY ip ORDER BY last_seen DESC LIMIT 20").all(req.params.id);
    const actions = db.prepare("SELECT * FROM user_actions WHERE target_user_id=? ORDER BY created_at DESC LIMIT 30").all(req.params.id);
    const recentSpins = db.prepare("SELECT game, bet, payout, created_at FROM spins WHERE user_id=? ORDER BY created_at DESC LIMIT 20").all(req.params.id);
    const resetTokens = db.prepare("SELECT token, expires_at, used FROM password_reset_tokens WHERE user_id=? AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 5").all(req.params.id);
    res.json({ user, ips, actions, recentSpins, resetTokens });
  } catch(e) { console.error('User detail error:', e); res.status(500).json({ error: e.message }); }
});

router.post('/user/suspend', (req, res) => {
  const { userId, reason, duration } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'Reason required' });
  try {
    const target = db.prepare('SELECT username, role FROM users WHERE id=?').get(userId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'admin') return res.status(400).json({ error: 'Cannot suspend admins' });
    let until = null;
    if (duration && duration > 0) until = new Date(Date.now() + duration * 3600000).toISOString();
    db.prepare("UPDATE users SET account_status='suspended', suspend_reason=?, suspended_until=? WHERE id=?").run(reason.trim(), until, userId);
    db.prepare("INSERT INTO user_actions (admin_user_id, target_user_id, action, reason, duration_hours, created_at) VALUES (?,?,?,?,?,datetime('now'))").run(req.session.userId, userId, 'suspend', reason.trim(), duration || null);
    res.json({ success: true, message: target.username + ' suspended' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/user/ban', (req, res) => {
  const { userId, reason, duration } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'Reason required' });
  try {
    const target = db.prepare('SELECT username, role FROM users WHERE id=?').get(userId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'admin') return res.status(400).json({ error: 'Cannot ban admins' });
    let until = null;
    if (duration && duration > 0) until = new Date(Date.now() + duration * 3600000).toISOString();
    db.prepare("UPDATE users SET account_status='banned', ban_reason=?, banned_until=? WHERE id=?").run(reason.trim(), until, userId);
    db.prepare("INSERT INTO user_actions (admin_user_id, target_user_id, action, reason, duration_hours, created_at) VALUES (?,?,?,?,?,datetime('now'))").run(req.session.userId, userId, 'ban', reason.trim(), duration || null);
    db.prepare('DELETE FROM active_sessions WHERE user_id=?').run(userId);
    res.json({ success: true, message: target.username + ' banned' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/user/unban', (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  try {
    const target = db.prepare('SELECT username FROM users WHERE id=?').get(userId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    db.prepare("UPDATE users SET account_status='active', suspend_reason=NULL, ban_reason=NULL, suspended_until=NULL, banned_until=NULL WHERE id=?").run(userId);
    db.prepare("INSERT INTO user_actions (admin_user_id, target_user_id, action, reason, created_at) VALUES (?,?,?,?,datetime('now'))").run(req.session.userId, userId, 'unban', 'Manually lifted by admin');
    res.json({ success: true, message: target.username + ' restrictions lifted' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/user/reset-password', (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  try {
    const target = db.prepare('SELECT username FROM users WHERE id=?').get(userId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    const token = uuidv4().replace(/-/g, '').slice(0, 24);
    const expires = new Date(Date.now() + 24 * 3600000).toISOString();
    db.prepare("INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?,?,?)").run(userId, token, expires);
    db.prepare("INSERT INTO user_actions (admin_user_id, target_user_id, action, reason, created_at) VALUES (?,?,?,?,datetime('now'))").run(req.session.userId, userId, 'password_reset', 'Reset link generated');
    const link = '/reset-password?token=' + token;
    res.json({ success: true, token, link, expires, username: target.username });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/user/force-password', (req, res) => {
  const { userId, newPassword } = req.body;
  if (!userId || !newPassword) return res.status(400).json({ error: 'Missing fields' });
  if (newPassword.length < 4) return res.status(400).json({ error: 'Password too short (min 4)' });
  try {
    const target = db.prepare('SELECT username FROM users WHERE id=?').get(userId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    const hash = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE users SET password=? WHERE id=?').run(hash, userId);
    db.prepare("INSERT INTO user_actions (admin_user_id, target_user_id, action, reason, created_at) VALUES (?,?,?,?,datetime('now'))").run(req.session.userId, userId, 'force_password', 'Password changed by admin');
    res.json({ success: true, message: 'Password updated for ' + target.username });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/user/notes', (req, res) => {
  const { userId, notes } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  try {
    db.prepare('UPDATE users SET admin_notes=? WHERE id=?').run(notes || '', userId);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/user/adjust-credits', (req, res) => {
  const { userId, amount, reason } = req.body;
  if (!userId || amount === undefined) return res.status(400).json({ error: 'Missing fields' });
  try {
    const target = db.prepare('SELECT username, credits FROM users WHERE id=?').get(userId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    const amt = Math.round(parseFloat(amount) * 100);
    db.prepare('UPDATE users SET credits = MAX(0, credits + ?) WHERE id=?').run(amt, userId);
    db.prepare("INSERT INTO user_actions (admin_user_id, target_user_id, action, reason, created_at) VALUES (?,?,?,?,datetime('now'))").run(
      req.session.userId, userId, amt >= 0 ? 'credit_add' : 'credit_remove',
      (amt >= 0 ? '+' : '') + '$' + (amt/100).toFixed(2) + (reason ? ' — ' + reason : '')
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/user-actions', (req, res) => {
  try {
    const actions = db.prepare(`
      SELECT ua.*, admin.username as admin_name, target.username as target_name
      FROM user_actions ua
      LEFT JOIN users admin ON ua.admin_user_id = admin.id
      LEFT JOIN users target ON ua.target_user_id = target.id
      ORDER BY ua.created_at DESC LIMIT 100
    `).all();
    res.json({ actions });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/ip-lookup/:ip', (req, res) => {
  try {
    const users = db.prepare(`
      SELECT DISTINCT u.id, u.username, u.role, u.account_status,
        COUNT(*) as login_count, MIN(il.created_at) as first_seen, MAX(il.created_at) as last_seen
      FROM ip_log il JOIN users u ON il.user_id = u.id WHERE il.ip = ?
      GROUP BY u.id ORDER BY last_seen DESC
    `).all(req.params.ip);
    res.json({ ip: req.params.ip, users });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
ROUTEOF

echo "   ✅ routes/user-management.js created"

# ══════════════════════════════════════════════════
# 3. MOUNT ROUTE + IP LOGGING + BAN CHECK in server.js
# ══════════════════════════════════════════════════
echo ""
echo "🔧 [3/6] Patching server.js..."

python3 << 'PYEOF'
f = 'server.js'
try:
    content = open(f).read()
except FileNotFoundError:
    print("   ⚠️  server.js not found — you'll need to manually add:"); 
    print("     app.use('/api/admin', require('./routes/user-management'));")
    print("     IP logging middleware and ban check middleware")
    exit(0)

changes = 0

# A) Mount user-management routes
if 'user-management' not in content:
    # Find where admin routes are mounted
    import re
    admin_mount = re.search(r"app\.use\(['\"]\/api\/admin['\"],\s*require\(['\"]\.\/routes\/admin['\"]\)\)", content)
    if admin_mount:
        insert_at = admin_mount.end()
        content = content[:insert_at] + "\napp.use('/api/admin', require('./routes/user-management'));" + content[insert_at:]
        changes += 1
        print("   ✅ Mounted user-management routes")
    else:
        # Try alternative patterns
        if "require('./routes/admin')" in content:
            content = content.replace(
                "require('./routes/admin')",
                "require('./routes/admin')",
                1
            )
            # Just append after the admin route line
            lines = content.split('\n')
            for i, line in enumerate(lines):
                if "routes/admin'" in line and 'user-management' not in line and 'admin-extras' not in line:
                    lines.insert(i+1, "app.use('/api/admin', require('./routes/user-management'));")
                    changes += 1
                    print("   ✅ Mounted user-management routes (after admin)")
                    break
            content = '\n'.join(lines)

# B) Add IP logging middleware (log IP on every authenticated request)
if 'ip_log' not in content and 'ipLogMiddleware' not in content:
    ip_middleware = """
// ── IP Logging Middleware ──
app.use((req, res, next) => {
  if (req.session && req.session.userId && req.path.startsWith('/api/')) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.headers['x-real-ip'] || req.connection.remoteAddress || req.ip;
    try {
      // Log IP at most once per hour per user
      const recent = db.prepare("SELECT id FROM ip_log WHERE user_id=? AND ip=? AND created_at > datetime('now','-1 hour')").get(req.session.userId, ip);
      if (!recent) {
        db.prepare('INSERT INTO ip_log (user_id, ip, user_agent) VALUES (?,?,?)').run(req.session.userId, ip, (req.headers['user-agent']||'').slice(0,200));
      }
    } catch(e) {}
  }
  next();
});
"""
    # Insert after session middleware setup - look for session() usage
    session_match = re.search(r"app\.use\(session\(", content)
    if session_match:
        # Find the end of the session middleware block
        # Look for the closing ));
        pos = session_match.start()
        depth = 0
        i = pos
        while i < len(content):
            if content[i] == '(':
                depth += 1
            elif content[i] == ')':
                depth -= 1
                if depth == 0:
                    # Find the semicolon
                    semi = content.index(';', i)
                    content = content[:semi+1] + ip_middleware + content[semi+1:]
                    changes += 1
                    print("   ✅ IP logging middleware added")
                    break
            i += 1
    else:
        print("   ⚠️  Could not find session middleware — add IP logging manually")

# C) Add ban/suspend check middleware
if 'account_status' not in content and 'banCheckMiddleware' not in content:
    ban_middleware = """
// ── Ban/Suspend Check Middleware ──
app.use((req, res, next) => {
  if (req.session && req.session.userId && req.path.startsWith('/api/') && !req.path.startsWith('/api/auth')) {
    try {
      const user = db.prepare('SELECT account_status, suspended_until, banned_until FROM users WHERE id=?').get(req.session.userId);
      if (user) {
        if (user.account_status === 'banned') {
          if (!user.banned_until || new Date(user.banned_until) > new Date()) {
            return res.status(403).json({ error: 'Account banned', banned: true });
          }
        }
        if (user.account_status === 'suspended') {
          if (!user.suspended_until || new Date(user.suspended_until) > new Date()) {
            return res.status(403).json({ error: 'Account suspended', suspended: true });
          }
        }
      }
    } catch(e) {}
  }
  next();
});
"""
    # Insert after IP middleware (or after session)
    if 'ip_log' in content:
        # Find the end of the IP middleware block
        ip_idx = content.find('// ── IP Logging Middleware')
        if ip_idx > -1:
            # Find the closing of that middleware
            next_close = content.find('});', ip_idx)
            if next_close > -1:
                content = content[:next_close+3] + ban_middleware + content[next_close+3:]
                changes += 1
                print("   ✅ Ban/suspend check middleware added")
    else:
        print("   ⚠️  Add ban check middleware manually")

# D) Add password reset route (public, no auth)
if 'reset-password' not in content:
    reset_route = """
// ── Password Reset Page ──
app.get('/reset-password', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public/pages/reset-password.html'));
});
app.post('/api/auth/reset-password', (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: 'Missing fields' });
  if (newPassword.length < 4) return res.status(400).json({ error: 'Password too short' });
  try {
    const row = db.prepare("SELECT * FROM password_reset_tokens WHERE token=? AND expires_at > datetime('now') AND used=0").get(token);
    if (!row) return res.status(400).json({ error: 'Invalid or expired token' });
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE users SET password=? WHERE id=?').run(hash, row.user_id);
    db.prepare('UPDATE password_reset_tokens SET used=1 WHERE id=?').run(row.id);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
"""
    # Add before the catch-all or at the end of routes
    if "app.get('*'" in content:
        content = content.replace("app.get('*'", reset_route + "\napp.get('*'", 1)
        changes += 1
        print("   ✅ Password reset route added")
    elif 'app.listen' in content:
        content = content.replace('app.listen', reset_route + '\napp.listen', 1)
        changes += 1
        print("   ✅ Password reset route added (before listen)")

if changes > 0:
    open(f, 'w').write(content)
    print(f"   ✅ server.js: {changes} patches applied")
else:
    print("   ℹ️  server.js: No changes needed (or manual edits required)")
PYEOF

# ══════════════════════════════════════════════════
# 4. PASSWORD RESET PAGE
# ══════════════════════════════════════════════════
echo ""
echo "🔧 [4/6] Creating password reset page..."

cat > public/pages/reset-password.html << 'RESETEOF'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Reset Password — Slot Stars Club</title>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Rajdhani:wght@400;600;700&display=swap" rel="stylesheet">
<style>
:root{--gold:#FFD700;--gold2:#FFA500;--neon:#00FFCC;--red:#FF4455;--dark:#050510;--dark2:#0a0a1f;--border:rgba(255,215,0,0.15);--muted:rgba(255,255,255,0.4);}
*{margin:0;padding:0;box-sizing:border-box;}
body{background:var(--dark);color:#fff;font-family:'Rajdhani',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;}
.reset-card{background:var(--dark2);border:1px solid var(--border);border-top:3px solid var(--gold);padding:2.5rem 2rem;max-width:400px;width:90%;}
.logo{font-family:'Bebas Neue',sans-serif;font-size:1.6rem;letter-spacing:4px;text-align:center;margin-bottom:0.3rem;background:linear-gradient(135deg,var(--gold),var(--gold2));-webkit-background-clip:text;-webkit-text-fill-color:transparent;}
.subtitle{text-align:center;font-size:0.75rem;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:1.5rem;}
.field{margin-bottom:1rem;}
.field label{font-size:0.68rem;letter-spacing:2px;text-transform:uppercase;color:var(--muted);display:block;margin-bottom:0.3rem;}
.field input{width:100%;padding:0.6rem 0.8rem;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.1);color:#fff;font-family:'Rajdhani',sans-serif;font-size:1rem;font-weight:600;outline:none;transition:border-color 0.2s;}
.field input:focus{border-color:var(--gold);}
.btn-reset{width:100%;padding:0.75rem;background:linear-gradient(135deg,rgba(255,215,0,0.12),rgba(255,165,0,0.06));border:2px solid var(--gold);color:var(--gold);font-family:'Bebas Neue',sans-serif;font-size:1.1rem;letter-spacing:3px;cursor:pointer;transition:all 0.2s;}
.btn-reset:hover{background:rgba(255,215,0,0.2);}
.msg{text-align:center;margin-top:1rem;font-size:0.85rem;padding:0.5rem;}
.msg.ok{color:var(--neon);border:1px solid rgba(0,255,204,0.2);background:rgba(0,255,204,0.05);}
.msg.err{color:var(--red);border:1px solid rgba(255,68,85,0.2);background:rgba(255,68,85,0.05);}
</style>
</head>
<body>
<div class="reset-card">
  <div class="logo">★ SSC</div>
  <div class="subtitle">Reset Your Password</div>
  <div class="field">
    <label>New Password</label>
    <input type="password" id="pw1" placeholder="Enter new password" minlength="4">
  </div>
  <div class="field">
    <label>Confirm Password</label>
    <input type="password" id="pw2" placeholder="Confirm new password" minlength="4">
  </div>
  <button class="btn-reset" onclick="doReset()">Update Password</button>
  <div class="msg" id="msg" style="display:none"></div>
</div>
<script>
async function doReset() {
  const pw1 = document.getElementById('pw1').value;
  const pw2 = document.getElementById('pw2').value;
  const msg = document.getElementById('msg');
  if (!pw1 || pw1.length < 4) { showMsg('Password must be at least 4 characters', true); return; }
  if (pw1 !== pw2) { showMsg('Passwords do not match', true); return; }
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  if (!token) { showMsg('Invalid reset link — no token found', true); return; }
  try {
    const r = await fetch('/api/auth/reset-password', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ token, newPassword: pw1 })
    });
    const data = await r.json();
    if (r.ok && data.success) {
      showMsg('Password updated! Redirecting to login...', false);
      setTimeout(() => window.location = '/', 2000);
    } else {
      showMsg(data.error || 'Reset failed', true);
    }
  } catch(e) { showMsg('Network error', true); }
}
function showMsg(text, isErr) {
  const m = document.getElementById('msg');
  m.textContent = text; m.className = 'msg ' + (isErr?'err':'ok'); m.style.display = 'block';
}
document.getElementById('pw2').addEventListener('keydown', e => { if(e.key==='Enter') doReset(); });
</script>
</body>
</html>
RESETEOF

echo "   ✅ public/pages/reset-password.html created"

# ══════════════════════════════════════════════════
# 5. PATCH admin.html — Replace Users section + add Audit Log
# ══════════════════════════════════════════════════
echo ""
echo "🔧 [5/6] Upgrading admin.html Users section..."

python3 << 'PYEOF'
f = 'public/pages/admin.html'
content = open(f).read()
changes = 0

# ── A) Add new CSS for user management ──
new_css = """
  /* ── User Management ── */
  .user-status{padding:0.15rem 0.5rem;font-size:0.6rem;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;display:inline-flex;align-items:center;gap:0.3rem;}
  .user-status.online{background:rgba(0,255,157,0.1);color:var(--c-active);border:1px solid rgba(0,255,157,0.25);}
  .user-status.online::before{content:'';width:5px;height:5px;border-radius:50%;background:var(--c-active);animation:blink 1.5s infinite;}
  .user-status.offline{background:rgba(255,255,255,0.03);color:var(--muted);border:1px solid rgba(255,255,255,0.08);}
  .user-status.banned{background:rgba(255,68,85,0.1);color:var(--red);border:1px solid rgba(255,68,85,0.25);}
  .user-status.suspended{background:rgba(255,170,0,0.1);color:var(--amber);border:1px solid rgba(255,170,0,0.25);}

  .um-modal-overlay{display:none;position:fixed;inset:0;z-index:200;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px);align-items:center;justify-content:center;}
  .um-modal-overlay.show{display:flex;}
  .um-modal{background:var(--dark2);border:1px solid var(--border);border-top:3px solid var(--gold);max-width:600px;width:95%;max-height:85vh;overflow-y:auto;}
  .um-modal-head{padding:1rem 1.5rem;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border);}
  .um-modal-title{font-family:'Bebas Neue',sans-serif;font-size:1.3rem;letter-spacing:3px;color:var(--gold);}
  .um-modal-close{background:none;border:none;color:var(--muted);font-size:1.3rem;cursor:pointer;padding:0.3rem;}
  .um-modal-close:hover{color:var(--red);}
  .um-modal-body{padding:1.25rem 1.5rem;}

  .um-detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:0.6rem;margin-bottom:1rem;}
  .um-detail-item{background:var(--dark3);padding:0.6rem 0.8rem;}
  .um-detail-val{font-family:'Bebas Neue',sans-serif;font-size:1.1rem;color:var(--gold);letter-spacing:1px;}
  .um-detail-lbl{font-size:0.55rem;letter-spacing:2px;text-transform:uppercase;color:var(--muted);}

  .um-section{margin-top:1.2rem;padding-top:1rem;border-top:1px solid var(--border);}
  .um-section-title{font-size:0.62rem;letter-spacing:2.5px;text-transform:uppercase;color:var(--muted);margin-bottom:0.7rem;}

  .um-action-row{display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.6rem;}
  .um-btn{padding:0.35rem 0.85rem;font-family:'Rajdhani',sans-serif;font-size:0.78rem;font-weight:700;letter-spacing:1px;text-transform:uppercase;cursor:pointer;border:1px solid;background:transparent;transition:all 0.15s;}
  .um-btn.suspend{border-color:rgba(255,170,0,0.4);color:var(--amber);}.um-btn.suspend:hover{background:rgba(255,170,0,0.1);}
  .um-btn.ban{border-color:rgba(255,68,85,0.4);color:var(--red);}.um-btn.ban:hover{background:rgba(255,68,85,0.1);}
  .um-btn.unban{border-color:rgba(0,255,204,0.4);color:var(--neon);}.um-btn.unban:hover{background:rgba(0,255,204,0.1);}
  .um-btn.pw{border-color:rgba(155,89,182,0.4);color:#bb86fc;}.um-btn.pw:hover{background:rgba(155,89,182,0.1);}
  .um-btn.sm{padding:0.2rem 0.5rem;font-size:0.68rem;}

  .um-ip{font-family:monospace;font-size:0.78rem;color:var(--neon);cursor:pointer;text-decoration:underline;text-decoration-color:rgba(0,255,204,0.3);}
  .um-ip:hover{color:#fff;}

  .um-action-log{font-size:0.78rem;}
  .um-action-log .action-item{padding:0.4rem 0;border-bottom:1px solid rgba(255,255,255,0.03);display:flex;gap:0.5rem;align-items:baseline;}
  .action-type{padding:0.1rem 0.35rem;font-size:0.58rem;letter-spacing:1px;text-transform:uppercase;font-weight:700;}
  .action-type.suspend{background:rgba(255,170,0,0.1);color:var(--amber);border:1px solid rgba(255,170,0,0.2);}
  .action-type.ban{background:rgba(255,68,85,0.1);color:var(--red);border:1px solid rgba(255,68,85,0.2);}
  .action-type.unban{background:rgba(0,255,204,0.1);color:var(--neon);border:1px solid rgba(0,255,204,0.2);}
  .action-type.password_reset,.action-type.force_password{background:rgba(155,89,182,0.1);color:#bb86fc;border:1px solid rgba(155,89,182,0.2);}
  .action-type.credit_add{background:rgba(0,255,157,0.1);color:var(--c-active);border:1px solid rgba(0,255,157,0.2);}
  .action-type.credit_remove{background:rgba(255,68,85,0.1);color:var(--red);border:1px solid rgba(255,68,85,0.2);}

  .um-search{padding:0.45rem 0.8rem;background:var(--dark3);border:1px solid rgba(255,255,255,0.1);color:#fff;font-family:'Rajdhani',sans-serif;font-size:0.88rem;outline:none;width:250px;transition:border-color 0.2s;}
  .um-search:focus{border-color:var(--gold);}
"""

first_style_end = content.find('</style>')
if first_style_end > -1 and 'um-modal' not in content:
    content = content[:first_style_end] + new_css + '\n' + content[first_style_end:]
    changes += 1
    print("   ✅ User management CSS added")

# ── B) Add Audit Log nav link ──
if 'audit' not in content.lower() or "show('audit')" not in content:
    old_nav = """<button class="nav-link" onclick="show('users')">◈ Users</button>"""
    new_nav = """<button class="nav-link" onclick="show('users')">◈ Users</button>
    <button class="nav-link" onclick="show('audit')">◫ Audit Log</button>"""
    if old_nav in content:
        content = content.replace(old_nav, new_nav, 1)
        changes += 1
        print("   ✅ Audit Log nav link added")

# ── C) Replace the Users section completely ──
old_users_section = """<!-- ═══════════════════════ USERS ═══════════════════════ -->
<div class="section" id="s-users">
  <div class="page-header">
    <div class="page-title">Users</div>
    <button class="btn btn-gold" onclick="loadUsers()">↻ Refresh</button>
  </div>
  <div class="card">
    <div class="card-body" style="padding:0;overflow-x:auto">
      <table class="data-table" id="usersTable">
        <thead><tr><th>ID</th><th>Username</th><th>Level</th><th>Role</th><th>Player Credits</th><th>Reseller Credits</th><th>Set Role</th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
  </div>
</div>"""

new_users_section = """<!-- ═══════════════════════ USERS (ADVANCED) ═══════════════════════ -->
<div class="section" id="s-users">
  <div class="page-header">
    <div class="page-title">User Management</div>
    <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap">
      <input class="um-search" id="userSearch" placeholder="Search username or IP..." oninput="filterUsers()">
      <button class="btn btn-gold" onclick="loadUsers()">↻ Refresh</button>
    </div>
  </div>

  <div class="stats-grid" style="margin-bottom:1.25rem">
    <div class="stat-card"><div class="stat-num" id="um-total">—</div><div class="stat-label">Total Users</div></div>
    <div class="stat-card neon"><div class="stat-num" id="um-online">—</div><div class="stat-label">Online Now</div></div>
    <div class="stat-card amber"><div class="stat-num" id="um-suspended">—</div><div class="stat-label">Suspended</div></div>
    <div class="stat-card red"><div class="stat-num" id="um-banned">—</div><div class="stat-label">Banned</div></div>
  </div>

  <div class="card">
    <div class="card-body" style="padding:0;overflow-x:auto">
      <table class="data-table" id="usersTable">
        <thead><tr>
          <th>ID</th><th>Username</th><th>Status</th><th>Level</th><th>Role</th>
          <th>Credits</th><th>Last IP</th><th>Rounds</th><th>P/L</th><th>Actions</th>
        </tr></thead>
        <tbody></tbody>
      </table>
    </div>
  </div>
</div>

<!-- ═══════════════════════ AUDIT LOG ═══════════════════════ -->
<div class="section" id="s-audit">
  <div class="page-header">
    <div class="page-title">Audit Log</div>
    <button class="btn btn-gold" onclick="loadAuditLog()">↻ Refresh</button>
  </div>
  <div class="card">
    <div class="card-body" style="padding:0;overflow-x:auto">
      <table class="data-table" id="auditTable">
        <thead><tr><th>Time</th><th>Admin</th><th>Action</th><th>Target</th><th>Reason</th><th>Duration</th></tr></thead>
        <tbody><tr><td colspan="6" style="color:var(--muted);text-align:center;padding:1.5rem">Loading...</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<!-- User Detail Modal -->
<div class="um-modal-overlay" id="umModal" onclick="if(event.target===this)closeUserModal()">
  <div class="um-modal">
    <div class="um-modal-head">
      <div class="um-modal-title" id="umTitle">User Details</div>
      <button class="um-modal-close" onclick="closeUserModal()">&times;</button>
    </div>
    <div class="um-modal-body" id="umBody">Loading...</div>
  </div>
</div>"""

if old_users_section in content:
    content = content.replace(old_users_section, new_users_section, 1)
    changes += 1
    print("   ✅ Users section replaced with advanced version")
else:
    print("   ⚠️  Could not find exact Users section — try manual replacement")

# ── D) Add audit to the show() loaders map ──
old_loaders = """const loaders = {
    dashboard:loadDashboard, analytics:loadAnalytics, games:loadUnifiedGames,
    users:loadUsers, invites:loadInvites, spins:loadSpins, settings:loadSettings,
    bonuses:loadBonuses, broadcast:loadBroadcast
  };"""
new_loaders = """const loaders = {
    dashboard:loadDashboard, analytics:loadAnalytics, games:loadUnifiedGames,
    users:loadUsers, invites:loadInvites, spins:loadSpins, settings:loadSettings,
    bonuses:loadBonuses, broadcast:loadBroadcast, audit:loadAuditLog
  };"""
if old_loaders in content:
    content = content.replace(old_loaders, new_loaders, 1)
    changes += 1
    print("   ✅ Audit loader added to show()")

# ── E) Replace loadUsers function + add new functions ──
# Find and replace the loadUsers function
new_user_js = """
// ─── ADVANCED USER MANAGEMENT ────────────────────────────────
let allUsersData = [];

async function loadUsers() {
  try {
    const res = await fetch('/api/admin/users-advanced');
    if (!res.ok) { 
      // Fallback to original endpoint
      const r2 = await fetch('/api/admin/users');
      if (!r2.ok) return;
      const d = await r2.json();
      allUsersData = d.users || [];
      renderUsersBasic();
      return;
    }
    const data = await res.json();
    allUsersData = data.users || [];
    renderUsers();
  } catch(e) { console.error('Load users error:', e); }
}

function renderUsersBasic() {
  // Fallback if advanced endpoint not available
  const tbody = document.querySelector('#usersTable tbody');
  tbody.innerHTML = allUsersData.map(u => `<tr>
    <td>${u.id}</td><td><strong>${u.username}</strong></td>
    <td><span class="user-status offline">—</span></td>
    <td>${u.level||1} <span style="color:var(--muted);font-size:0.72rem">${u.title||''}</span></td>
    <td><span class="role-badge ${u.role}">${u.role}</span></td>
    <td>${fmt(u.credits||0)}</td><td>—</td><td>—</td><td>—</td>
    <td><button class="um-btn sm suspend" onclick="toast('Restart server to enable','var(--amber)')">Details</button></td>
  </tr>`).join('');
}

function renderUsers() {
  const search = (document.getElementById('userSearch')?.value || '').toLowerCase();
  const filtered = allUsersData.filter(u => {
    if (!search) return true;
    return u.username.toLowerCase().includes(search) || (u.last_ip||'').includes(search) || String(u.id).includes(search);
  });

  // Stats
  document.getElementById('um-total').textContent = allUsersData.length;
  document.getElementById('um-online').textContent = allUsersData.filter(u=>u.is_online).length;
  document.getElementById('um-suspended').textContent = allUsersData.filter(u=>u.effective_status==='suspended').length;
  document.getElementById('um-banned').textContent = allUsersData.filter(u=>u.effective_status==='banned').length;

  const tbody = document.querySelector('#usersTable tbody');
  tbody.innerHTML = filtered.map(u => {
    const st = u.effective_status || 'active';
    const statusClass = st === 'banned' ? 'banned' : st === 'suspended' ? 'suspended' : u.is_online ? 'online' : 'offline';
    const statusLabel = st === 'banned' ? 'Banned' : st === 'suspended' ? 'Suspended' : u.is_online ? 'Online' : 'Offline';
    const pl = (u.total_won||0) - (u.total_wagered||0);
    return `<tr>
      <td style="color:var(--muted);font-size:0.78rem">${u.id}</td>
      <td><strong style="cursor:pointer;color:var(--gold)" onclick="openUserModal(${u.id})">${u.username}</strong></td>
      <td><span class="user-status ${statusClass}">${statusLabel}</span></td>
      <td>${u.level||1} <span style="color:var(--muted);font-size:0.68rem">${u.title||''}</span></td>
      <td><span class="role-badge ${u.role}">${u.role}</span></td>
      <td>${fmt(u.credits||0)}</td>
      <td>${u.last_ip ? '<span class="um-ip" onclick="ipLookup(\\''+u.last_ip+'\\')" title="Click to look up">'+u.last_ip+'</span>' : '<span style="color:var(--muted)">—</span>'}</td>
      <td style="color:var(--muted)">${fmtN(u.total_rounds||0)}</td>
      <td style="color:${pl>=0?'var(--neon)':'var(--red)'};">${pl>=0?'+':''}${fmt(pl)}</td>
      <td>
        <button class="um-btn sm suspend" onclick="openUserModal(${u.id})" title="Manage user">⚙</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="10" style="color:var(--muted);text-align:center;padding:1.5rem">No users found</td></tr>';
}

function filterUsers() { renderUsers(); }

// ── User Detail Modal ──
async function openUserModal(userId) {
  document.getElementById('umModal').classList.add('show');
  document.getElementById('umBody').innerHTML = '<div style="text-align:center;color:var(--muted);padding:2rem">Loading...</div>';

  try {
    const res = await fetch('/api/admin/user/' + userId);
    if (!res.ok) throw new Error('Failed');
    const data = await res.json();
    const u = data.user;
    const st = u.account_status || 'active';

    document.getElementById('umTitle').textContent = u.username + ' — User #' + u.id;

    let html = '';

    // Status bar
    const statusClass = st==='banned'?'banned':st==='suspended'?'suspended':'online';
    html += '<div style="margin-bottom:1rem;display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap">';
    html += '<span class="user-status '+statusClass+'">'+st+'</span>';
    html += '<span class="role-badge '+u.role+'">'+u.role+'</span>';
    if (st==='suspended' && u.suspend_reason) html += '<span style="font-size:0.75rem;color:var(--amber)">Reason: '+u.suspend_reason+'</span>';
    if (st==='banned' && u.ban_reason) html += '<span style="font-size:0.75rem;color:var(--red)">Reason: '+u.ban_reason+'</span>';
    if (u.suspended_until) html += '<span style="font-size:0.68rem;color:var(--muted)">Until: '+new Date(u.suspended_until).toLocaleString()+'</span>';
    if (u.banned_until) html += '<span style="font-size:0.68rem;color:var(--muted)">Until: '+new Date(u.banned_until).toLocaleString()+'</span>';
    html += '</div>';

    // Stats grid
    const pl = (u.total_won||0) - (u.total_wagered||0);
    html += '<div class="um-detail-grid">';
    html += '<div class="um-detail-item"><div class="um-detail-val">'+fmt(u.credits||0)+'</div><div class="um-detail-lbl">Credits</div></div>';
    html += '<div class="um-detail-item"><div class="um-detail-val">'+(u.level||1)+' — '+(u.title||'Rookie')+'</div><div class="um-detail-lbl">Level</div></div>';
    html += '<div class="um-detail-item"><div class="um-detail-val">'+fmtN(u.total_rounds||0)+'</div><div class="um-detail-lbl">Total Rounds</div></div>';
    html += '<div class="um-detail-item"><div class="um-detail-val">'+fmt(u.total_wagered||0)+'</div><div class="um-detail-lbl">Total Wagered</div></div>';
    html += '<div class="um-detail-item"><div class="um-detail-val" style="color:'+(pl>=0?'var(--neon)':'var(--red)')+'">'+(pl>=0?'+':'')+fmt(pl)+'</div><div class="um-detail-lbl">Net P/L</div></div>';
    html += '<div class="um-detail-item"><div class="um-detail-val">'+(u.biggest_win?fmt(u.biggest_win):'—')+'</div><div class="um-detail-lbl">Biggest Win</div></div>';
    html += '<div class="um-detail-item"><div class="um-detail-val">'+(u.favorite_game||'—')+'</div><div class="um-detail-lbl">Favorite Game</div></div>';
    html += '<div class="um-detail-item"><div class="um-detail-val">'+(u.last_played?ago(u.last_played):'Never')+'</div><div class="um-detail-lbl">Last Played</div></div>';
    html += '</div>';

    // ── Actions ──
    html += '<div class="um-section"><div class="um-section-title">Actions</div>';
    html += '<div class="um-action-row">';
    if (st !== 'suspended' && st !== 'banned') {
      html += '<button class="um-btn suspend" onclick="promptSuspend('+u.id+')">⚠ Suspend</button>';
      html += '<button class="um-btn ban" onclick="promptBan('+u.id+')">✕ Ban</button>';
    } else {
      html += '<button class="um-btn unban" onclick="doUnban('+u.id+')">✓ Lift Restrictions</button>';
    }
    html += '<button class="um-btn pw" onclick="promptResetPassword('+u.id+')">🔗 Reset Link</button>';
    html += '<button class="um-btn pw" onclick="promptForcePassword('+u.id+')">🔑 Force Password</button>';
    html += '</div>';

    // Credit adjustment
    html += '<div style="display:flex;gap:0.4rem;align-items:center;margin-top:0.5rem;flex-wrap:wrap">';
    html += '<input type="number" id="umCreditAmt" placeholder="Amount ($)" style="width:100px;padding:0.3rem 0.5rem;background:var(--dark3);border:1px solid var(--border2);color:#fff;font-family:Rajdhani,sans-serif;font-size:0.85rem">';
    html += '<input type="text" id="umCreditReason" placeholder="Reason (optional)" style="flex:1;min-width:120px;padding:0.3rem 0.5rem;background:var(--dark3);border:1px solid var(--border2);color:#fff;font-family:Rajdhani,sans-serif;font-size:0.85rem">';
    html += '<button class="um-btn sm unban" onclick="doAdjustCredits('+u.id+',1)">+ Add</button>';
    html += '<button class="um-btn sm ban" onclick="doAdjustCredits('+u.id+',-1)">- Remove</button>';
    html += '</div>';

    // Role change
    html += '<div style="display:flex;gap:0.4rem;align-items:center;margin-top:0.6rem">';
    html += '<span style="font-size:0.65rem;letter-spacing:2px;text-transform:uppercase;color:var(--muted)">Set Role</span>';
    ['player','reseller','admin'].forEach(r => {
      const curr = r===u.role ? 'font-weight:900;' : '';
      html += '<button class="um-btn sm" style="border-color:rgba(255,215,0,0.3);color:var(--gold);'+curr+'" onclick="doSetRole('+u.id+',\\''+r+'\\')">'+r+'</button>';
    });
    html += '</div>';
    html += '</div>';

    // ── IP History ──
    if (data.ips && data.ips.length) {
      html += '<div class="um-section"><div class="um-section-title">IP History ('+data.ips.length+' addresses)</div>';
      html += '<div style="max-height:120px;overflow-y:auto">';
      data.ips.forEach(ip => {
        html += '<div style="display:flex;justify-content:space-between;padding:0.25rem 0;border-bottom:1px solid rgba(255,255,255,0.03)">';
        html += '<span class="um-ip" onclick="ipLookup(\\''+ip.ip+'\\')">'+ip.ip+'</span>';
        html += '<span style="font-size:0.7rem;color:var(--muted)">'+ip.times+'x · '+ago(ip.last_seen)+'</span>';
        html += '</div>';
      });
      html += '</div></div>';
    }

    // ── Admin Notes ──
    html += '<div class="um-section"><div class="um-section-title">Admin Notes</div>';
    html += '<textarea id="umNotes" style="width:100%;min-height:60px;padding:0.5rem;background:var(--dark3);border:1px solid var(--border2);color:#fff;font-family:Rajdhani,sans-serif;font-size:0.82rem;resize:vertical;outline:none">'+(u.admin_notes||'')+'</textarea>';
    html += '<button class="um-btn sm" style="border-color:var(--gold);color:var(--gold);margin-top:0.4rem" onclick="saveNotes('+u.id+')">Save Notes</button>';
    html += '</div>';

    // ── Action History ──
    if (data.actions && data.actions.length) {
      html += '<div class="um-section"><div class="um-section-title">Action History</div>';
      html += '<div class="um-action-log" style="max-height:150px;overflow-y:auto">';
      data.actions.forEach(a => {
        html += '<div class="action-item">';
        html += '<span class="action-type '+(a.action||'')+'">'+a.action+'</span>';
        html += '<span style="color:var(--muted);font-size:0.72rem">'+ago(a.created_at)+'</span>';
        if (a.reason) html += '<span style="font-size:0.75rem">'+a.reason+'</span>';
        if (a.duration_hours) html += '<span style="font-size:0.68rem;color:var(--muted)">'+a.duration_hours+'h</span>';
        html += '</div>';
      });
      html += '</div></div>';
    }

    document.getElementById('umBody').innerHTML = html;
  } catch(e) {
    document.getElementById('umBody').innerHTML = '<div style="color:var(--red);text-align:center;padding:2rem">Failed to load user details. Make sure you ran pm2 restart after patching.</div>';
  }
}

function closeUserModal() { document.getElementById('umModal').classList.remove('show'); }

// ── Suspend/Ban prompts ──
function promptSuspend(userId) {
  const reason = prompt('Suspend reason:');
  if (!reason) return;
  const dur = prompt('Duration in hours (0 or empty = indefinite):', '24');
  const hours = parseInt(dur) || 0;
  doAction('/api/admin/user/suspend', { userId, reason, duration: hours });
}

function promptBan(userId) {
  const reason = prompt('Ban reason:');
  if (!reason) return;
  const dur = prompt('Duration in hours (0 or empty = permanent):', '0');
  const hours = parseInt(dur) || 0;
  doAction('/api/admin/user/ban', { userId, reason, duration: hours });
}

function doUnban(userId) {
  if (!confirm('Lift all restrictions for this user?')) return;
  doAction('/api/admin/user/unban', { userId });
}

async function doAction(url, body) {
  const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  const d = await r.json();
  if (r.ok && d.success) {
    toast(d.message || 'Done ✓');
    loadUsers();
    if (body.userId) openUserModal(body.userId);
  } else {
    toast(d.error || 'Failed', 'var(--red)');
  }
}

async function doSetRole(userId, role) {
  const r = await fetch('/api/admin/set-role', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({userId, role}) });
  if (r.ok) { toast('Role updated ✓'); loadUsers(); openUserModal(userId); }
}

function promptResetPassword(userId) {
  doResetPassword(userId);
}

async function doResetPassword(userId) {
  const r = await fetch('/api/admin/user/reset-password', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({userId}) });
  const d = await r.json();
  if (r.ok && d.success) {
    const fullLink = window.location.origin + d.link;
    prompt('Copy this reset link and send to ' + d.username + ':', fullLink);
    toast('Reset link generated ✓');
  } else {
    toast(d.error || 'Failed', 'var(--red)');
  }
}

function promptForcePassword(userId) {
  const pw = prompt('Enter new password for this user (min 4 chars):');
  if (!pw || pw.length < 4) { if(pw) toast('Password too short','var(--red)'); return; }
  doAction('/api/admin/user/force-password', { userId, newPassword: pw });
}

async function doAdjustCredits(userId, direction) {
  const amtEl = document.getElementById('umCreditAmt');
  const reasonEl = document.getElementById('umCreditReason');
  const amount = parseFloat(amtEl.value) * direction;
  if (!amount || isNaN(amount)) { toast('Enter an amount','var(--amber)'); return; }
  const reason = reasonEl.value.trim();
  const r = await fetch('/api/admin/user/adjust-credits', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({userId, amount, reason}) });
  if (r.ok) { toast('Credits adjusted ✓'); amtEl.value=''; reasonEl.value=''; loadUsers(); openUserModal(userId); }
  else { toast('Failed','var(--red)'); }
}

async function saveNotes(userId) {
  const notes = document.getElementById('umNotes').value;
  const r = await fetch('/api/admin/user/notes', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({userId, notes}) });
  if (r.ok) toast('Notes saved ✓');
}

async function ipLookup(ip) {
  try {
    const r = await fetch('/api/admin/ip-lookup/' + encodeURIComponent(ip));
    const d = await r.json();
    let msg = 'IP: ' + ip + '\\n\\nUsers from this IP:\\n';
    (d.users||[]).forEach(u => {
      msg += '  #' + u.id + ' ' + u.username + ' (' + u.role + ') — ' + u.login_count + ' logins, status: ' + (u.account_status||'active') + '\\n';
    });
    alert(msg);
  } catch(e) { toast('Lookup failed','var(--red)'); }
}

// ── Audit Log ──
async function loadAuditLog() {
  try {
    const r = await fetch('/api/admin/user-actions');
    const d = await r.json();
    document.querySelector('#auditTable tbody').innerHTML = (d.actions||[]).map(a => {
      return '<tr>' +
        '<td style="color:var(--muted);font-size:0.72rem">' + ago(a.created_at) + '</td>' +
        '<td><strong>' + (a.admin_name||'System') + '</strong></td>' +
        '<td><span class="action-type ' + a.action + '">' + a.action + '</span></td>' +
        '<td><strong style="cursor:pointer;color:var(--gold)" onclick="openUserModal(' + a.target_user_id + ')">' + (a.target_name||'#'+a.target_user_id) + '</strong></td>' +
        '<td style="font-size:0.78rem;color:var(--muted);max-width:200px;overflow:hidden;text-overflow:ellipsis">' + (a.reason||'—') + '</td>' +
        '<td style="color:var(--muted);font-size:0.78rem">' + (a.duration_hours ? a.duration_hours+'h' : '—') + '</td>' +
      '</tr>';
    }).join('') || '<tr><td colspan="6" style="color:var(--muted);text-align:center;padding:1.5rem">No actions recorded yet</td></tr>';
  } catch(e) { console.error('Audit log error:', e); }
}
"""

# Find the old loadUsers function and inject our new code after the last function in the script
# We'll inject before the closing </script>
last_script = content.rfind('</script>')
if last_script > -1 and 'users-advanced' not in content:
    content = content[:last_script] + '\n' + new_user_js + '\n' + content[last_script:]
    changes += 1
    print("   ✅ Advanced user management JS injected")

    # Now remove or neuter the old loadUsers if it exists
    # We just added a new one that takes priority
    import re
    # Find old loadUsers
    old_load = re.search(r'async function loadUsers\(\)\s*\{[^}]*const res = await fetch\([\'\"]/api/admin/users[\'\"]', content)
    if old_load:
        # Find the end of this function
        start = old_load.start()
        brace_count = 0
        i = content.index('{', start)
        while i < len(content):
            if content[i] == '{': brace_count += 1
            elif content[i] == '}':
                brace_count -= 1
                if brace_count == 0:
                    # Replace old function with comment
                    content = content[:start] + '// Old loadUsers replaced by advanced version above\n' + content[i+1:]
                    changes += 1
                    print("   ✅ Old loadUsers() replaced")
                    break
            i += 1

if changes > 0:
    open(f, 'w').write(content)
    print(f"   ✅ admin.html: {changes} total changes")
else:
    print("   ℹ️  admin.html: No changes needed")
PYEOF

# ══════════════════════════════════════════════════
# 6. VERIFICATION
# ══════════════════════════════════════════════════
echo ""
echo "🔧 [6/6] Verifying..."
echo ""
echo "══════════════════════════════════════════════"
echo "  VERIFICATION"
echo "══════════════════════════════════════════════"
echo ""

[ -f routes/user-management.js ] && echo "✅ routes/user-management.js exists" || echo "⚠️  Missing route file"
[ -f public/pages/reset-password.html ] && echo "✅ Password reset page exists" || echo "⚠️  Missing reset page"

[ -f db.js ] && grep -q "ip_log" db.js && echo "✅ db.js: IP log table migration" || echo "⚠️  db.js: Missing migrations"
[ -f db.js ] && grep -q "user_actions" db.js && echo "✅ db.js: User actions table" || echo "⚠️  db.js: Missing user_actions"
[ -f db.js ] && grep -q "password_reset_tokens" db.js && echo "✅ db.js: Password reset tokens" || echo "⚠️  db.js: Missing reset tokens"
[ -f db.js ] && grep -q "account_status" db.js && echo "✅ db.js: Account status column" || echo "⚠️  db.js: Missing account_status"

[ -f server.js ] && grep -q "user-management" server.js && echo "✅ server.js: Route mounted" || echo "⚠️  server.js: Route not mounted — add manually"
[ -f server.js ] && grep -q "ip_log" server.js && echo "✅ server.js: IP logging middleware" || echo "⚠️  server.js: IP logging not added — add manually"
[ -f server.js ] && grep -q "account_status" server.js && echo "✅ server.js: Ban check middleware" || echo "⚠️  server.js: Ban check not added — add manually"
[ -f server.js ] && grep -q "reset-password" server.js && echo "✅ server.js: Reset password route" || echo "⚠️  server.js: Reset route not added — add manually"

[ -f public/pages/admin.html ] && grep -q "users-advanced" public/pages/admin.html && echo "✅ admin.html: Advanced users UI" || echo "⚠️  admin.html: UI not updated"
[ -f public/pages/admin.html ] && grep -q "auditTable" public/pages/admin.html && echo "✅ admin.html: Audit log section" || echo "⚠️  admin.html: Audit log missing"

echo ""
echo "══════════════════════════════════════════════"
echo "  ✅ ADVANCED USER MANAGEMENT INSTALLED"
echo "══════════════════════════════════════════════"
echo ""
echo "  Features added:"
echo ""
echo "  📋 Users Table — status, IP, rounds, P/L"
echo "  ⚠️  Suspend — with reason + duration (hours)"
echo "  ✕  Ban — with reason + duration (permanent ok)"
echo "  ✓  Lift Restrictions — unban/unsuspend"
echo "  🌐 IP Logging — auto-logs on every API call"
echo "  🔍 IP Lookup — find all accounts from an IP"
echo "  🟢 Online Status — live session detection"
echo "  🔗 Password Reset Link — generates /reset-password?token=..."
echo "  🔑 Force Password — admin sets password directly"
echo "  💰 Credit Adjust — add/remove with reason logging"
echo "  📝 Admin Notes — per-user notes"
echo "  📊 Audit Log — all admin actions tracked"
echo "  🚫 Ban Middleware — banned users blocked from API"
echo "  🔎 Search — filter users by name or IP"
echo ""
echo "  Next: pm2 restart slot-stars"
echo ""
