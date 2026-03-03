const express = require('express');
const router = express.Router();
const db = require('../db');

// XP system
let awardXP, XP_REWARDS;
try {
  const levels = require('./levels');
  awardXP = levels.awardXP;
  XP_REWARDS = levels.XP_REWARDS;
} catch(e) {
  awardXP = () => null;
  XP_REWARDS = { daily_bonus: 0 };
}

// ── BONUS CONFIG ─────────────────────────────────────────────────
// Prizes on the wheel — 8 slices
// Streak multiplier increases the base amounts
const BASE_PRIZES = [
  { label: '$0.50',    amount: 50,    color: '#1a1a3e', weight: 25 },
  { label: '$1.00',    amount: 100,   color: '#2a1a3e', weight: 20 },
  { label: '$2.50',    amount: 250,   color: '#1a2a3e', weight: 18 },
  { label: '$5.00',    amount: 500,   color: '#3e1a2a', weight: 15 },
  { label: '$10.00',   amount: 1000,  color: '#1a3e2a', weight: 10 },
  { label: '$25.00',   amount: 2500,  color: '#3e2a1a', weight: 7  },
  { label: '$50.00',   amount: 5000,  color: '#2a3e1a', weight: 3  },
  { label: '$100.00',  amount: 10000, color: '#3e1a3e', weight: 2  },
];

// Streak bonuses — multiplier applied to prize
const STREAK_MULTIPLIERS = {
  1: 1.0,    // Day 1: 1x
  2: 1.1,    // Day 2: 1.1x
  3: 1.25,   // Day 3: 1.25x
  4: 1.4,    // Day 4: 1.4x
  5: 1.6,    // Day 5: 1.6x
  6: 1.8,    // Day 6: 1.8x
  7: 2.0,    // Day 7: 2x (full week!)
};
function getMultiplier(streak) {
  if (streak >= 7) return 2.0;
  return STREAK_MULTIPLIERS[streak] || 1.0;
}

// Weighted random pick
function pickPrize() {
  const totalWeight = BASE_PRIZES.reduce((sum, p) => sum + p.weight, 0);
  let r = Math.random() * totalWeight;
  for (const prize of BASE_PRIZES) {
    r -= prize.weight;
    if (r <= 0) return prize;
  }
  return BASE_PRIZES[0];
}

// Check if a timestamp is from today (UTC)
function isToday(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const now = new Date();
  return d.getUTCFullYear() === now.getUTCFullYear() &&
         d.getUTCMonth() === now.getUTCMonth() &&
         d.getUTCDate() === now.getUTCDate();
}

// Check if a timestamp is from yesterday (UTC)
function isYesterday(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return d.getUTCFullYear() === yesterday.getUTCFullYear() &&
         d.getUTCMonth() === yesterday.getUTCMonth() &&
         d.getUTCDate() === yesterday.getUTCDate();
}

// ── GET /api/game/daily-bonus ────────────────────────────────────
// Check bonus status for the current user
router.get('/daily-bonus', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });

  try {
    const last = db.prepare(
      'SELECT * FROM daily_bonus WHERE user_id = ? ORDER BY claimed_at DESC LIMIT 1'
    ).get(req.session.userId);

    const alreadyClaimed = last && isToday(last.claimed_at);
    const streak = last ? (isYesterday(last.claimed_at) ? last.day_streak : (isToday(last.claimed_at) ? last.day_streak : 0)) : 0;
    const nextStreak = alreadyClaimed ? streak : (last && isYesterday(last.claimed_at) ? streak + 1 : 1);
    const multiplier = getMultiplier(nextStreak);

    res.json({
      available: !alreadyClaimed,
      streak: alreadyClaimed ? streak : nextStreak,
      multiplier,
      lastClaimed: last ? last.claimed_at : null,
      prizes: BASE_PRIZES.map(p => ({
        label: '$' + ((p.amount * multiplier) / 100).toFixed(2),
        amount: Math.round(p.amount * multiplier),
        color: p.color,
      })),
    });
  } catch (e) {
    console.error('Daily bonus status error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/game/claim-daily-bonus ─────────────────────────────
// Spin the wheel and claim the prize
router.post('/claim-daily-bonus', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });

  try {
    // Check if already claimed today
    const last = db.prepare(
      'SELECT * FROM daily_bonus WHERE user_id = ? ORDER BY claimed_at DESC LIMIT 1'
    ).get(req.session.userId);

    if (last && isToday(last.claimed_at)) {
      return res.status(400).json({ error: 'Already claimed today', nextReset: getNextResetTime() });
    }

    // Calculate streak
    let streak = 1;
    if (last && isYesterday(last.claimed_at)) {
      streak = Math.min(last.day_streak + 1, 7);
    }

    const multiplier = getMultiplier(streak);
    const basePrize = pickPrize();
    const finalAmount = Math.round(basePrize.amount * multiplier);
    const finalLabel = '$' + (finalAmount / 100).toFixed(2);

    // Find the index of this prize on the wheel
    const prizeIndex = BASE_PRIZES.indexOf(basePrize);

    // Record the claim
    db.prepare(
      'INSERT INTO daily_bonus (user_id, day_streak, prize_amount, prize_label) VALUES (?, ?, ?, ?)'
    ).run(req.session.userId, streak, finalAmount, finalLabel);

    // Add credits to user
    db.prepare('UPDATE users SET credits = credits + ? WHERE id = ?')
      .run(finalAmount, req.session.userId);

    const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(req.session.userId);

    // Award XP for daily bonus
    var xp = awardXP(req.session.userId, XP_REWARDS.daily_bonus || 15, 'daily_bonus');

    res.json({
      success: true,
      prizeIndex,
      prizeLabel: finalLabel,
      prizeAmount: finalAmount,
      streak,
      multiplier,
      newBalance: user.credits,
      prizes: BASE_PRIZES.map(p => ({
        label: '$' + ((p.amount * multiplier) / 100).toFixed(2),
        amount: Math.round(p.amount * multiplier),
        color: p.color,
      })),
      xp,
    });
  } catch (e) {
    console.error('Claim daily bonus error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

function getNextResetTime() {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return tomorrow.toISOString();
}

module.exports = router;
