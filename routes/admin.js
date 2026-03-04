const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

router.post('/invite', requireRole('admin'), (req, res) => {
  const { credits=1000, count=1 } = req.body;
  const codes = [];
  for (let i=0; i<Math.min(count,50); i++) {
    const code = uuidv4().slice(0,8).toUpperCase();
    db.prepare('INSERT INTO invites (code,credits,created_by) VALUES (?,?,?)').run(code,credits,req.session.userId);
    codes.push(code);
  }
  res.json({ codes });
});

router.get('/users', requireRole('admin'), (req, res) => {
  const users = db.prepare('SELECT id,username,role,credits,reseller_credits,xp,level,title FROM users ORDER BY id DESC').all();
  res.json({ users });
});

router.post('/update-credits', requireRole('admin'), (req, res) => {
  const { userId, credits } = req.body;
  db.prepare('UPDATE users SET credits=? WHERE id=?').run(Math.round(parseFloat(credits)*100), userId);
  res.json({ success: true });
});


router.post('/update-reseller-credits', requireRole('admin'), (req, res) => {
  const { userId, resellerCredits } = req.body;
  const val = Math.round(parseFloat(resellerCredits) * 100);
  if (isNaN(val) || val < 0) return res.status(400).json({ error: 'Invalid amount' });
  db.prepare('UPDATE users SET reseller_credits=? WHERE id=?').run(val, userId);
  res.json({ success: true });
});

router.post('/set-role', requireRole('admin'), (req, res) => {
  const { userId, role } = req.body;
  if (!['player','reseller','admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  db.prepare('UPDATE users SET role=? WHERE id=?').run(role, userId);
  res.json({ success: true });
});

router.get('/stats', requireRole('admin'), (req, res) => {
  const totalSpins  = db.prepare('SELECT COUNT(*) as count FROM spins').get();
  const totalUsers  = db.prepare('SELECT COUNT(*) as count FROM users').get();
  const wagered     = db.prepare('SELECT SUM(bet) as total FROM spins').get();
  const paidOut     = db.prepare('SELECT SUM(payout) as total FROM spins').get();
  const byGame      = db.prepare('SELECT game,COUNT(*) as count,SUM(bet) as wagered,SUM(payout) as paid FROM spins GROUP BY game').all();
  const recentSpins = db.prepare('SELECT s.*,u.username FROM spins s JOIN users u ON s.user_id=u.id ORDER BY s.id DESC LIMIT 30').all();
  res.json({ totalSpins:totalSpins.count, totalUsers:totalUsers.count, totalCreditsWagered:wagered.total||0, totalPaidOut:paidOut.total||0, byGame, recentSpins });
});

router.get('/invites', requireRole('admin'), (req, res) => {
  const invites = db.prepare('SELECT * FROM invites ORDER BY rowid DESC LIMIT 50').all();
  res.json({ invites });
});

router.get('/settings', requireRole('admin'), (req, res) => {
  const rows = db.prepare('SELECT key,value FROM settings').all();
  const settings = {};
  for (const r of rows) settings[r.key] = r.value;
  res.json({ settings });
});

router.post('/settings', requireRole('admin'), (req, res) => {
  const allowed = [
    'rtp_slots','rtp_slots_pro','rtp_jackpot','rtp_crash',
    'rtp_blackjack','rtp_roulette','rtp_poker','rtp_pulltab',
    'rtp_fortune','rtp_nebula','rtp_ocean',
    'min_bet','max_bet','crash_max_mult',
    'jackpot_mini_seed','jackpot_major_seed','jackpot_grand_seed'
  ];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      const val = parseFloat(req.body[key]);
      if (isNaN(val)) continue;
      if (key.startsWith('rtp_') && (val<50||val>99)) continue;
      db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(key, val.toString());
    }
  }
  res.json({ success: true });
});

module.exports = router;
// This line intentionally left blank

