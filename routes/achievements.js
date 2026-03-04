const express = require('express');
const router = express.Router();
const db = require('../db');

// ── Ensure tables ──
try { db.exec(`
  CREATE TABLE IF NOT EXISTS achievements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    achievement_id TEXT NOT NULL,
    unlocked_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, achievement_id)
  );
`); } catch(e) {}

try { db.exec(`
  CREATE TABLE IF NOT EXISTS live_feed (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT,
    event_type TEXT NOT NULL,
    game TEXT,
    amount REAL DEFAULT 0,
    detail TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
`); } catch(e) {}

// ── Achievement definitions ──
const ACHIEVEMENTS = [
  // Getting Started
  { id: 'first_spin',      name: 'First Spin',        desc: 'Play your first game',           icon: '🎰', xp: 25,  category: 'beginner' },
  { id: 'first_win',       name: 'Lucky Start',       desc: 'Win for the first time',         icon: '🍀', xp: 50,  category: 'beginner' },
  { id: 'daily_collector',  name: 'Daily Collector',   desc: 'Claim your first daily bonus',   icon: '📅', xp: 25,  category: 'beginner' },
  { id: 'referral_first',  name: 'Social Butterfly',  desc: 'Refer your first friend',        icon: '🦋', xp: 100, category: 'social' },

  // Volume
  { id: 'spins_100',       name: 'Centurion',         desc: 'Play 100 rounds',                icon: '⚔️', xp: 100, category: 'volume' },
  { id: 'spins_500',       name: 'Veteran',           desc: 'Play 500 rounds',                icon: '🎖️', xp: 250, category: 'volume' },
  { id: 'spins_1000',      name: 'Grinder',           desc: 'Play 1,000 rounds',              icon: '💪', xp: 500, category: 'volume' },
  { id: 'spins_5000',      name: 'Machine',           desc: 'Play 5,000 rounds',              icon: '🤖', xp: 1000,category: 'volume' },

  // Wins
  { id: 'win_5x',          name: 'Nice Hit',          desc: 'Win 5× your bet',                icon: '🎯', xp: 50,  category: 'wins' },
  { id: 'win_10x',         name: 'Big Winner',        desc: 'Win 10× your bet',               icon: '💰', xp: 100, category: 'wins' },
  { id: 'win_50x',         name: 'Massive Payout',    desc: 'Win 50× your bet',               icon: '💎', xp: 250, category: 'wins' },
  { id: 'win_100x',        name: 'Legendary Win',     desc: 'Win 100× your bet',              icon: '👑', xp: 500, category: 'wins' },
  { id: 'win_streak_3',    name: 'Hot Streak',        desc: 'Win 3 rounds in a row',          icon: '🔥', xp: 75,  category: 'wins' },
  { id: 'win_streak_5',    name: 'On Fire',           desc: 'Win 5 rounds in a row',          icon: '🔥', xp: 150, category: 'wins' },
  { id: 'win_streak_10',   name: 'Unstoppable',       desc: 'Win 10 rounds in a row',         icon: '☄️', xp: 500, category: 'wins' },

  // Jackpots
  { id: 'jackpot_mini',    name: 'Mini Jackpot',      desc: 'Hit a Mini jackpot',             icon: '🥉', xp: 200, category: 'jackpots' },
  { id: 'jackpot_major',   name: 'Major Jackpot',     desc: 'Hit a Major jackpot',            icon: '🥈', xp: 500, category: 'jackpots' },
  { id: 'jackpot_grand',   name: 'Grand Jackpot',     desc: 'Hit the Grand jackpot',          icon: '🥇', xp: 1000,category: 'jackpots' },

  // Explorer
  { id: 'play_3_games',    name: 'Explorer',          desc: 'Play 3 different games',         icon: '🗺️', xp: 75,  category: 'explorer' },
  { id: 'play_5_games',    name: 'Adventurer',        desc: 'Play 5 different games',         icon: '🧭', xp: 150, category: 'explorer' },
  { id: 'play_all_games',  name: 'Completionist',     desc: 'Play every game at least once',  icon: '🏆', xp: 500, category: 'explorer' },

  // Levels
  { id: 'level_5',         name: 'Rising Star',       desc: 'Reach level 5',                  icon: '⭐', xp: 100, category: 'levels' },
  { id: 'level_10',        name: 'High Roller',       desc: 'Reach level 10',                 icon: '🌟', xp: 250, category: 'levels' },
  { id: 'level_20',        name: 'VIP',               desc: 'Reach level 20',                 icon: '💫', xp: 500, category: 'levels' },

  // Special
  { id: 'night_owl',       name: 'Night Owl',         desc: 'Play between 2 AM and 5 AM',     icon: '🦉', xp: 50,  category: 'special' },
  { id: 'high_roller_bet', name: 'High Roller Bet',   desc: 'Place a max bet',                icon: '💸', xp: 75,  category: 'special' },
  { id: 'streak_7_daily',  name: 'Dedicated',         desc: 'Claim daily bonus 7 days in a row', icon: '📆', xp: 200, category: 'special' },
];

