const express = require('express');
const router = express.Router();
const db = require('../db');

// ── Ensure tables ──
try { db.exec(`
  CREATE TABLE IF NOT EXISTS tournaments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    game TEXT DEFAULT 'all',
    type TEXT DEFAULT 'most_wins',
    entry_fee INTEGER DEFAULT 0,
    prize_pool INTEGER DEFAULT 0,
    max_players INTEGER DEFAULT 100,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    status TEXT DEFAULT 'upcoming',
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );
`); } catch(e) {}

try { db.exec(`
  CREATE TABLE IF NOT EXISTS tournament_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    score INTEGER DEFAULT 0,
    rounds_played INTEGER DEFAULT 0,
    total_wagered INTEGER DEFAULT 0,
    total_won INTEGER DEFAULT 0,
    biggest_win INTEGER DEFAULT 0,
    joined_at TEXT DEFAULT (datetime('now')),
    UNIQUE(tournament_id, user_id)
  );
`); } catch(e) {}

try { db.exec(`
  CREATE TABLE IF NOT EXISTS tournament_prizes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER NOT NULL,
    place INTEGER NOT NULL,
    user_id INTEGER,
    username TEXT,
    amount INTEGER NOT NULL,
    paid INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
`); } catch(e) {}

// Tournament types and scoring
const SCORING = {
  most_wins:    { label: 'Most Wins',       scoreField: 'wins',      desc: 'Player with the most winning rounds' },
  highest_win:  { label: 'Highest Win',     scoreField: 'best_win',  desc: 'Player with the single biggest win' },
  most_wagered: { label: 'Most Wagered',    scoreField: 'wagered',   desc: 'Player who wagers the most' },
  most_rounds:  { label: 'Most Rounds',     scoreField: 'rounds',    desc: 'Player who plays the most rounds' },
  best_profit:  { label: 'Best Profit',     scoreField: 'profit',    desc: 'Player with highest profit (wins - bets)' },
};

// ── Auto-activate/finalize tournaments ──
function updateTournamentStatuses() {
  const now = new Date().toISOString();
  // Activate upcoming tournaments that have started
  db.prepare("UPDATE tournaments SET status='active' WHERE status='upcoming' AND starts_at <= ?").run(now);
  // Finalize active tournaments that have ended
  const ended = db.prepare("SELECT id FROM tournaments WHERE status='active' AND ends_at <= ?").all(now);
  ended.forEach(t => finalizeTournament(t.id));
}

function finalizeTournament(tournamentId) {
  const tournament = db.prepare('SELECT * FROM tournaments WHERE id=?').get(tournamentId);
  if (!tournament) return;

  // Get top 3 players
  const entries = db.prepare('SELECT * FROM tournament_entries WHERE tournament_id=? ORDER BY score DESC LIMIT 3').all(tournamentId);
  if (!entries.length) {
    db.prepare("UPDATE tournaments SET status='completed'").run();
    return;
  }

  // Prize distribution: 50% / 30% / 20%
  const pool = tournament.prize_pool;
  const splits = [0.5, 0.3, 0.2];

  entries.forEach((entry, i) => {
    const amount = Math.round(pool * splits[i]);
    if (amount > 0) {
      const user = db.prepare('SELECT username FROM users WHERE id=?').get(entry.user_id);
      db.prepare('INSERT INTO tournament_prizes (tournament_id, place, user_id, username, amount) VALUES (?,?,?,?,?)').run(
        tournamentId, i + 1, entry.user_id, user?.username || 'Player', amount
      );
      // Pay out
      db.prepare('UPDATE users SET credits = credits + ? WHERE id=?').run(amount, entry.user_id);
      db.prepare('UPDATE tournament_prizes SET paid=1 WHERE tournament_id=? AND place=?').run(tournamentId, i + 1);
    }
  });

  db.prepare("UPDATE tournaments SET status='completed' WHERE id=?").run(tournamentId);

  // Add to live feed
  try {
    const winner = db.prepare('SELECT username FROM users WHERE id=?').get(entries[0].user_id);
    db.prepare('INSERT INTO live_feed (user_id, username, event_type, detail, amount) VALUES (?,?,?,?,?)').run(
      entries[0].user_id, winner?.username || 'Player', 'tournament_win',
      tournament.name, Math.round(pool * splits[0]) / 100
    );
  } catch(e) {}
}

