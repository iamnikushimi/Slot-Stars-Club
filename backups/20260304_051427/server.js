const express = require('express');
const session = require('express-session');
const path = require('path');
const db = require('./db');

express.static.mime.define({'application/vnd.android.package-archive': ['apk']});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'slot-stars-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24*60*60*1000 }
}));
// ── IP Logging Middleware ──
app.use((req, res, next) => {
  if (req.session && req.session.userId && req.path.startsWith('/api/')) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.headers['x-real-ip'] || req.connection.remoteAddress || req.ip;
    try {
      // Log IP at most once per hour per user
      const recent = db.prepare("SELECT id FROM ip_log WHERE user_id=? AND ip=? AND created_at > datetime('now','-1 hour')").get(req.session.userId, ip);
      if (!recent) {
        db.prepare('INSERT INTO ip_log (user_id, ip, user_agent) VALUES (?,?,?)').run(req.session.userId, ip, (req.headers['user-agent']||'').slice(0,200));
      }
    } catch(e) {}
  }
  next();
});
// ── Ban/Suspend Check Middleware ──
app.use((req, res, next) => {
  if (req.session && req.session.userId && req.path.startsWith('/api/') && !req.path.startsWith('/api/auth')) {
    try {
      const user = db.prepare('SELECT account_status, suspended_until, banned_until FROM users WHERE id=?').get(req.session.userId);
      if (user) {
        if (user.account_status === 'banned') {
          if (!user.banned_until || new Date(user.banned_until) > new Date()) {
            return res.status(403).json({ error: 'Account banned', banned: true });
          }
        }
        if (user.account_status === 'suspended') {
          if (!user.suspended_until || new Date(user.suspended_until) > new Date()) {
            return res.status(403).json({ error: 'Account suspended', suspended: true });
          }
        }
      }
    } catch(e) {}
  }
  next();
});



// ─── Helpers (must be before routes that use them) ──────────────
function page(p) {
  return function(req, res) {
    res.sendFile(path.join(__dirname, 'public/pages', p));
  };
}

function gamePage(gameId, filename) {
  return function(req, res) {
    if (req.session.userId) {
      const user = db.prepare('SELECT role FROM users WHERE id=?').get(req.session.userId);
      if (user && user.role === 'admin') {
        return res.sendFile(path.join(__dirname, 'public/pages', filename));
      }
    }
    const game = db.prepare('SELECT status, name FROM games WHERE id=?').get(gameId);
    if (!game || game.status === 'active') {
      return res.sendFile(path.join(__dirname, 'public/pages', filename));
    }
    const encodedName = encodeURIComponent(game.name);
    return res.redirect(`/maintenance?status=${game.status}&game=${encodedName}`);
  };
}

function gameApiGuard(gameId) {
  return function(req, res, next) {
    const game = db.prepare('SELECT status FROM games WHERE id=?').get(gameId);
    if (!game || game.status === 'active') return next();
    if (req.session.userId) {
      const user = db.prepare('SELECT role FROM users WHERE id=?').get(req.session.userId);
      if (user && user.role === 'admin') return next();
    }
    return res.status(403).json({
      error: game.status === 'maintenance'
        ? 'This game is currently under maintenance. Please try again later.'
        : 'This game is not available.'
    });
  };
}

// ─── API Routes (each mounted ONCE) ─────────────────────────────
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/game',     require('./routes/game'));
app.use('/api/game',     require('./routes/levels'));
app.use('/api/game',     require('./routes/leaderboard'));
app.use('/api/game',     require('./routes/daily-bonus'));
app.use('/api/admin',    require('./routes/admin'))
app.use('/api/admin', require('./routes/user-management'));;
app.use('/api/admin',    require('./routes/admin-extras'));
app.use('/api/reseller', require('./routes/reseller'));

// Public broadcast (no auth)
app.get('/api/broadcast', require('./routes/admin-extras').publicBroadcast);

