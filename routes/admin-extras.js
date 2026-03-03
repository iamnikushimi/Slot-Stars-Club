const express = require('express');
const router = express.Router();
const db = require('../db');

function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.session.userId);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Not admin' });
  next();
}

router.use(requireAdmin);

// Create broadcast table
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS broadcasts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message TEXT NOT NULL,
      style TEXT DEFAULT 'gold',
      expires DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
} catch(e) { console.error('Broadcast table error:', e); }

// Daily Bonus Stats
router.get('/daily-bonus-stats', (req, res) => {
  try {
    const totalClaims = db.prepare('SELECT COUNT(*) as c FROM daily_bonus').get().c;
    const todayClaims = db.prepare("SELECT COUNT(*) as c FROM daily_bonus WHERE date(claimed_at) = date('now')").get().c;
    const totalCreditsGiven = db.prepare('SELECT COALESCE(SUM(prize_amount),0) as s FROM daily_bonus').get().s;
    const avgStreak = db.prepare('SELECT AVG(day_streak) as a FROM daily_bonus').get().a;
    const recentClaims = db.prepare(`
      SELECT d.*, u.username FROM daily_bonus d 
      JOIN users u ON d.user_id = u.id 
      ORDER BY d.claimed_at DESC LIMIT 50
    `).all();
    res.json({ totalClaims, todayClaims, totalCreditsGiven, avgStreak: avgStreak || 0, recentClaims });
  } catch (e) {
    console.error('Bonus stats error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET active broadcast
router.get('/broadcast', (req, res) => {
  try {
    const broadcast = db.prepare("SELECT * FROM broadcasts WHERE expires > datetime('now') ORDER BY created_at DESC LIMIT 1").get();
    res.json({ broadcast: broadcast || null });
  } catch (e) {
    res.json({ broadcast: null });
  }
});

// POST new broadcast
router.post('/broadcast', (req, res) => {
  try {
    const { message, style, hours } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });
    const h = parseInt(hours) || 24;
    db.prepare("INSERT INTO broadcasts (message, style, expires) VALUES (?, ?, datetime('now', '+' || ? || ' hours'))").run(message, style || 'gold', h);
    res.json({ success: true });
  } catch (e) {
    console.error('Broadcast error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE clear broadcast
router.delete('/broadcast', (req, res) => {
  try {
    db.prepare("DELETE FROM broadcasts WHERE expires > datetime('now')").run();
    res.json({ success: true });
  } catch (e) {
    console.error('Clear broadcast error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Public broadcast endpoint (no admin auth needed)
function publicBroadcast(req, res) {
  try {
    const broadcast = db.prepare("SELECT message, style, expires FROM broadcasts WHERE expires > datetime('now') ORDER BY created_at DESC LIMIT 1").get();
    res.json({ broadcast: broadcast || null });
  } catch (e) {
    res.json({ broadcast: null });
  }
}

module.exports = router;
module.exports.publicBroadcast = publicBroadcast;
