const express = require('express');
const router = express.Router();
const db = require('../db');
const crypto = require('crypto');

// ── Ensure tables ──
try { db.exec(`
  CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_id INTEGER NOT NULL,
    referred_id INTEGER NOT NULL,
    referral_code TEXT NOT NULL,
    bonus_given INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(referred_id)
  );
`); } catch(e) {}

try { db.exec(`ALTER TABLE users ADD COLUMN referral_code TEXT DEFAULT '';`); } catch(e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN referred_by INTEGER DEFAULT NULL;`); } catch(e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN referral_count INTEGER DEFAULT 0;`); } catch(e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN referral_earnings INTEGER DEFAULT 0;`); } catch(e) {}

// Generate unique referral code for user if they don't have one
function ensureReferralCode(userId) {
  const user = db.prepare('SELECT referral_code FROM users WHERE id=?').get(userId);
  if (user && user.referral_code) return user.referral_code;
  const code = crypto.randomBytes(4).toString('hex').toUpperCase();
  db.prepare('UPDATE users SET referral_code=? WHERE id=?').run(code, userId);
  return code;
}

// ── Settings ──
const REFERRAL_BONUS_REFERRER = 500;  // $5.00 to the referrer
const REFERRAL_BONUS_REFERRED = 200;  // $2.00 to the new player
const REFERRAL_XP_BONUS = 100;        // XP to referrer

// ── GET /api/game/referral — get my referral info ──
router.get('/referral', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  
  const code = ensureReferralCode(req.session.userId);
  const user = db.prepare('SELECT referral_count, referral_earnings FROM users WHERE id=?').get(req.session.userId);
  const referrals = db.prepare(`
    SELECT r.created_at, u.username, r.bonus_given
    FROM referrals r JOIN users u ON r.referred_id = u.id
    WHERE r.referrer_id = ? ORDER BY r.id DESC LIMIT 50
  `).all(req.session.userId);

  res.json({
    code,
    link: '/register?ref=' + code,
    totalReferred: user.referral_count || 0,
    totalEarned: (user.referral_earnings || 0) / 100,
    bonusPerReferral: REFERRAL_BONUS_REFERRER / 100,
    bonusForNewPlayer: REFERRAL_BONUS_REFERRED / 100,
    referrals
  });
});

// ── POST /api/game/referral/apply — apply referral code during/after signup ──
router.post('/referral/apply', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Missing code' });

  // Check if already referred
  const existing = db.prepare('SELECT id FROM referrals WHERE referred_id=?').get(req.session.userId);
  if (existing) return res.status(400).json({ error: 'You already used a referral code' });

  // Find referrer
  const referrer = db.prepare('SELECT id, username FROM users WHERE referral_code=? COLLATE NOCASE').get(code.trim());
  if (!referrer) return res.status(400).json({ error: 'Invalid referral code' });
  if (referrer.id === req.session.userId) return res.status(400).json({ error: 'Cannot refer yourself' });

  // Apply bonuses
  db.prepare('INSERT INTO referrals (referrer_id, referred_id, referral_code, bonus_given) VALUES (?,?,?,1)').run(referrer.id, req.session.userId, code.trim());
  db.prepare('UPDATE users SET credits = credits + ?, referred_by = ? WHERE id=?').run(REFERRAL_BONUS_REFERRED, referrer.id, req.session.userId);
  db.prepare('UPDATE users SET credits = credits + ?, referral_count = referral_count + 1, referral_earnings = referral_earnings + ? WHERE id=?').run(REFERRAL_BONUS_REFERRER, REFERRAL_BONUS_REFERRER, referrer.id);

  // Award XP to referrer
  try {
    db.prepare('UPDATE users SET xp = xp + ? WHERE id=?').run(REFERRAL_XP_BONUS, referrer.id);
  } catch(e) {}

  res.json({
    success: true,
    message: `You got $${(REFERRAL_BONUS_REFERRED/100).toFixed(2)} bonus! Thanks for joining via ${referrer.username}'s referral.`
  });
});

// ── Admin: referral stats ──
router.get('/referral/admin-stats', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not auth' });
  const user = db.prepare('SELECT role FROM users WHERE id=?').get(req.session.userId);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  const totalReferrals = db.prepare('SELECT COUNT(*) as c FROM referrals').get().c;
  const totalBonusPaid = db.prepare('SELECT COALESCE(SUM(referral_earnings),0) as t FROM users').get().t;
  const topReferrers = db.prepare(`
    SELECT u.id, u.username, u.referral_code, u.referral_count, u.referral_earnings
    FROM users u WHERE u.referral_count > 0
    ORDER BY u.referral_count DESC LIMIT 20
  `).all();
  const recentReferrals = db.prepare(`
    SELECT r.*, u1.username as referrer_name, u2.username as referred_name
    FROM referrals r
    JOIN users u1 ON r.referrer_id = u1.id
    JOIN users u2 ON r.referred_id = u2.id
    ORDER BY r.id DESC LIMIT 30
  `).all();

  res.json({
    totalReferrals,
    totalBonusPaid: totalBonusPaid / 100,
    topReferrers: topReferrers.map(r => ({...r, referral_earnings: r.referral_earnings / 100})),
    recentReferrals
  });
});

module.exports = router;
