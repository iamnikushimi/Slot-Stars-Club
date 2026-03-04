const express = require('express');
const router = express.Router();
const db = require('../db');

// ── Ensure tables ──
try { db.exec(`
  CREATE TABLE IF NOT EXISTS user_preferences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE NOT NULL,
    sound_enabled INTEGER DEFAULT 1,
    sound_volume INTEGER DEFAULT 80,
    music_enabled INTEGER DEFAULT 1,
    music_volume INTEGER DEFAULT 50,
    notifications_enabled INTEGER DEFAULT 1,
    haptic_enabled INTEGER DEFAULT 1,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`); } catch(e) {}

try { db.exec(`
  CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    game_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, game_id)
  );
`); } catch(e) {}

// ─── SOUND/NOTIFICATION PREFERENCES ────────────────────

// GET /api/game/preferences
router.get('/preferences', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not auth' });
  let prefs = db.prepare('SELECT * FROM user_preferences WHERE user_id=?').get(req.session.userId);
  if (!prefs) {
    db.prepare('INSERT INTO user_preferences (user_id) VALUES (?)').run(req.session.userId);
    prefs = db.prepare('SELECT * FROM user_preferences WHERE user_id=?').get(req.session.userId);
  }
  res.json({ preferences: prefs });
});

// POST /api/game/preferences — update preferences
router.post('/preferences', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not auth' });
  const { sound_enabled, sound_volume, music_enabled, music_volume, notifications_enabled, haptic_enabled } = req.body;

  // Ensure row exists
  const existing = db.prepare('SELECT id FROM user_preferences WHERE user_id=?').get(req.session.userId);
  if (!existing) {
    db.prepare('INSERT INTO user_preferences (user_id) VALUES (?)').run(req.session.userId);
  }

  const fields = [];
  const values = [];
  if (sound_enabled !== undefined) { fields.push('sound_enabled=?'); values.push(sound_enabled ? 1 : 0); }
  if (sound_volume !== undefined) { fields.push('sound_volume=?'); values.push(Math.max(0, Math.min(100, parseInt(sound_volume) || 80))); }
  if (music_enabled !== undefined) { fields.push('music_enabled=?'); values.push(music_enabled ? 1 : 0); }
  if (music_volume !== undefined) { fields.push('music_volume=?'); values.push(Math.max(0, Math.min(100, parseInt(music_volume) || 50))); }
  if (notifications_enabled !== undefined) { fields.push('notifications_enabled=?'); values.push(notifications_enabled ? 1 : 0); }
  if (haptic_enabled !== undefined) { fields.push('haptic_enabled=?'); values.push(haptic_enabled ? 1 : 0); }

  if (fields.length > 0) {
    fields.push("updated_at=datetime('now')");
    values.push(req.session.userId);
    db.prepare('UPDATE user_preferences SET ' + fields.join(',') + ' WHERE user_id=?').run(...values);
  }

  res.json({ success: true });
});

// ─── GAME FAVORITES ──────────────────────────────────────

// GET /api/game/favorites
router.get('/favorites', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not auth' });
  const favorites = db.prepare('SELECT game_id FROM favorites WHERE user_id=?').all(req.session.userId);
  res.json({ favorites: favorites.map(f => f.game_id) });
});

// POST /api/game/favorites/toggle
router.post('/favorites/toggle', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not auth' });
  const { gameId } = req.body;
  if (!gameId) return res.status(400).json({ error: 'Missing gameId' });

  const existing = db.prepare('SELECT id FROM favorites WHERE user_id=? AND game_id=?').get(req.session.userId, gameId);
  if (existing) {
    db.prepare('DELETE FROM favorites WHERE id=?').run(existing.id);
    res.json({ favorited: false });
  } else {
    db.prepare('INSERT INTO favorites (user_id, game_id) VALUES (?,?)').run(req.session.userId, gameId);
    res.json({ favorited: true });
  }
});

module.exports = router;