// ─── Game Management ─────────────────────────────────────────────────────────
router.get('/games', requireRole('admin'), (req, res) => {
  const games = db.prepare(`
    SELECT g.*,
      (SELECT COUNT(*) FROM spins WHERE game=g.id) as total_rounds,
      (SELECT COUNT(*) FROM page_views WHERE game_id=g.id) as total_visits,
      (SELECT SUM(bet) FROM spins WHERE game=g.id) as total_wagered,
      (SELECT SUM(payout) FROM spins WHERE game=g.id) as total_paid,
      (SELECT MAX(payout) FROM spins WHERE game=g.id) as biggest_win,
      (SELECT u.username FROM spins s JOIN users u ON s.user_id=u.id WHERE s.game=g.id ORDER BY s.payout DESC LIMIT 1) as top_winner
    FROM games g ORDER BY sort_order
  `).all();
  res.json({ games });
});

// Public endpoint for lobby to get game metadata (descriptions, tags)
router.get('/games/lobby-data', (req, res) => {
  try {
    const games = db.prepare('SELECT id, name, icon, description, tags, status, route, category, rtp_key FROM games WHERE status != ? ORDER BY sort_order').all('disabled');
    res.json({ games });
  } catch(e) {
    try {
      const games = db.prepare('SELECT id, name, icon, status, route, category, rtp_key FROM games WHERE status != ? ORDER BY sort_order').all('disabled');
      games.forEach(g => { g.description = ''; g.tags = ''; });
      res.json({ games });
    } catch(e2) {
      res.json({ games: [] });
    }
  }
});

router.post('/games/status', requireRole('admin'), (req, res) => {
  const { gameId, status } = req.body;
  if (!['active','disabled','maintenance'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare('UPDATE games SET status=? WHERE id=?').run(status, gameId);
  res.json({ success: true });
});

// Update game description and tags from admin
router.post('/games/update', requireRole('admin'), (req, res) => {
  const { gameId, name, description, tags, icon } = req.body;
  if (!gameId) return res.status(400).json({ error: 'Missing gameId' });
  try {
    if (name !== undefined) db.prepare('UPDATE games SET name=? WHERE id=?').run(name, gameId);
    if (description !== undefined) db.prepare('UPDATE games SET description=? WHERE id=?').run(description, gameId);
    if (tags !== undefined) db.prepare('UPDATE games SET tags=? WHERE id=?').run(tags, gameId);
    if (icon !== undefined) db.prepare('UPDATE games SET icon=? WHERE id=?').run(icon, gameId);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: 'Update failed — columns may not exist. Restart server with new db.js.' });
  }
});

router.post('/games/reorder', requireRole('admin'), (req, res) => {
  const { order } = req.body; // array of {id, sort_order}
  const stmt = db.prepare('UPDATE games SET sort_order=? WHERE id=?');
  for (const item of order) stmt.run(item.sort_order, item.id);
  res.json({ success: true });
});

