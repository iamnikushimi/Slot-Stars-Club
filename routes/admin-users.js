const express = require('express');
const router = express.Router();
const db = require('../db');
const crypto = require('crypto');

// ── Auth middleware (inline to avoid path issues) ──
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const user = db.prepare('SELECT role FROM users WHERE id=?').get(req.session.userId);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
  } catch(e) {
    return res.status(500).json({ error: 'Auth check failed' });
  }
}

// ── Ensure tables exist ──
try {
  db.exec(`
    ALTER TABLE users ADD COLUMN account_status TEXT DEFAULT 'active';
  `);
} catch(e) {} // already exists

try {
  db.exec(`
    ALTER TABLE users ADD COLUMN status_reason TEXT DEFAULT '';
  `);
} catch(e) {}

try {
  db.exec(`
    ALTER TABLE users ADD COLUMN status_until TEXT DEFAULT NULL;
  `);
} catch(e) {}

try {
  db.exec(`
    ALTER TABLE users ADD COLUMN admin_notes TEXT DEFAULT '';
  `);
} catch(e) {}

try {
  db.exec(`
    ALTER TABLE users ADD COLUMN last_ip TEXT DEFAULT '';
  `);
} catch(e) {}

try {
  db.exec(`
    ALTER TABLE users ADD COLUMN login_count INTEGER DEFAULT 0;
  `);
} catch(e) {}

try {
  db.exec(`
    ALTER TABLE users ADD COLUMN last_login TEXT DEFAULT NULL;
  `);
} catch(e) {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER,
      admin_name TEXT,
      target_user_id INTEGER,
      target_name TEXT,
      action TEXT,
      reason TEXT,
      duration_hours INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
} catch(e) {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ip_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      ip TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
} catch(e) {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      token TEXT UNIQUE,
      expires_at TEXT,
      used INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
} catch(e) {}

// Helper: log admin action
function logAction(adminId, adminName, targetId, targetName, action, reason, durationHours) {
  try {
    db.prepare(`INSERT INTO user_actions (admin_user_id, admin_name, target_user_id, target_name, action, reason, duration_hours) VALUES (?,?,?,?,?,?,?)`)
      .run(adminId, adminName, targetId, targetName, action, reason || null, durationHours || null);
  } catch(e) { console.error('Log action error:', e.message); }
}

// Helper: get admin name
function getAdminName(req) {
  try {
    const admin = db.prepare('SELECT username FROM users WHERE id=?').get(req.session.userId);
    return admin ? admin.username : 'Unknown';
  } catch(e) { return 'Unknown'; }
}

