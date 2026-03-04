const express = require('express');
const router = express.Router();
const db = require('../db');
const crypto = require('crypto');

// ── Ensure tables ──
try { db.exec(`
  CREATE TABLE IF NOT EXISTS promo_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    type TEXT DEFAULT 'credits',
    amount INTEGER DEFAULT 0,
    max_uses INTEGER DEFAULT 1,
    used_count INTEGER DEFAULT 0,
    expires_at TEXT,
    min_level INTEGER DEFAULT 0,
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );
`); } catch(e) {}

try { db.exec(`
  CREATE TABLE IF NOT EXISTS promo_redemptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    promo_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    amount INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(promo_id, user_id)
  );
`); } catch(e) {}

try { db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    amount INTEGER DEFAULT 0,
    balance_after INTEGER DEFAULT 0,
    description TEXT DEFAULT '',
    game TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
`); } catch(e) {}

try { db.exec(`
  CREATE TABLE IF NOT EXISTS suspicion_flags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    flag_type TEXT NOT NULL,
    details TEXT DEFAULT '',
    resolved INTEGER DEFAULT 0,
    resolved_by INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );
`); } catch(e) {}

// ─── Helper: require admin ───
function requireAdmin(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not auth' });
  const user = db.prepare('SELECT role FROM users WHERE id=?').get(req.session.userId);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// ─── Helper: log transaction ───
function logTransaction(userId, type, amount, description, game) {
  try {
    const user = db.prepare('SELECT credits FROM users WHERE id=?').get(userId);
    db.prepare('INSERT INTO transactions (user_id, type, amount, balance_after, description, game) VALUES (?,?,?,?,?,?)').run(
      userId, type, amount, user?.credits || 0, description || '', game || ''
    );
  } catch(e) {}
}

// ══════════════════════════════════════════════════════
// PROMO CODES
// ══════════════════════════════════════════════════════

// POST /api/admin/promo/create
router.post('/promo/create', requireAdmin, (req, res) => {
  const { code, type, amount, maxUses, expiresAt, minLevel } = req.body;
  const promoCode = (code || crypto.randomBytes(4).toString('hex')).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!promoCode || promoCode.length < 3) return res.status(400).json({ error: 'Code must be at least 3 characters' });

  const amountCents = Math.round((parseFloat(amount) || 0) * 100);
  if (amountCents <= 0) return res.status(400).json({ error: 'Amount must be positive' });

  try {
    db.prepare('INSERT INTO promo_codes (code, type, amount, max_uses, expires_at, min_level, created_by) VALUES (?,?,?,?,?,?,?)').run(
      promoCode, type || 'credits', amountCents, parseInt(maxUses) || 1, expiresAt || null, parseInt(minLevel) || 0, req.session.userId
    );
    res.json({ success: true, code: promoCode });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Code already exists' });
    res.status(500).json({ error: 'Failed to create' });
  }
});

// GET /api/admin/promo/list
router.get('/promo/list', requireAdmin, (req, res) => {
  const promos = db.prepare('SELECT * FROM promo_codes ORDER BY id DESC LIMIT 50').all();
  promos.forEach(p => { p.amount_display = p.amount / 100; });
  res.json({ promos });
});

// DELETE /api/admin/promo/:id
router.delete('/promo/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM promo_codes WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// POST /api/game/promo/redeem — player redeems a code
router.post('/redeem', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Enter a promo code' });

  const promo = db.prepare('SELECT * FROM promo_codes WHERE code=? COLLATE NOCASE').get(code.trim().toUpperCase());
  if (!promo) return res.status(400).json({ error: 'Invalid promo code' });

  // Check expiry
  if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
    return res.status(400).json({ error: 'This code has expired' });
  }

  // Check uses
  if (promo.used_count >= promo.max_uses) {
    return res.status(400).json({ error: 'This code has been fully redeemed' });
  }

  // Check if already used by this player
  const existing = db.prepare('SELECT id FROM promo_redemptions WHERE promo_id=? AND user_id=?').get(promo.id, req.session.userId);
  if (existing) return res.status(400).json({ error: 'You already used this code' });

  // Check min level
  if (promo.min_level > 0) {
    const user = db.prepare('SELECT level FROM users WHERE id=?').get(req.session.userId);
    if (!user || (user.level || 1) < promo.min_level) {
      return res.status(400).json({ error: 'You need to be level ' + promo.min_level + ' to use this code' });
    }
  }

  // Apply reward
  if (promo.type === 'credits') {
    db.prepare('UPDATE users SET credits = credits + ? WHERE id=?').run(promo.amount, req.session.userId);
    logTransaction(req.session.userId, 'promo', promo.amount, 'Promo code: ' + promo.code, '');
  } else if (promo.type === 'xp') {
    try { db.prepare('UPDATE users SET xp = xp + ? WHERE id=?').run(promo.amount, req.session.userId); } catch(e) {}
  }

  // Record redemption
  db.prepare('INSERT INTO promo_redemptions (promo_id, user_id, amount) VALUES (?,?,?)').run(promo.id, req.session.userId, promo.amount);
  db.prepare('UPDATE promo_codes SET used_count = used_count + 1 WHERE id=?').run(promo.id);

  const displayAmount = promo.type === 'credits' ? '$' + (promo.amount / 100).toFixed(2) : promo.amount + ' XP';
  res.json({ success: true, message: 'Redeemed! You received ' + displayAmount, type: promo.type, amount: promo.amount / 100 });
});

// ══════════════════════════════════════════════════════
// TRANSACTION HISTORY
// ══════════════════════════════════════════════════════

// GET /api/game/transactions — player's own history
router.get('/transactions', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const page = parseInt(req.query.page) || 1;
  const limit = 50;
  const offset = (page - 1) * limit;

  const transactions = db.prepare('SELECT * FROM transactions WHERE user_id=? ORDER BY id DESC LIMIT ? OFFSET ?').all(req.session.userId, limit, offset);
  const total = db.prepare('SELECT COUNT(*) as c FROM transactions WHERE user_id=?').get(req.session.userId).c;

  // Also build from spins if transactions table is sparse
  let spinHistory = [];
  if (transactions.length < 10) {
    spinHistory = db.prepare('SELECT id, game, bet, payout, created_at FROM spins WHERE user_id=? ORDER BY id DESC LIMIT 50').all(req.session.userId);
  }

  transactions.forEach(t => { t.amount_display = t.amount / 100; t.balance_display = t.balance_after / 100; });

  res.json({ transactions, spinHistory, total, page, pages: Math.ceil(total / limit) });
});

// ══════════════════════════════════════════════════════
// AUTO-SUSPEND (Suspicious Activity Detection)
// ══════════════════════════════════════════════════════

function checkSuspicious(userId) {
  const flags = [];

  try {
    // 1. Win rate too high (>70% over last 100 spins)
    const recent = db.prepare('SELECT bet, payout FROM spins WHERE user_id=? ORDER BY id DESC LIMIT 100').all(userId);
    if (recent.length >= 50) {
      const wins = recent.filter(s => s.payout > 0).length;
      const winRate = wins / recent.length;
      if (winRate > 0.70) {
        flags.push({ type: 'high_win_rate', details: `Win rate ${Math.round(winRate * 100)}% over last ${recent.length} spins` });
      }
    }

    // 2. Unusual profit (won 10x+ their total wagers in last hour)
    const hourStats = db.prepare(`
      SELECT COALESCE(SUM(bet),0) as wagered, COALESCE(SUM(payout),0) as won
      FROM spins WHERE user_id=? AND created_at > datetime('now','-1 hour')
    `).get(userId);
    if (hourStats.wagered > 0 && hourStats.won > hourStats.wagered * 10) {
      flags.push({ type: 'unusual_profit', details: `Won $${(hourStats.won/100).toFixed(2)} on $${(hourStats.wagered/100).toFixed(2)} wagered in last hour` });
    }

    // 3. Multiple accounts from same IP
    const userIp = db.prepare('SELECT last_ip FROM users WHERE id=?').get(userId);
    if (userIp && userIp.last_ip) {
      const sameIp = db.prepare('SELECT COUNT(*) as c FROM users WHERE last_ip=? AND id!=?').get(userIp.last_ip, userId).c;
      if (sameIp >= 2) {
        flags.push({ type: 'multi_account', details: `${sameIp + 1} accounts from IP ${userIp.last_ip}` });
      }
    }

    // 4. Rapid betting (>60 spins in 5 minutes)
    const rapidCount = db.prepare(`
      SELECT COUNT(*) as c FROM spins WHERE user_id=? AND created_at > datetime('now','-5 minutes')
    `).get(userId).c;
    if (rapidCount > 60) {
      flags.push({ type: 'rapid_betting', details: `${rapidCount} spins in last 5 minutes` });
    }

    // Save new flags (skip duplicates from last hour)
    flags.forEach(f => {
      const exists = db.prepare(`
        SELECT id FROM suspicion_flags WHERE user_id=? AND flag_type=? AND created_at > datetime('now','-1 hour')
      `).get(userId, f.type);
      if (!exists) {
        db.prepare('INSERT INTO suspicion_flags (user_id, flag_type, details) VALUES (?,?,?)').run(userId, f.type, f.details);
      }
    });

    // Auto-suspend if 3+ flags in last 24h
    const recentFlags = db.prepare(`
      SELECT COUNT(*) as c FROM suspicion_flags WHERE user_id=? AND resolved=0 AND created_at > datetime('now','-24 hours')
    `).get(userId).c;
    if (recentFlags >= 3) {
      const user = db.prepare('SELECT account_status FROM users WHERE id=?').get(userId);
      if (user && user.account_status !== 'banned' && user.account_status !== 'suspended') {
        try {
          db.prepare("UPDATE users SET account_status='suspended', status_reason='Auto-suspended: suspicious activity' WHERE id=?").run(userId);
        } catch(e) {}
      }
    }
  } catch(e) {
    console.error('Suspicious check error:', e.message);
  }

  return flags;
}

// GET /api/admin/suspicion/flags — view all flags
router.get('/suspicion/flags', requireAdmin, (req, res) => {
  const flags = db.prepare(`
    SELECT f.*, u.username FROM suspicion_flags f
    JOIN users u ON f.user_id = u.id
    WHERE f.resolved = 0
    ORDER BY f.id DESC LIMIT 100
  `).all();
  const totalUnresolved = db.prepare('SELECT COUNT(*) as c FROM suspicion_flags WHERE resolved=0').get().c;
  res.json({ flags, totalUnresolved });
});

// POST /api/admin/suspicion/resolve/:id
router.post('/suspicion/resolve/:id', requireAdmin, (req, res) => {
  db.prepare('UPDATE suspicion_flags SET resolved=1, resolved_by=? WHERE id=?').run(req.session.userId, req.params.id);
  res.json({ success: true });
});

// POST /api/admin/suspicion/resolve-all/:userId
router.post('/suspicion/resolve-all/:userId', requireAdmin, (req, res) => {
  db.prepare('UPDATE suspicion_flags SET resolved=1, resolved_by=? WHERE user_id=? AND resolved=0').run(req.session.userId, req.params.userId);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════
// CHART DATA (daily revenue, signups, RTP tracking)
// ══════════════════════════════════════════════════════

router.get('/charts/revenue', requireAdmin, (req, res) => {
  const days = parseInt(req.query.days) || 14;
  const data = db.prepare(`
    SELECT date(created_at) as day, 
      COUNT(*) as spins,
      COALESCE(SUM(bet),0) as wagered,
      COALESCE(SUM(payout),0) as paid,
      COALESCE(SUM(bet-payout),0) as revenue
    FROM spins WHERE created_at > datetime('now','-${days} days')
    GROUP BY day ORDER BY day
  `).all();
  data.forEach(d => { d.wagered /= 100; d.paid /= 100; d.revenue /= 100; });
  res.json({ data });
});

router.get('/charts/signups', requireAdmin, (req, res) => {
  const days = parseInt(req.query.days) || 14;
  // Use rowid as proxy for creation order since we may not have created_at
  const data = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as signups
    FROM users WHERE created_at > datetime('now','-${days} days')
    GROUP BY day ORDER BY day
  `).all();
  res.json({ data });
});

router.get('/charts/rtp-actual', requireAdmin, (req, res) => {
  const data = db.prepare(`
    SELECT game, COUNT(*) as rounds,
      COALESCE(SUM(bet),0) as wagered,
      COALESCE(SUM(payout),0) as paid,
      CASE WHEN SUM(bet) > 0 THEN ROUND(CAST(SUM(payout) AS FLOAT) / SUM(bet) * 100, 2) ELSE 0 END as actual_rtp
    FROM spins WHERE created_at > datetime('now','-7 days')
    GROUP BY game HAVING rounds >= 10
    ORDER BY rounds DESC
  `).all();
  data.forEach(d => { d.wagered /= 100; d.paid /= 100; });
  res.json({ data });
});

// Export the suspicious check for use in game.js
module.exports = router;
module.exports.checkSuspicious = checkSuspicious;
module.exports.logTransaction = logTransaction;