// ─── Enhanced Stats ───────────────────────────────────────────────────────────
router.get('/analytics', requireRole('admin'), (req, res) => {
  try {
  // Total stats
  const totalSpins   = db.prepare('SELECT COUNT(*) as c FROM spins').get().c;
  const totalUsers   = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const totalWagered = db.prepare('SELECT COALESCE(SUM(bet),0) as t FROM spins').get().t;
  const totalPaid    = db.prepare('SELECT COALESCE(SUM(payout),0) as t FROM spins').get().t;
  const totalVisits  = db.prepare('SELECT COUNT(*) as c FROM page_views').get().c;

  // Clean stale sessions first
  db.prepare(`DELETE FROM active_sessions WHERE last_seen < datetime('now','-10 minutes')`).run();

  // Live users (active in last 2 minutes — tighter window for accuracy)
  const liveUsers = db.prepare(`SELECT COUNT(DISTINCT user_id) as c FROM active_sessions WHERE last_seen > datetime('now','-2 minutes')`).get().c;

  // Live users per game
  const liveByGame = db.prepare(`
    SELECT game_id, COUNT(DISTINCT user_id) as count FROM active_sessions
    WHERE last_seen > datetime('now','-2 minutes')
    GROUP BY game_id
  `).all();

  // Peak hour (most spins in any 1-hour window by hour of day)
  const peakHour = db.prepare(`
    SELECT strftime('%H', created_at) as hour24, COUNT(*) as count
    FROM spins GROUP BY hour24 ORDER BY count DESC LIMIT 1
  `).get();
  // Convert to 12-hour format
  let peakHourFormatted = null;
  if (peakHour) {
    const h = parseInt(peakHour.hour24);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    peakHourFormatted = { hour: h12 + ':00 ' + ampm, count: peakHour.count };
  }

  // Today's stats
  const todaySpins   = db.prepare(`SELECT COUNT(*) as c FROM spins WHERE date(created_at)=date('now')`).get().c;
  const todayRevenue = db.prepare(`SELECT COALESCE(SUM(bet-payout),0) as t FROM spins WHERE date(created_at)=date('now')`).get().t;
  const todayNew     = db.prepare(`SELECT COUNT(*) as c FROM users WHERE date(rowid)=date('now')`).get().c;

  // Highest single win ever
  const biggestWin = db.prepare(`
    SELECT s.payout, s.game, s.bet, u.username, s.created_at
    FROM spins s JOIN users u ON s.user_id=u.id
    ORDER BY s.payout DESC LIMIT 1
  `).get();

  // Top 5 winners all time
  const topWinners = db.prepare(`
    SELECT u.username, MAX(s.payout) as best_win, SUM(s.payout) as total_won, COUNT(*) as rounds, s.game
    FROM spins s JOIN users u ON s.user_id=u.id
    GROUP BY s.user_id ORDER BY best_win DESC LIMIT 5
  `).all();

  // Jackpot winners
  const jackpotWinners = db.prepare(`
    SELECT * FROM jackpot_winners ORDER BY created_at DESC LIMIT 10
  `).all();

  // Hourly activity (last 24h)
  const hourlyActivity = db.prepare(`
    SELECT strftime('%H', created_at) as hour, COUNT(*) as spins, COALESCE(SUM(bet-payout),0) as revenue
    FROM spins WHERE created_at > datetime('now','-24 hours')
    GROUP BY hour ORDER BY hour
  `).all();

  // Per-game stats
  const gameStats = db.prepare(`
    SELECT s.game, COUNT(*) as rounds, COALESCE(SUM(bet),0) as wagered,
      COALESCE(SUM(payout),0) as paid, MAX(payout) as biggest_win,
      (SELECT u.username FROM spins s2 JOIN users u ON s2.user_id=u.id WHERE s2.game=s.game ORDER BY s2.payout DESC LIMIT 1) as top_winner
    FROM spins s GROUP BY s.game ORDER BY rounds DESC
  `).all();

  // Visits per game
  const visitsByGame = db.prepare(`
    SELECT game_id, COUNT(*) as visits FROM page_views GROUP BY game_id
  `).all();

  // Recent jackpot winners
  const recentJP = jackpotWinners;

  res.json({
    totalSpins, totalUsers, totalWagered, totalPaid, totalVisits,
    liveUsers, liveByGame, peakHour: peakHourFormatted, todaySpins, todayRevenue, todayNew,
    biggestWin, topWinners, jackpotWinners: recentJP,
    hourlyActivity, gameStats, visitsByGame
  });
  } catch(e) {
    console.error('Analytics error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Track page view
router.post('/track-visit', (req, res) => {
  const { gameId } = req.body;
  const userId = req.session.userId || null;
  try { db.prepare('INSERT INTO page_views (game_id, user_id) VALUES (?,?)').run(gameId, userId); } catch(e) {}
  // Also register as active session
  if (userId) {
    try { db.prepare('INSERT OR REPLACE INTO active_sessions (user_id, game_id, last_seen) VALUES (?,?,CURRENT_TIMESTAMP)').run(userId, gameId||'lobby'); } catch(e) {}
  }
  res.json({ ok: true });
});

// Heartbeat — keep active session alive
router.post('/heartbeat', (req, res) => {
  if (!req.session.userId) return res.json({ ok: false });
  const { gameId } = req.body;
  try { db.prepare('INSERT OR REPLACE INTO active_sessions (user_id, game_id, last_seen) VALUES (?,?,CURRENT_TIMESTAMP)').run(req.session.userId, gameId||'lobby'); } catch(e) {}
  res.json({ ok: true });
});

// Record jackpot win
router.post('/jackpot-win', requireRole('admin'), (req, res) => {
  const { userId, username, game, jackpotType, amount } = req.body;
  db.prepare('INSERT INTO jackpot_winners (user_id,username,game,jackpot_type,amount) VALUES (?,?,?,?,?)').run(userId,username,game,jackpotType,amount);
  res.json({ ok: true });
});