// ══════════════════════════════════════════════════════════════
// GET /api/admin/users-advanced
// ══════════════════════════════════════════════════════════════
router.get('/users-advanced', requireAdmin, (req, res) => {
  try {
    const users = db.prepare(`
      SELECT u.id, u.username, u.role, u.credits, u.xp, u.level, u.title,
             u.account_status, u.status_reason, u.status_until,
             u.last_ip, u.login_count, u.last_login, u.admin_notes,
             COALESCE(s.total_wagered, 0) as total_wagered,
             COALESCE(s.total_won, 0) as total_won,
             COALESCE(s.total_rounds, 0) as total_rounds,
             COALESCE(s.biggest_win, 0) as biggest_win
      FROM users u
      LEFT JOIN (
        SELECT user_id,
               SUM(bet) as total_wagered,
               SUM(payout) as total_won,
               COUNT(*) as total_rounds,
               MAX(payout) as biggest_win
        FROM spins GROUP BY user_id
      ) s ON s.user_id = u.id
      ORDER BY u.id DESC
    `).all();

    // Check active sessions for online status
    let activeSessions = [];
    try {
      activeSessions = db.prepare(`SELECT DISTINCT user_id FROM active_sessions WHERE last_seen > datetime('now','-2 minutes')`).all();
    } catch(e) {}
    const onlineIds = new Set(activeSessions.map(s => s.user_id));

    users.forEach(u => {
      u.credits = u.credits / 100; // cents to dollars
      u.total_wagered = (u.total_wagered || 0) / 100;
      u.total_won = (u.total_won || 0) / 100;
      u.biggest_win = (u.biggest_win || 0) / 100;
      u.is_online = onlineIds.has(u.id);

      // Check if suspension/ban has expired
      if (u.status_until && new Date(u.status_until) < new Date()) {
        u.effective_status = 'active';
      } else {
        u.effective_status = u.account_status || 'active';
      }
    });

    res.json({ users });
  } catch(e) {
    console.error('Users-advanced error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/admin/user/:id — detailed single user
// ══════════════════════════════════════════════════════════════
router.get('/user/:id', requireAdmin, (req, res) => {
  try {
    const user = db.prepare(`
      SELECT u.*,
             COALESCE(s.total_wagered, 0) as total_wagered,
             COALESCE(s.total_won, 0) as total_won,
             COALESCE(s.total_rounds, 0) as total_rounds,
             COALESCE(s.biggest_win, 0) as biggest_win
      FROM users u
      LEFT JOIN (
        SELECT user_id, SUM(bet) as total_wagered, SUM(payout) as total_won,
               COUNT(*) as total_rounds, MAX(payout) as biggest_win
        FROM spins GROUP BY user_id
      ) s ON s.user_id = u.id
      WHERE u.id = ?
    `).get(req.params.id);

    if (!user) return res.status(404).json({ error: 'User not found' });

    user.credits = user.credits / 100;
    user.total_wagered = (user.total_wagered || 0) / 100;
    user.total_won = (user.total_won || 0) / 100;
    user.biggest_win = (user.biggest_win || 0) / 100;

    // Recent spins
    const recentSpins = db.prepare(`SELECT game, bet/100.0 as bet, payout/100.0 as payout, created_at FROM spins WHERE user_id=? ORDER BY id DESC LIMIT 20`).all(req.params.id);

    // IP history
    let ipHistory = [];
    try { ipHistory = db.prepare(`SELECT ip, created_at FROM ip_log WHERE user_id=? ORDER BY id DESC LIMIT 20`).all(req.params.id); } catch(e) {}

    // Actions on this user
    let actions = [];
    try { actions = db.prepare(`SELECT * FROM user_actions WHERE target_user_id=? ORDER BY id DESC LIMIT 20`).all(req.params.id); } catch(e) {}

    // Effective status
    if (user.status_until && new Date(user.status_until) < new Date()) {
      user.effective_status = 'active';
    } else {
      user.effective_status = user.account_status || 'active';
    }

    res.json({ user, recentSpins, ipHistory, actions });
  } catch(e) {
    console.error('User detail error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/admin/user/suspend
// ══════════════════════════════════════════════════════════════
router.post('/user/suspend', requireAdmin, (req, res) => {
  const { userId, reason, duration } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  const until = duration > 0
    ? new Date(Date.now() + duration * 3600000).toISOString()
    : null;

  db.prepare('UPDATE users SET account_status=?, status_reason=?, status_until=? WHERE id=?')
    .run('suspended', reason || '', until, userId);

  const target = db.prepare('SELECT username FROM users WHERE id=?').get(userId);
  logAction(req.session.userId, getAdminName(req), userId, target?.username, 'suspend', reason, duration || null);

  res.json({ success: true, message: `User suspended${duration ? ' for ' + duration + 'h' : ' indefinitely'}` });
});

// ══════════════════════════════════════════════════════════════
// POST /api/admin/user/ban
// ══════════════════════════════════════════════════════════════
router.post('/user/ban', requireAdmin, (req, res) => {
  const { userId, reason, duration } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  const until = duration > 0
    ? new Date(Date.now() + duration * 3600000).toISOString()
    : null;

  db.prepare('UPDATE users SET account_status=?, status_reason=?, status_until=? WHERE id=?')
    .run('banned', reason || '', until, userId);

  const target = db.prepare('SELECT username FROM users WHERE id=?').get(userId);
  logAction(req.session.userId, getAdminName(req), userId, target?.username, 'ban', reason, duration || null);

  res.json({ success: true, message: `User banned${duration ? ' for ' + duration + 'h' : ' permanently'}` });
});

// ══════════════════════════════════════════════════════════════
// POST /api/admin/user/unban
// ══════════════════════════════════════════════════════════════
router.post('/user/unban', requireAdmin, (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  db.prepare('UPDATE users SET account_status=?, status_reason=?, status_until=? WHERE id=?')
    .run('active', '', null, userId);

  const target = db.prepare('SELECT username FROM users WHERE id=?').get(userId);
  logAction(req.session.userId, getAdminName(req), userId, target?.username, 'unban', null, null);

  res.json({ success: true, message: 'Restrictions lifted' });
});

// ══════════════════════════════════════════════════════════════
// POST /api/admin/user/adjust-credits
// ══════════════════════════════════════════════════════════════
router.post('/user/adjust-credits', requireAdmin, (req, res) => {
  const { userId, amount, reason } = req.body;
  if (!userId || !amount) return res.status(400).json({ error: 'Missing userId or amount' });

  const cents = Math.round(parseFloat(amount) * 100);
  db.prepare('UPDATE users SET credits = credits + ? WHERE id=?').run(cents, userId);

  const target = db.prepare('SELECT username FROM users WHERE id=?').get(userId);
  const action = cents > 0 ? 'credit_add' : 'credit_remove';
  logAction(req.session.userId, getAdminName(req), userId, target?.username, action, reason || `${amount > 0 ? '+' : ''}${amount}`, null);

  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════
// POST /api/admin/user/notes
// ══════════════════════════════════════════════════════════════
router.post('/user/notes', requireAdmin, (req, res) => {
  const { userId, notes } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  db.prepare('UPDATE users SET admin_notes=? WHERE id=?').run(notes || '', userId);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════
// POST /api/admin/user/reset-password
// ══════════════════════════════════════════════════════════════
router.post('/user/reset-password', requireAdmin, (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 24 * 3600000).toISOString();

  db.prepare('INSERT INTO password_resets (user_id, token, expires_at) VALUES (?,?,?)').run(userId, token, expires);

  const target = db.prepare('SELECT username FROM users WHERE id=?').get(userId);
  logAction(req.session.userId, getAdminName(req), userId, target?.username, 'reset_password', null, null);

  res.json({ success: true, link: '/reset-password?token=' + token, username: target?.username });
});

// ══════════════════════════════════════════════════════════════
// POST /api/admin/user/force-password
// ══════════════════════════════════════════════════════════════
router.post('/user/force-password', requireAdmin, (req, res) => {
  const { userId, newPassword } = req.body;
  if (!userId || !newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Invalid password' });

  // Hash password same way as auth route
  const hash = require('bcryptjs').hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password=? WHERE id=?').run(hash, userId);

  const target = db.prepare('SELECT username FROM users WHERE id=?').get(userId);
  logAction(req.session.userId, getAdminName(req), userId, target?.username, 'force_password', null, null);

  res.json({ success: true, message: 'Password updated' });
});

// ══════════════════════════════════════════════════════════════
// GET /api/admin/ip-lookup/:ip
// ══════════════════════════════════════════════════════════════
router.get('/ip-lookup/:ip', requireAdmin, (req, res) => {
  try {
    const users = db.prepare(`SELECT DISTINCT u.id, u.username, u.role, u.login_count, u.account_status FROM ip_log i JOIN users u ON i.user_id = u.id WHERE i.ip = ?`).all(req.params.ip);
    res.json({ users });
  } catch(e) {
    res.json({ users: [] });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/admin/user-actions — audit log
// ══════════════════════════════════════════════════════════════
router.get('/user-actions', requireAdmin, (req, res) => {
  try {
    const actions = db.prepare('SELECT * FROM user_actions ORDER BY id DESC LIMIT 100').all();
    res.json({ actions });
  } catch(e) {
    res.json({ actions: [] });
  }
});

module.exports = router;
