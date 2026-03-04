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
