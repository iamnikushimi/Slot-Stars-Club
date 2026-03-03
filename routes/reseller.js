const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

router.post('/invite', requireRole('reseller', 'admin'), (req, res) => {
  const { credits = 5 } = req.body;
  const reseller = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);

  if (reseller.reseller_credits < credits) {
    return res.status(400).json({ error: 'Insufficient reseller credits' });
  }

  const code = uuidv4().slice(0, 8).toUpperCase();
  db.prepare('INSERT INTO invites (code, credits, created_by) VALUES (?, ?, ?)').run(code, credits, req.session.userId);
  db.prepare('UPDATE users SET reseller_credits = reseller_credits - ? WHERE id = ?').run(credits, req.session.userId);

  res.json({ code, creditsRemaining: reseller.reseller_credits - credits });
});

router.post('/add-credits', requireRole('reseller', 'admin'), (req, res) => {
  const { username, amount } = req.body;
  if (!username || !amount || amount < 1) return res.status(400).json({ error: 'Invalid request' });

  const reseller = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (reseller.reseller_credits < amount) {
    return res.status(400).json({ error: 'Insufficient reseller credits' });
  }

  const target = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!target) return res.status(404).json({ error: 'User not found' });

  db.prepare('UPDATE users SET credits = credits + ? WHERE id = ?').run(amount, target.id);
  db.prepare('UPDATE users SET reseller_credits = reseller_credits - ? WHERE id = ?').run(amount, req.session.userId);

  const updatedReseller = db.prepare('SELECT reseller_credits FROM users WHERE id = ?').get(req.session.userId);
  res.json({ success: true, resellerCredits: updatedReseller.reseller_credits });
});

module.exports = router;