const ACHIEVEMENTS_MAP = {};
ACHIEVEMENTS.forEach(a => ACHIEVEMENTS_MAP[a.id] = a);

// ── Check & unlock achievement ──
function unlock(userId, achievementId) {
  const def = ACHIEVEMENTS_MAP[achievementId];
  if (!def) return null;

  // Check if already unlocked
  const existing = db.prepare('SELECT id FROM achievements WHERE user_id=? AND achievement_id=?').get(userId, achievementId);
  if (existing) return null;

  // Unlock it
  db.prepare('INSERT INTO achievements (user_id, achievement_id) VALUES (?,?)').run(userId, achievementId);

  // Award XP
  if (def.xp > 0) {
    try { db.prepare('UPDATE users SET xp = xp + ? WHERE id=?').run(def.xp, userId); } catch(e) {}
  }

  // Add to live feed
  const user = db.prepare('SELECT username FROM users WHERE id=?').get(userId);
  try {
    db.prepare('INSERT INTO live_feed (user_id, username, event_type, detail) VALUES (?,?,?,?)').run(userId, user?.username || 'Player', 'achievement', def.name);
  } catch(e) {}

  return def;
}

// ── Check achievements after a spin/game ──
function checkAfterSpin(userId, bet, payout, game) {
  const unlocked = [];
  const u = (id) => { const r = unlock(userId, id); if (r) unlocked.push(r); };

  // First spin
  const spinCount = db.prepare('SELECT COUNT(*) as c FROM spins WHERE user_id=?').get(userId).c;
  if (spinCount <= 1) u('first_spin');

  // First win
  if (payout > 0) {
    const winCount = db.prepare('SELECT COUNT(*) as c FROM spins WHERE user_id=? AND payout > 0').get(userId).c;
    if (winCount <= 1) u('first_win');
  }

  // Volume
  if (spinCount >= 100) u('spins_100');
  if (spinCount >= 500) u('spins_500');
  if (spinCount >= 1000) u('spins_1000');
  if (spinCount >= 5000) u('spins_5000');

  // Win multipliers
  if (bet > 0 && payout > 0) {
    const mult = payout / bet;
    if (mult >= 5) u('win_5x');
    if (mult >= 10) u('win_10x');
    if (mult >= 50) u('win_50x');
    if (mult >= 100) u('win_100x');
  }

  // Win streaks
  if (payout > 0) {
    const recentSpins = db.prepare('SELECT payout FROM spins WHERE user_id=? ORDER BY id DESC LIMIT 10').all(userId);
    let streak = 0;
    for (const s of recentSpins) {
      if (s.payout > 0) streak++;
      else break;
    }
    if (streak >= 3) u('win_streak_3');
    if (streak >= 5) u('win_streak_5');
    if (streak >= 10) u('win_streak_10');
  }

  // Explorer - unique games played
  const uniqueGames = db.prepare('SELECT COUNT(DISTINCT game) as c FROM spins WHERE user_id=?').get(userId).c;
  if (uniqueGames >= 3) u('play_3_games');
  if (uniqueGames >= 5) u('play_5_games');
  const totalGames = db.prepare('SELECT COUNT(*) as c FROM games WHERE status != ?').get('disabled').c;
  if (uniqueGames >= totalGames && totalGames > 0) u('play_all_games');

  // Max bet
  try {
    const maxBet = db.prepare("SELECT value FROM settings WHERE key='max_bet'").get();
    if (maxBet && bet >= parseInt(maxBet.value)) u('high_roller_bet');
  } catch(e) {}

  // Night owl (2-5 AM)
  const hour = new Date().getHours();
  if (hour >= 2 && hour < 5) u('night_owl');

  // Level checks
  try {
    const user = db.prepare('SELECT level FROM users WHERE id=?').get(userId);
    if (user) {
      if (user.level >= 5) u('level_5');
      if (user.level >= 10) u('level_10');
      if (user.level >= 20) u('level_20');
    }
  } catch(e) {}

  // Add big win to live feed
  if (payout > 0 && bet > 0) {
    const mult = payout / bet;
    if (mult >= 5) {
      const user = db.prepare('SELECT username FROM users WHERE id=?').get(userId);
      try {
        db.prepare('INSERT INTO live_feed (user_id, username, event_type, game, amount, detail) VALUES (?,?,?,?,?,?)').run(
          userId, user?.username || 'Player', 'big_win', game, payout / 100,
          mult >= 50 ? 'MEGA WIN' : mult >= 20 ? 'HUGE WIN' : 'BIG WIN'
        );
      } catch(e) {}
    }
  }

  return unlocked;
}