// ── Record a spin for active tournaments ──
function recordTournamentSpin(userId, game, bet, payout) {
  updateTournamentStatuses();

  const activeTournaments = db.prepare("SELECT id, game, type FROM tournaments WHERE status='active'").all();

  activeTournaments.forEach(t => {
    // Check if game matches
    if (t.game !== 'all' && t.game !== game) return;

    // Check if user is entered
    const entry = db.prepare('SELECT id, score, rounds_played, total_wagered, total_won, biggest_win FROM tournament_entries WHERE tournament_id=? AND user_id=?').get(t.id, userId);
    if (!entry) return;

    // Update stats
    const won = payout > 0 ? 1 : 0;
    const newBiggest = Math.max(entry.biggest_win, payout);

    let newScore = entry.score;
    if (t.type === 'most_wins') newScore += won;
    else if (t.type === 'highest_win') newScore = Math.max(newScore, payout);
    else if (t.type === 'most_wagered') newScore += bet;
    else if (t.type === 'most_rounds') newScore += 1;
    else if (t.type === 'best_profit') newScore += (payout - bet);

    db.prepare(`UPDATE tournament_entries SET 
      score=?, rounds_played=rounds_played+1, 
      total_wagered=total_wagered+?, total_won=total_won+?,
      biggest_win=? WHERE id=?
    `).run(newScore, bet, payout, newBiggest, entry.id);
  });
}

// ══════════════════════════════════════════════════════
// PLAYER API
// ══════════════════════════════════════════════════════

// GET /api/game/tournaments — list active & upcoming
router.get('/tournaments', (req, res) => {
  updateTournamentStatuses();

  const tournaments = db.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM tournament_entries WHERE tournament_id=t.id) as player_count
    FROM tournaments t
    WHERE t.status IN ('active','upcoming')
    ORDER BY t.starts_at ASC
  `).all();

  // Add user's entry status
  const userId = req.session?.userId;
  tournaments.forEach(t => {
    t.prize_pool_display = t.prize_pool / 100;
    t.entry_fee_display = t.entry_fee / 100;
    t.scoring = SCORING[t.type] || SCORING.most_wins;
    if (userId) {
      const entry = db.prepare('SELECT score, rounds_played FROM tournament_entries WHERE tournament_id=? AND user_id=?').get(t.id, userId);
      t.entered = !!entry;
      t.myScore = entry?.score || 0;
      t.myRounds = entry?.rounds_played || 0;
    }
  });

  res.json({ tournaments });
});

// GET /api/game/tournaments/:id — tournament details + leaderboard
router.get('/tournaments/:id', (req, res) => {
  updateTournamentStatuses();
  const t = db.prepare('SELECT * FROM tournaments WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });

  t.prize_pool_display = t.prize_pool / 100;
  t.entry_fee_display = t.entry_fee / 100;
  t.scoring = SCORING[t.type] || SCORING.most_wins;

  const leaderboard = db.prepare(`
    SELECT te.*, u.username
    FROM tournament_entries te JOIN users u ON te.user_id = u.id
    WHERE te.tournament_id = ?
    ORDER BY te.score DESC LIMIT 50
  `).all(req.params.id);

  leaderboard.forEach(e => {
    e.total_wagered = e.total_wagered / 100;
    e.total_won = e.total_won / 100;
    e.biggest_win = e.biggest_win / 100;
  });

  // Prizes if completed
  let prizes = [];
  if (t.status === 'completed') {
    prizes = db.prepare('SELECT * FROM tournament_prizes WHERE tournament_id=? ORDER BY place').all(req.params.id);
    prizes.forEach(p => p.amount = p.amount / 100);
  }

  const userId = req.session?.userId;
  if (userId) {
    const entry = db.prepare('SELECT * FROM tournament_entries WHERE tournament_id=? AND user_id=?').get(t.id, userId);
    t.entered = !!entry;
    t.myScore = entry?.score || 0;
    t.myRank = leaderboard.findIndex(e => e.user_id === userId) + 1;
  }

  res.json({ tournament: t, leaderboard, prizes });
});

// POST /api/game/tournaments/:id/join — enter a tournament
router.post('/tournaments/:id/join', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });

  const t = db.prepare('SELECT * FROM tournaments WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (t.status !== 'active' && t.status !== 'upcoming') return res.status(400).json({ error: 'Tournament not open for entries' });

  // Check if already entered
  const existing = db.prepare('SELECT id FROM tournament_entries WHERE tournament_id=? AND user_id=?').get(t.id, req.session.userId);
  if (existing) return res.status(400).json({ error: 'Already entered' });

  // Check max players
  const count = db.prepare('SELECT COUNT(*) as c FROM tournament_entries WHERE tournament_id=?').get(t.id).c;
  if (count >= t.max_players) return res.status(400).json({ error: 'Tournament is full' });

  // Charge entry fee
  if (t.entry_fee > 0) {
    const user = db.prepare('SELECT credits FROM users WHERE id=?').get(req.session.userId);
    if (!user || user.credits < t.entry_fee) return res.status(400).json({ error: 'Not enough credits for entry fee' });
    db.prepare('UPDATE users SET credits = credits - ? WHERE id=?').run(t.entry_fee, req.session.userId);
    // Add to prize pool
    db.prepare('UPDATE tournaments SET prize_pool = prize_pool + ? WHERE id=?').run(t.entry_fee, t.id);
  }

  db.prepare('INSERT INTO tournament_entries (tournament_id, user_id) VALUES (?,?)').run(t.id, req.session.userId);

  res.json({ success: true, message: 'Entered tournament!' });
});

// GET /api/game/tournaments/history — past tournaments
router.get('/tournaments-history', (req, res) => {
  const tournaments = db.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM tournament_entries WHERE tournament_id=t.id) as player_count
    FROM tournaments t
    WHERE t.status = 'completed'
    ORDER BY t.ends_at DESC LIMIT 20
  `).all();

  tournaments.forEach(t => {
    t.prize_pool_display = t.prize_pool / 100;
    const winner = db.prepare('SELECT username, amount FROM tournament_prizes WHERE tournament_id=? AND place=1').get(t.id);
    t.winner = winner ? { username: winner.username, amount: winner.amount / 100 } : null;
  });

  res.json({ tournaments });
});

