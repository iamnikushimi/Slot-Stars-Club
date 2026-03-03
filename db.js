const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, 'data.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE, password TEXT,
    role TEXT DEFAULT 'player', credits INTEGER DEFAULT 500, reseller_credits INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, credits INTEGER DEFAULT 1000, used INTEGER DEFAULT 0, created_by INTEGER);
  CREATE TABLE IF NOT EXISTS spins (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, game TEXT DEFAULT 'slots',
    bet INTEGER, result TEXT, payout INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS crash_rounds (id INTEGER PRIMARY KEY AUTOINCREMENT, crash_point INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT DEFAULT 'slots',
    route TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    icon TEXT DEFAULT '🎰',
    rtp_key TEXT,
    sort_order INTEGER DEFAULT 99,
    description TEXT DEFAULT '',
    tags TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS page_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id TEXT,
    user_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS jackpot_winners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER, username TEXT,
    game TEXT, jackpot_type TEXT,
    amount INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS active_sessions (
    user_id INTEGER PRIMARY KEY,
    game_id TEXT,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Schema migrations — add new columns to existing databases
try { db.exec(`ALTER TABLE games ADD COLUMN description TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE games ADD COLUMN tags TEXT DEFAULT ''`); } catch(e) {}

// Clean up stale active sessions on startup
db.exec(`DELETE FROM active_sessions WHERE last_seen < datetime('now','-10 minutes')`);

// Seed default games if table is empty
const gameCount = db.prepare('SELECT COUNT(*) as c FROM games').get();
if (gameCount.c === 0) {
  const insertGame = db.prepare('INSERT OR IGNORE INTO games (id,name,category,route,status,icon,rtp_key,sort_order,description,tags) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const games = [
    ['slots',       'Classic Slots',    'slots',   '/play/slots',       'active', '🎰', 'rtp_slots',      1, '3-reel, 6 symbols. Up to 50× your bet.', 'Popular'],
    ['slots-pro',   'Pro Slots',        'slots',   '/play/slots-pro',   'active', '⭐', 'rtp_slots_pro',  2, '5-reel + Wilds. Mini, Major & Grand jackpots.', 'Jackpots'],
    ['fortune',     'Fortune Dragon',   'slots',   '/play/fortune',     'active', '🐉', 'rtp_slots_pro',  3, '5×3 reel · Expanding Wilds · Free Spins · 20 Paylines', 'Featured,Free Spins'],
    ['nebula-bots', 'Nebula Bots',      'slots',   '/play/nebula-bots', 'active', '🤖', 'rtp_nebula',     4, 'Boost Meter · Stacked Multipliers · Free Spins', 'New,Boost ×10'],
    ['ocean-bingo', 'Ocean Bingo',      'slots',   '/play/ocean-bingo', 'active', '🌊', 'rtp_ocean',      5, 'Dual-mode: Slots + Bingo Blitz. Underwater theme.', 'New'],
    ['crash',       'Crash Out',        'live',    '/play/crash',       'active', '📈', 'rtp_crash',      6, 'Set cashout, watch it fly. Don\'t get greedy.', 'High Risk'],
    ['blackjack',   'Blackjack',        'cards',   '/play/blackjack',   'active', '🃏', 'rtp_blackjack',  7, 'Hit, stand, or double down. Beat the dealer.', 'New'],
    ['roulette',    'Roulette',         'live',    '/play/roulette',    'active', '🎡', 'rtp_roulette',   8, 'European roulette. Straights pay 36×.', 'New'],
    ['poker',       'Video Poker',      'cards',   '/play/poker',       'active', '♠️', 'rtp_poker',      9, 'Jacks or Better. Royal Flush pays 800×.', 'New'],
    ['pulltab',     'Pull Tabs',        'instant', '/play/pulltab',     'active', '🎟️', 'rtp_pulltab',  10, 'Scratch & reveal. Instant win tickets.', 'New'],
  ];
  for (const g of games) insertGame.run(...g);
}

const defaults = {
  rtp_slots:'96', rtp_slots_pro:'94', rtp_jackpot:'94', rtp_crash:'95',
  rtp_blackjack:'99', rtp_roulette:'97', rtp_poker:'96', rtp_pulltab:'95',
  rtp_fortune:'92', rtp_nebula:'94', rtp_ocean:'94',
  min_bet:'10', max_bet:'10000', crash_max_mult:'100',
  jackpot_mini:'50000', jackpot_major:'500000', jackpot_grand:'2000000',
  jackpot_mini_seed:'50000', jackpot_major_seed:'500000', jackpot_grand_seed:'2000000',
};
const ins = db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)');
for (const [k,v] of Object.entries(defaults)) ins.run(k,v);

db.getSetting    = (key) => { const r=db.prepare('SELECT value FROM settings WHERE key=?').get(key); return r?r.value:null; };
db.getSettingNum = (key) => parseFloat(db.getSetting(key)||0);

const bcrypt = require('bcryptjs');
const adminExists = db.prepare('SELECT id FROM users WHERE username=?').get('admin');
if (!adminExists) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO users (username,password,role,credits) VALUES (?,?,?,?)').run('admin',hash,'admin',999900);
  console.log('Admin created: admin / admin123');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS daily_bonus (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    day_streak INTEGER DEFAULT 1,
    prize_amount INTEGER NOT NULL,
    prize_label TEXT NOT NULL,
    claimed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_daily_bonus_user ON daily_bonus(user_id);
`);

module.exports = db;
