const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');

router.post('/register', (req, res) => {
  const { username, password, invite } = req.body;
  if (!username || !password || !invite) return res.status(400).json({ error: 'Missing fields' });

  const inviteRow = db.prepare('SELECT * FROM invites WHERE code = ? AND used = 0').get(invite);
  if (!inviteRow) return res.status(400).json({ error: 'Invalid or used invite code' });

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(400).json({ error: 'Username taken' });

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO users (username, password, credits) VALUES (?, ?, ?)').run(username, hash, inviteRow.credits);
  db.prepare('UPDATE invites SET used = 1 WHERE code = ?').run(invite);

  req.session.userId = result.lastInsertRowid;
  req.session.username = username;
  req.session.role = 'player';

  res.json({ success: true, username, role: 'player', credits: inviteRow.credits });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;

  res.json({ success: true, username: user.username, role: user.role, credits: user.credits });
});

router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

module.exports = router;