// ─── /api/me — includes XP, level, title ────────────────────────
app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const user = db.prepare('SELECT id,username,role,credits,reseller_credits FROM users WHERE id=?').get(req.session.userId);
  if (!user) return res.status(404).json({ error: 'Not found' });

  // Attach XP/level info
  try {
    const levels = require('./routes/levels');
    if (levels.getLevelInfo) {
      const info = levels.getLevelInfo(user.id);
      user.xp = info.xp;
      user.level = info.level;
      user.title = info.title;
      user.xpNeeded = info.xpNeeded;
    }
  } catch(e) { /* levels module not available — skip */ }

  res.json(user);
});

// ─── Static & SEO ───────────────────────────────────────────────
app.get('/sitemap.xml', (req, res) => { res.header('Content-Type', 'application/xml'); res.sendFile(__dirname + '/public/sitemap.xml'); });
app.get('/robots.txt',  (req, res) => { res.header('Content-Type', 'text/plain'); res.sendFile(__dirname + '/public/robots.txt'); });
app.get('/og-image.png', (req, res) => { res.sendFile(__dirname + '/public/og-image.png'); });

// ─── Public Pages ───────────────────────────────────────────────
app.get('/',            (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
app.get('/maintenance', page('maintenance.html'));
app.get('/admin',       page('admin.html'));
app.get('/reseller',    page('reseller.html'));
app.get('/play',        page('lobby.html'));

// ─── Game Pages (each mounted ONCE) ────────────────────────────
app.get('/play/slots',       gamePage('slots',       'slots.html'));
app.get('/play/slots-pro',   gamePage('slots-pro',   'slots-pro.html'));
app.get('/play/fortune',     gamePage('fortune',     'slots-deluxe.html'));
app.get('/play/nebula-bots', gamePage('nebula-bots', 'nebula-bots.html'));
app.get('/play/ocean-bingo', gamePage('ocean-bingo', 'ocean-bingo.html'));
app.get('/play/crash',       gamePage('crash',       'crash.html'));
app.get('/play/blackjack',   gamePage('blackjack',   'blackjack.html'));
app.get('/play/roulette',    gamePage('roulette',    'roulette.html'));
app.get('/play/poker',       gamePage('poker',       'poker.html'));
app.get('/play/pulltab',     gamePage('pulltab',     'pulltab.html'));
app.get('/play/daily-bonus', gamePage('daily-bonus', 'daily-bonus.html'));
app.get('/play/leaderboard', gamePage('leaderboard', 'leaderboard.html'));

// ─── API Guards ─────────────────────────────────────────────────
app.post('/api/game/spin',              gameApiGuard('slots'));
app.post('/api/game/spin-pro',          gameApiGuard('slots-pro'));
app.post('/api/game/spin-deluxe',       gameApiGuard('fortune'));
app.post('/api/game/spin-nebula',       gameApiGuard('nebula-bots'));
app.post('/api/game/spin-ocean',        gameApiGuard('ocean-bingo'));
app.post('/api/game/crash/bet',         gameApiGuard('crash'));
app.post('/api/game/blackjack/deal',    gameApiGuard('blackjack'));
app.post('/api/game/blackjack/action',  gameApiGuard('blackjack'));
app.post('/api/game/roulette/spin',     gameApiGuard('roulette'));
app.post('/api/game/poker/deal',        gameApiGuard('poker'));
app.post('/api/game/poker/draw',        gameApiGuard('poker'));
app.post('/api/game/pulltab/pull',      gameApiGuard('pulltab'));

// ─── Start ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// ── Password Reset Page ──
app.get('/reset-password', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public/pages/reset-password.html'));
});
app.post('/api/auth/reset-password', (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: 'Missing fields' });
  if (newPassword.length < 4) return res.status(400).json({ error: 'Password too short' });
  try {
    const row = db.prepare("SELECT * FROM password_reset_tokens WHERE token=? AND expires_at > datetime('now') AND used=0").get(token);
    if (!row) return res.status(400).json({ error: 'Invalid or expired token' });
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE users SET password=? WHERE id=?').run(hash, row.user_id);
    db.prepare('UPDATE password_reset_tokens SET used=1 WHERE id=?').run(row.id);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`Slot Stars Club running on port ${PORT}`));