// ══════════════════════════════════════════════════════
// ADMIN API
// ══════════════════════════════════════════════════════

function requireAdmin(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not auth' });
  const user = db.prepare('SELECT role FROM users WHERE id=?').get(req.session.userId);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// POST /api/game/tournaments/create
router.post('/tournaments/create', requireAdmin, (req, res) => {
  const { name, game, type, entryFee, prizePool, maxPlayers, startsAt, endsAt } = req.body;
  if (!name || !startsAt || !endsAt) return res.status(400).json({ error: 'Missing fields' });

  const result = db.prepare(`INSERT INTO tournaments (name, game, type, entry_fee, prize_pool, max_players, starts_at, ends_at, created_by) VALUES (?,?,?,?,?,?,?,?,?)`).run(
    name, game || 'all', type || 'most_wins',
    Math.round((entryFee || 0) * 100), Math.round((prizePool || 0) * 100),
    maxPlayers || 100, startsAt, endsAt, req.session.userId
  );

  res.json({ success: true, id: result.lastInsertRowid });
});

// POST /api/game/tournaments/:id/cancel
router.post('/tournaments/:id/cancel', requireAdmin, (req, res) => {
  const t = db.prepare('SELECT * FROM tournaments WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });

  // Refund entry fees
  if (t.entry_fee > 0) {
    const entries = db.prepare('SELECT user_id FROM tournament_entries WHERE tournament_id=?').all(t.id);
    entries.forEach(e => {
      db.prepare('UPDATE users SET credits = credits + ? WHERE id=?').run(t.entry_fee, e.user_id);
    });
  }

  db.prepare("UPDATE tournaments SET status='cancelled' WHERE id=?").run(t.id);
  res.json({ success: true, message: 'Tournament cancelled, fees refunded' });
});

module.exports = router;
module.exports.recordTournamentSpin = recordTournamentSpin;
module.exports.SCORING = SCORING;
