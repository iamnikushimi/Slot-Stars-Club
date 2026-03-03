/**
 * Player Levels & XP System
 * File: routes/levels.js
 * 
 * Mount in server.js:
 *   app.use('/api/game', require('./routes/levels'));
 */

const express = require('express');
const router = express.Router();
const db = require('../db');

// ── DB MIGRATION ─────────────────────────────────────────────
try {
  // Add xp and level columns to users table if they don't exist
  const cols = db.pragma('table_info(users)').map(c => c.name);
  if (!cols.includes('xp')) {
    db.exec('ALTER TABLE users ADD COLUMN xp INTEGER DEFAULT 0');
  }
  if (!cols.includes('level')) {
    db.exec('ALTER TABLE users ADD COLUMN level INTEGER DEFAULT 1');
  }
  if (!cols.includes('title')) {
    db.exec("ALTER TABLE users ADD COLUMN title TEXT DEFAULT 'Rookie'");
  }

  // XP history table for tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS xp_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      source TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_xp_events_user ON xp_events(user_id);
  `);
} catch(e) {
  console.error('Levels migration error:', e);
}

// ── LEVEL CONFIG ─────────────────────────────────────────────
// XP required for each level (cumulative)
// Curve: level N requires N*100 + (N-1)*50 XP from previous level
// Gets progressively harder
const LEVELS = [
  { level: 1,  xp: 0,       title: 'Rookie',         reward: 0 },
  { level: 2,  xp: 150,     title: 'Beginner',       reward: 100 },
  { level: 3,  xp: 400,     title: 'Regular',         reward: 150 },
  { level: 4,  xp: 750,     title: 'Player',          reward: 200 },
  { level: 5,  xp: 1200,    title: 'Skilled',         reward: 300 },
  { level: 6,  xp: 1800,    title: 'Veteran',         reward: 400 },
  { level: 7,  xp: 2600,    title: 'Expert',          reward: 500 },
  { level: 8,  xp: 3600,    title: 'Master',          reward: 750 },
  { level: 9,  xp: 4900,    title: 'Elite',           reward: 1000 },
  { level: 10, xp: 6500,    title: 'Champion',        reward: 1500 },
  { level: 11, xp: 8500,    title: 'Legend',           reward: 2000 },
  { level: 12, xp: 11000,   title: 'Mythic',          reward: 2500 },
  { level: 13, xp: 14000,   title: 'Immortal',        reward: 3000 },
  { level: 14, xp: 17500,   title: 'Transcendent',    reward: 4000 },
  { level: 15, xp: 22000,   title: 'Ascended',        reward: 5000 },
  { level: 16, xp: 27500,   title: 'Divine',          reward: 6000 },
  { level: 17, xp: 34000,   title: 'Celestial',       reward: 7500 },
  { level: 18, xp: 42000,   title: 'Titan',           reward: 9000 },
  { level: 19, xp: 52000,   title: 'Overlord',        reward: 11000 },
  { level: 20, xp: 65000,   title: 'Star Lord',       reward: 15000 },
];

// XP rewards for actions
const XP_REWARDS = {
  spin:         5,   // Any slot spin
  win:          10,  // Won a spin (payout > 0)
  big_win:      25,  // Won 5x+ bet
  mega_win:     50,  // Won 20x+ bet
  jackpot:      200, // Hit a jackpot
  daily_bonus:  15,  // Claimed daily bonus
  crash_play:   5,   // Played a crash round
  crash_win:    10,  // Won a crash round
  table_play:   5,   // Played blackjack/roulette/poker
  table_win:    10,  // Won a table game
  first_game:   50,  // First time playing a new game (bonus)
};

function getLevelForXP(xp) {
  let current = LEVELS[0];
  for (const lvl of LEVELS) {
    if (xp >= lvl.xp) current = lvl;
    else break;
  }
  return current;
}

function getNextLevel(level) {
  const idx = LEVELS.findIndex(l => l.level === level);
  if (idx >= 0 && idx < LEVELS.length - 1) return LEVELS[idx + 1];
  return null;
}

// ── CORE: Award XP ──────────────────────────────────────────
function awardXP(userId, amount, source) {
  if (!userId || amount <= 0) return null;

  try {
    const user = db.prepare('SELECT xp, level, credits FROM users WHERE id = ?').get(userId);
    if (!user) return null;

    const oldLevel = user.level || 1;
    const newXP = (user.xp || 0) + amount;
    const newLevelData = getLevelForXP(newXP);
    const newLevel = newLevelData.level;
    const leveled = newLevel > oldLevel;

    // Record XP event
    db.prepare('INSERT INTO xp_events (user_id, amount, source) VALUES (?, ?, ?)').run(userId, amount, source);

    // Update user
    let bonusCredits = 0;
    if (leveled) {
      // Sum rewards for all levels gained (in case they skip levels)
      for (const lvl of LEVELS) {
        if (lvl.level > oldLevel && lvl.level <= newLevel) {
          bonusCredits += lvl.reward;
        }
      }
      db.prepare('UPDATE users SET xp = ?, level = ?, title = ?, credits = credits + ? WHERE id = ?')
        .run(newXP, newLevel, newLevelData.title, bonusCredits, userId);
    } else {
      db.prepare('UPDATE users SET xp = ?, level = ?, title = ? WHERE id = ?')
        .run(newXP, newLevel, newLevelData.title, userId);
    }

    const next = getNextLevel(newLevel);
    return {
      xp: newXP,
      xpGained: amount,
      level: newLevel,
      title: newLevelData.title,
      leveledUp: leveled,
      oldLevel: leveled ? oldLevel : undefined,
      reward: leveled ? bonusCredits : undefined,
      nextLevel: next ? { level: next.level, xp: next.xp, title: next.title } : null,
      progress: next ? (newXP - newLevelData.xp) / (next.xp - newLevelData.xp) : 1,
    };
  } catch(e) {
    console.error('Award XP error:', e);
    return null;
  }
}

// ── GET /api/game/player-level ──────────────────────────────
router.get('/player-level', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });

  try {
    const user = db.prepare('SELECT xp, level, title FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const xp = user.xp || 0;
    const levelData = getLevelForXP(xp);
    const next = getNextLevel(levelData.level);

    res.json({
      xp,
      level: levelData.level,
      title: levelData.title,
      nextLevel: next ? { level: next.level, xp: next.xp, title: next.title } : null,
      progress: next ? (xp - levelData.xp) / (next.xp - levelData.xp) : 1,
      allLevels: LEVELS,
    });
  } catch(e) {
    console.error('Player level error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/game/xp-history ────────────────────────────────
router.get('/xp-history', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  try {
    const events = db.prepare(
      'SELECT amount, source, created_at FROM xp_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
    ).all(req.session.userId);
    res.json({ events });
  } catch(e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/game/levels-config ─────────────────────────────
// Public: returns level table so the UI can show the progression
router.get('/levels-config', (req, res) => {
  res.json({ levels: LEVELS, xpRewards: XP_REWARDS });
});

// Export the awardXP function so other routes can use it
module.exports = router;
module.exports.awardXP = awardXP;
module.exports.XP_REWARDS = XP_REWARDS;
module.exports.LEVELS = LEVELS;
