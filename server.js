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

app.use('/api/game', require('./routes/levels'));
app.use('/api/game', require('./routes/leaderboard'));
app.use('/api/game', require('./routes/daily-bonus'));
app.use('/api/admin', require('./routes/admin-extras'));
app.get('/api/broadcast', require('./routes/admin-extras').publicBroadcast);
app.get('/play/daily-bonus', gamePage('daily-bonus', 'daily-bonus.html'));
app.get('/play/leaderboard', gamePage('leaderboard', 'leaderboard.html'));

app.use('/api/game', require('./routes/daily-bonus'));
app.use('/api/admin', require('./routes/admin-extras'));
app.get('/api/broadcast', require('./routes/admin-extras').publicBroadcast);
app.get('/play/daily-bonus', gamePage('daily-bonus', 'daily-bonus.html'));

app.use('/api/auth',     require('./routes/auth'));
app.use('/api/game',     require('./routes/game'));
app.use('/api/admin',    require('./routes/admin'));
app.use('/api/reseller', require('./routes/reseller'));
app.use('/api/game', require('./routes/daily-bonus'));

app.get('/sitemap.xml', (req, res) => {
  res.header('Content-Type', 'application/xml');
  res.sendFile(__dirname + '/public/sitemap.xml');
});

app.get('/robots.txt', (req, res) => {
  res.header('Content-Type', 'text/plain');
  res.sendFile(__dirname + '/public/robots.txt');
});

app.get('/og-image.png', (req, res) => {
  res.sendFile(__dirname + '/public/og-image.png');
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const user = db.prepare('SELECT id,username,role,credits,reseller_credits FROM users WHERE id=?').get(req.session.userId);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(user);
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function page(p) {
  return function(req, res) {
    res.sendFile(path.join(__dirname, 'public/pages', p));
  };
}

// gamePage: checks the games table status before serving.
// Admins bypass the check so they can preview the game.
// If status = 'maintenance' or 'disabled', redirects to the maintenance page.
function gamePage(gameId, filename) {
  return function(req, res) {
    // Admins can always access
    if (req.session.userId) {
      const user = db.prepare('SELECT role FROM users WHERE id=?').get(req.session.userId);
      if (user && user.role === 'admin') {
        return res.sendFile(path.join(__dirname, 'public/pages', filename));
      }
    }

    // Check game status
    const game = db.prepare('SELECT status, name FROM games WHERE id=?').get(gameId);
    if (!game || game.status === 'active') {
      // Active (or not found in DB — default to serve)
      return res.sendFile(path.join(__dirname, 'public/pages', filename));
    }

    // Maintenance or disabled — redirect to maintenance page
    const encodedName = encodeURIComponent(game.name);
    return res.redirect(`/maintenance?status=${game.status}&game=${encodedName}`);
  };
}

// ─── Public pages ────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
app.get('/maintenance', page('maintenance.html'));
app.get('/admin',       page('admin.html'));
app.get('/reseller',    page('reseller.html'));

// ─── Lobby (shows game cards — filters inactive games client-side via API) ──
app.get('/play', page('lobby.html'));
app.get('/play/daily-bonus', gamePage('daily-bonus', 'daily-bonus.html'));

// ─── Game pages — all protected by gamePage() status check ──────────────────
app.get('/play/slots',      gamePage('slots',       'slots.html'));
app.get('/play/slots-pro',  gamePage('slots-pro',   'slots-pro.html'));
app.get('/play/fortune',    gamePage('fortune',     'slots-deluxe.html'));
app.get('/play/nebula-bots',gamePage('nebula-bots', 'nebula-bots.html'));
app.get('/play/ocean-bingo',gamePage('ocean-bingo', 'ocean-bingo.html'));
app.get('/play/crash',      gamePage('crash',       'crash.html'));
app.get('/play/blackjack',  gamePage('blackjack',   'blackjack.html'));
app.get('/play/roulette',   gamePage('roulette',    'roulette.html'));
app.get('/play/poker',      gamePage('poker',       'poker.html'));
app.get('/play/pulltab',    gamePage('pulltab',     'pulltab.html'));

// ─── Also block API spins when game is not active ────────────────────────────
// This prevents users who still have the game open from spinning after it's disabled.
function gameApiGuard(gameId) {
  return function(req, res, next) {
    const game = db.prepare('SELECT status FROM games WHERE id=?').get(gameId);
    if (!game || game.status === 'active') return next();
    // Admins bypass
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

// Inject API guards before the game routes handle the request
app.post('/api/game/spin',         gameApiGuard('slots'));
app.post('/api/game/spin-pro',     gameApiGuard('slots-pro'));
app.post('/api/game/spin-deluxe',  gameApiGuard('fortune'));
app.post('/api/game/spin-nebula',  gameApiGuard('nebula-bots'));
app.post('/api/game/spin-ocean',  gameApiGuard('ocean-bingo'));
app.post('/api/game/crash/bet',    gameApiGuard('crash'));
app.post('/api/game/blackjack/deal',   gameApiGuard('blackjack'));
app.post('/api/game/blackjack/action', gameApiGuard('blackjack'));
app.post('/api/game/roulette/spin',    gameApiGuard('roulette'));
app.post('/api/game/poker/deal',       gameApiGuard('poker'));
app.post('/api/game/poker/draw',       gameApiGuard('poker'));
app.post('/api/game/pulltab/pull',     gameApiGuard('pulltab'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌟 Slot Stars Club on http://localhost:${PORT}`));