// ── Check jackpot achievement ──
function checkJackpot(userId, jackpotType) {
  const map = { mini: 'jackpot_mini', major: 'jackpot_major', grand: 'jackpot_grand' };
  const id = map[jackpotType];
  if (id) return unlock(userId, id);
  return null;
}

// ── Check referral achievement ──
function checkReferral(userId) {
  return unlock(userId, 'referral_first');
}

// ── Check daily bonus streak achievement ──
function checkDailyStreak(userId, streak) {
  if (streak >= 7) return unlock(userId, 'streak_7_daily');
  return unlock(userId, 'daily_collector');
}

// ── API Routes ──

// GET /api/game/achievements — my achievements
router.get('/achievements', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });

  const unlocked = db.prepare('SELECT achievement_id, unlocked_at FROM achievements WHERE user_id=?').all(req.session.userId);
  const unlockedMap = {};
  unlocked.forEach(a => unlockedMap[a.achievement_id] = a.unlocked_at);

  const all = ACHIEVEMENTS.map(a => ({
    ...a,
    unlocked: !!unlockedMap[a.id],
    unlocked_at: unlockedMap[a.id] || null
  }));

  res.json({
    achievements: all,
    unlocked: unlocked.length,
    total: ACHIEVEMENTS.length,
    xpEarned: unlocked.reduce((sum, a) => sum + (ACHIEVEMENTS_MAP[a.achievement_id]?.xp || 0), 0)
  });
});

// GET /api/game/live-feed — recent activity feed
router.get('/live-feed', (req, res) => {
  try {
    const events = db.prepare('SELECT * FROM live_feed ORDER BY id DESC LIMIT 30').all();
    res.json({ events });
  } catch(e) {
    res.json({ events: [] });
  }
});

// Export for use in game routes

module.exports = router;
module.exports.checkAfterSpin = checkAfterSpin;
module.exports.checkJackpot = checkJackpot;
module.exports.checkReferral = checkReferral;
module.exports.checkDailyStreak = checkDailyStreak;
module.exports.unlock = unlock;
module.exports.ACHIEVEMENTS = ACHIEVEMENTS;
