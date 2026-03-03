const express = require('express');
const router = express.Router();
const db = require('../db');

// ── WEEKLY LEADERBOARDS ─────────────────────────────────────
// "This week" = since last Monday 00:00 UTC

function weekStart() {
  const now = new Date();
  const day = now.getUTCDay();
  const diff = day === 0 ? 6 : day - 1; // Monday=0
  const mon = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diff));
  return mon.toISOString().split('T')[0] + ' 00:00:00';
}

// GET /api/game/leaderboard
router.get('/leaderboard', (req, res) => {
  try {
    const ws = weekStart();

    // Weekly: Biggest single win
    const weeklyBigWins = db.prepare(`
      SELECT s.user_id, u.username, u.level, u.title, 
             MAX(s.payout) as best_win, s.game,
             COUNT(*) as rounds, SUM(s.bet) as wagered
      FROM spins s JOIN users u ON s.user_id = u.id
      WHERE s.created_at >= ? AND s.payout > 0
      GROUP BY s.user_id
      ORDER BY best_win DESC LIMIT 20
    `).all(ws);

    // Weekly: Most wagered (volume players)
    const weeklyWagered = db.prepare(`
      SELECT s.user_id, u.username, u.level, u.title,
             SUM(s.bet) as total_wagered, COUNT(*) as rounds,
             MAX(s.payout) as best_win
      FROM spins s JOIN users u ON s.user_id = u.id
      WHERE s.created_at >= ?
      GROUP BY s.user_id
      ORDER BY total_wagered DESC LIMIT 20
    `).all(ws);

    // Weekly: Most won (net profit)
    const weeklyProfit = db.prepare(`
      SELECT s.user_id, u.username, u.level, u.title,
             SUM(s.payout) - SUM(s.bet) as net_profit,
             SUM(s.payout) as total_won, COUNT(*) as rounds
      FROM spins s JOIN users u ON s.user_id = u.id
      WHERE s.created_at >= ?
      GROUP BY s.user_id
      HAVING net_profit > 0
      ORDER BY net_profit DESC LIMIT 20
    `).all(ws);

    // All-time: Highest level
    const topLevels = db.prepare(`
      SELECT id as user_id, username, level, title, xp
      FROM users WHERE role = 'player' OR role = 'admin'
      ORDER BY xp DESC LIMIT 20
    `).all();

    // All-time: Biggest single win ever
    const allTimeBigWins = db.prepare(`
      SELECT s.user_id, u.username, u.level, u.title,
             s.payout as best_win, s.game, s.bet, s.created_at
      FROM spins s JOIN users u ON s.user_id = u.id
      WHERE s.payout > 0
      ORDER BY s.payout DESC LIMIT 10
    `).all();

    // Current user rank (if logged in)
    let myRanks = null;
    if (req.session.userId) {
      const uid = req.session.userId;

      const myBigWin = db.prepare(`
        SELECT MAX(payout) as best_win FROM spins 
        WHERE user_id = ? AND created_at >= ? AND payout > 0
      `).get(uid, ws);

      const myWagered = db.prepare(`
        SELECT SUM(bet) as total_wagered, COUNT(*) as rounds FROM spins
        WHERE user_id = ? AND created_at >= ?
      `).get(uid, ws);

      const myProfit = db.prepare(`
        SELECT SUM(payout) - SUM(bet) as net_profit FROM spins
        WHERE user_id = ? AND created_at >= ?
      `).get(uid, ws);

      const myLevel = db.prepare('SELECT level, xp, title FROM users WHERE id = ?').get(uid);

      myRanks = {
        bigWin: myBigWin?.best_win || 0,
        wagered: myWagered?.total_wagered || 0,
        rounds: myWagered?.rounds || 0,
        profit: myProfit?.net_profit || 0,
        level: myLevel?.level || 1,
        xp: myLevel?.xp || 0,
        title: myLevel?.title || 'Rookie'
      };
    }

    // Week resets info
    const now = new Date();
    const day = now.getUTCDay();
    const daysUntilMonday = day === 0 ? 1 : day === 1 ? 7 : 8 - day;
    const nextMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilMonday));

    res.json({
      weekStart: ws,
      weekResets: nextMonday.toISOString(),
      weekly: {
        bigWins: weeklyBigWins,
        wagered: weeklyWagered,
        profit: weeklyProfit,
      },
      allTime: {
        levels: topLevels,
        bigWins: allTimeBigWins,
      },
      me: myRanks,
    });
  } catch(e) {
    console.error('Leaderboard error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
