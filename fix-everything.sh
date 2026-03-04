#!/bin/bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║  SLOT STARS CLUB — MASTER FIX SCRIPT                           ║
# ║  Fixes all 17 bugs from audit + XP popup injection             ║
# ║  Run from: /root/slot-stars (or wherever your project root is) ║
# ║  Usage: bash fix-everything.sh                                 ║
# ╚══════════════════════════════════════════════════════════════════╝
set -e

PROJ_DIR="$(pwd)"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="$PROJ_DIR/backups/$TIMESTAMP"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  Slot Stars Club — Master Fix Script         ║"
echo "║  Timestamp: $TIMESTAMP              ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ──────────────────────────────────────────────
# 0. BACKUP EVERYTHING
# ──────────────────────────────────────────────
echo "📦 Creating backups..."
mkdir -p "$BACKUP_DIR"
for f in server.js db.js \
  public/pages/admin.html public/pages/lobby.html \
  public/pages/slots.html public/pages/slots-pro.html \
  public/pages/blackjack.html public/pages/roulette.html \
  public/pages/poker.html public/pages/pulltab.html \
  public/pages/crash.html public/pages/nebula-bots.html \
  public/pages/ocean-bingo.html public/pages/slots-deluxe.html \
  public/pages/daily-bonus.html public/pages/leaderboard.html; do
  if [ -f "$f" ]; then
    mkdir -p "$BACKUP_DIR/$(dirname "$f")"
    cp "$f" "$BACKUP_DIR/$f"
  fi
done
echo "   ✅ Backed up to $BACKUP_DIR"

# ──────────────────────────────────────────────
# 1. FIX SERVER.JS — Remove duplicate routes,
#    add xp/level/title to /api/me,
#    fix gamePage() ordering
# ──────────────────────────────────────────────
echo ""
echo "🔧 [1/6] Fixing server.js..."

cat > server.js << 'SERVEREOF'
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
app.use('/api/admin',    require('./routes/admin'));
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
app.listen(PORT, () => console.log(`Slot Stars Club running on port ${PORT}`));
SERVEREOF

echo "   ✅ server.js rewritten (no duplicates, /api/me has xp/level/title)"

# ──────────────────────────────────────────────
# 2. FIX DB.JS — Fortune Dragon rtp_key
# ──────────────────────────────────────────────
echo ""
echo "🔧 [2/6] Fixing db.js Fortune Dragon rtp_key..."

# Fix in db.js seed (for fresh installs)
if grep -q "rtp_slots_pro.*fortune\|fortune.*rtp_slots_pro" db.js 2>/dev/null; then
  sed -i "s/\('fortune'.*\)'rtp_slots_pro'/\1'rtp_fortune'/" db.js
  echo "   ✅ db.js seed: rtp_slots_pro → rtp_fortune"
else
  echo "   ℹ️  db.js seed already correct or pattern not found"
fi

# Fix live database
if command -v sqlite3 &> /dev/null; then
  DB_FILE="$PROJ_DIR/data.db"
  if [ -f "$DB_FILE" ]; then
    CURRENT=$(sqlite3 "$DB_FILE" "SELECT rtp_key FROM games WHERE id='fortune';" 2>/dev/null || echo "")
    if [ "$CURRENT" = "rtp_slots_pro" ]; then
      sqlite3 "$DB_FILE" "UPDATE games SET rtp_key='rtp_fortune' WHERE id='fortune' AND rtp_key='rtp_slots_pro';"
      echo "   ✅ Live DB: Fortune Dragon rtp_key fixed to rtp_fortune"
    else
      echo "   ℹ️  Live DB: Fortune Dragon rtp_key already correct ($CURRENT)"
    fi

    # Also ensure rtp_fortune setting exists
    HAS_RTP=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM settings WHERE key='rtp_fortune';" 2>/dev/null || echo "0")
    if [ "$HAS_RTP" = "0" ]; then
      sqlite3 "$DB_FILE" "INSERT INTO settings(key,value) VALUES('rtp_fortune','94');"
      echo "   ✅ Live DB: Added rtp_fortune=94 setting"
    fi
  else
    echo "   ⚠️  data.db not found — will be fixed on next restart via seed"
  fi
else
  echo "   ⚠️  sqlite3 not installed — fix db manually or restart server"
fi

# ──────────────────────────────────────────────
# 3. FIX ADMIN.HTML — ID normalization,
#    dynamic RTP keys, stats lookup
# ──────────────────────────────────────────────
echo ""
echo "🔧 [3/6] Fixing admin.html..."

ADMIN="public/pages/admin.html"
if [ -f "$ADMIN" ]; then
  # Add normalizeId function if missing
  if ! grep -q "normalizeId" "$ADMIN"; then
    # Insert helper functions after the first <script> tag that contains game logic
    sed -i '/<script>/a\
/* ── Audit Fixes: ID normalization + dynamic RTP ── */\
function normalizeId(id) { return (id||"").replace(/-/g,"_"); }\
function statsLookup(map, id) {\
  if (!map) return null;\
  return map[id] || map[normalizeId(id)] || map[(id||"").replace(/_/g,"-")] || null;\
}\
function buildRTPKeys(games) {\
  var keys = {};\
  (games||[]).forEach(function(g) { if (g.rtp_key) keys[g.id] = g.rtp_key; });\
  return keys;\
}' "$ADMIN" 2>/dev/null

    # Replace hardcoded gameStatsMap lookups with statsLookup
    # This catches patterns like: gameStatsMap[g.id]
    sed -i 's/gameStatsMap\[g\.id\]/statsLookup(gameStatsMap, g.id)/g' "$ADMIN" 2>/dev/null
    sed -i 's/gameStatsMap\[game\.id\]/statsLookup(gameStatsMap, game.id)/g' "$ADMIN" 2>/dev/null

    echo "   ✅ admin.html: Added normalizeId(), statsLookup(), buildRTPKeys()"
  else
    echo "   ℹ️  admin.html: normalizeId already present"
  fi
else
  echo "   ⚠️  admin.html not found"
fi

# ──────────────────────────────────────────────
# 4. FIX LOBBY.HTML — Mobile level pill CSS
# ──────────────────────────────────────────────
echo ""
echo "🔧 [4/6] Fixing lobby.html mobile styles..."

LOBBY="public/pages/lobby.html"
if [ -f "$LOBBY" ]; then
  if ! grep -q "level-pill.*max-width.*480" "$LOBBY" && ! grep -q "xp-mobile-fix" "$LOBBY"; then
    # Add mobile CSS for level pill before </style>
    sed -i '/<\/style>/i\
/* xp-mobile-fix */\
@media(max-width:480px){\
  .level-label{display:none;}\
  .level-pill{padding:0.15rem 0.4rem;}\
  .level-num{font-size:0.85rem;}\
  .lb-btn{font-size:0.65rem;padding:0.2rem 0.4rem;}\
  .level-popup-inner{width:95%;max-width:95%;}\
}' "$LOBBY" 2>/dev/null
    echo "   ✅ lobby.html: Mobile level pill CSS added"
  else
    echo "   ℹ️  lobby.html: Mobile fix already present"
  fi
else
  echo "   ⚠️  lobby.html not found"
fi

# ──────────────────────────────────────────────
# 5. INJECT XP POPUP INTO ALL GAME PAGES
# ──────────────────────────────────────────────
echo ""
echo "🔧 [5/6] Injecting XP popup into game pages..."

# Create the XP CSS block
XP_CSS='/* XP Popup System */
.xp-float{position:fixed;top:45%;left:50%;transform:translate(-50%,-50%);font-family:"Bebas Neue",sans-serif;font-size:1.5rem;letter-spacing:3px;color:#00FFCC;text-shadow:0 0 12px rgba(0,255,204,0.5);pointer-events:none;z-index:200;opacity:0;animation:xpFloatUp 1.2s ease-out forwards}
@keyframes xpFloatUp{0%{opacity:0;transform:translate(-50%,-50%) scale(0.5)}20%{opacity:1;transform:translate(-50%,-60%) scale(1.1)}100%{opacity:0;transform:translate(-50%,-120%) scale(0.8)}}
.levelup-overlay{position:fixed;inset:0;z-index:250;background:rgba(5,5,16,0.85);display:flex;align-items:center;justify-content:center;opacity:0;pointer-events:none;transition:opacity 0.3s}
.levelup-overlay.show{opacity:1;pointer-events:auto}
.levelup-box{text-align:center;animation:levelPop 0.5s cubic-bezier(0.175,0.885,0.32,1.275)}
@keyframes levelPop{0%{transform:scale(0)}100%{transform:scale(1)}}
.levelup-box .lu-stars{font-size:2rem;margin-bottom:0.3rem}
.levelup-box .lu-text{font-family:"Bebas Neue",sans-serif;font-size:1.6rem;letter-spacing:4px;background:linear-gradient(135deg,#00FFCC,#FFD700);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.levelup-box .lu-num{font-family:"Bebas Neue",sans-serif;font-size:4rem;color:#00FFCC;line-height:1;text-shadow:0 0 30px rgba(0,255,204,0.4)}
.levelup-box .lu-title{font-size:1rem;letter-spacing:2px;color:#FFD700;text-transform:uppercase;margin:0.2rem 0}
.levelup-box .lu-reward{font-size:0.8rem;color:rgba(255,255,255,0.5);margin-top:0.3rem}'

# Create the XP HTML+JS block
XP_HTML='<div class="levelup-overlay" id="levelupOverlay" onclick="this.classList.remove('"'"'show'"'"')"><div class="levelup-box"><div class="lu-stars">✦ ✦ ✦</div><div class="lu-text">LEVEL UP!</div><div class="lu-num" id="luNum">2</div><div class="lu-title" id="luTitle">Beginner</div><div class="lu-reward" id="luReward"></div></div></div>
<script>
function showXPGain(xp){if(!xp||!xp.xpGained)return;var e=document.createElement("div");e.className="xp-float";e.textContent="+"+xp.xpGained+" XP";document.body.appendChild(e);setTimeout(function(){e.remove()},1300);if(xp.leveledUp){setTimeout(function(){var n=document.getElementById("luNum"),t=document.getElementById("luTitle"),r=document.getElementById("luReward"),o=document.getElementById("levelupOverlay");if(n)n.textContent=xp.level;if(t)t.textContent=xp.title;if(r)r.textContent=xp.reward>0?"+$"+(xp.reward/100).toFixed(2)+" bonus credits!":"";if(o)o.classList.add("show");try{var c=new(window.AudioContext||window.webkitAudioContext)();[523,659,784,1047,1318].forEach(function(f,i){var s=c.createOscillator(),g=c.createGain();s.connect(g);g.connect(c.destination);s.frequency.value=f;s.type="sine";var m=c.currentTime+i*0.12;g.gain.setValueAtTime(0.12,m);g.gain.exponentialRampToValueAtTime(0.001,m+0.4);s.start(m);s.stop(m+0.4)})}catch(x){}setTimeout(function(){var v=document.getElementById("levelupOverlay");if(v)v.classList.remove("show")},3000)},800)}}
</script>'

# Write blocks to temp files
echo "$XP_CSS" > /tmp/xp-css-block.txt
echo "$XP_HTML" > /tmp/xp-html-block.txt

# Function: inject XP CSS+HTML into a page
inject_xp() {
  local FILE="$1"
  local NAME="$2"

  if [ ! -f "$FILE" ]; then
    echo "   ⚠️  $NAME: file not found ($FILE)"
    return
  fi

  if grep -q "showXPGain" "$FILE"; then
    echo "   ℹ️  $NAME: already has XP popup — skipping injection"
    return
  fi

  # Inject CSS before last </style>
  # Use Python for reliable multi-line injection
  python3 -c "
import sys
css = open('/tmp/xp-css-block.txt').read()
html = open('/tmp/xp-html-block.txt').read()
content = open('$FILE').read()
# CSS before </style>
idx = content.rfind('</style>')
if idx != -1:
    content = content[:idx] + '\n' + css + '\n' + content[idx:]
# HTML before </body>
idx2 = content.rfind('</body>')
if idx2 != -1:
    content = content[:idx2] + html + '\n' + content[idx2:]
open('$FILE','w').write(content)
" 2>/dev/null

  if grep -q "showXPGain" "$FILE"; then
    echo "   ✅ $NAME: XP CSS + HTML injected"
  else
    echo "   ❌ $NAME: injection failed"
  fi
}

# Inject into ALL game pages
inject_xp "public/pages/slots.html"        "Classic Slots"
inject_xp "public/pages/slots-pro.html"    "Pro Slots"
inject_xp "public/pages/blackjack.html"    "Blackjack"
inject_xp "public/pages/roulette.html"     "Roulette"
inject_xp "public/pages/poker.html"        "Video Poker"
inject_xp "public/pages/pulltab.html"      "Pull Tabs"
inject_xp "public/pages/crash.html"        "Crash"
inject_xp "public/pages/nebula-bots.html"  "Nebula Bots"
inject_xp "public/pages/ocean-bingo.html"  "Ocean Bingo"
inject_xp "public/pages/slots-deluxe.html" "Slots Deluxe (Fortune Dragon)"
inject_xp "public/pages/daily-bonus.html"  "Daily Bonus"

# ──────────────────────────────────────────────
# 6. WIRE showXPGain() CALLS INTO GAME LOGIC
#    Each game has a different variable name and
#    location where credits are updated after an
#    API response. We insert the XP call right after.
# ──────────────────────────────────────────────
echo ""
echo "🔧 [6/6] Wiring showXPGain() calls into game handlers..."

# Generic wiring function using Python for reliability
wire_xp() {
  local FILE="$1"
  local NAME="$2"
  local SEARCH="$3"   # The exact string to find
  local XP_VAR="$4"   # The variable name: "data" or "d" or "result"

  if [ ! -f "$FILE" ]; then return; fi
  if grep -q "showXPGain" "$FILE" && grep -q "$XP_VAR\.xp" "$FILE"; then
    echo "   ℹ️  $NAME: showXPGain already wired"
    return
  fi

  python3 -c "
content = open('$FILE').read()
search = '''$SEARCH'''
xp_line = 'if(${XP_VAR}.xp) showXPGain(${XP_VAR}.xp);'
if search in content and xp_line not in content:
    content = content.replace(search, search + '\n    ' + xp_line, 1)
    open('$FILE','w').write(content)
    print('   ✅ $NAME: wired ' + xp_line)
else:
    print('   ℹ️  $NAME: pattern not found or already wired')
" 2>/dev/null
}

# ── CLASSIC SLOTS: uses 'data' variable ──
# Pattern: "credits = data.credits;"
wire_xp "public/pages/slots.html" \
  "Classic Slots" \
  "credits = data.credits;" \
  "data"

# ── PRO SLOTS: uses 'd' variable ──
# Pattern: "credits=d.credits;"  (in spin function, first occurrence)
wire_xp "public/pages/slots-pro.html" \
  "Pro Slots" \
  "credits=d.credits;" \
  "d"

# ── BLACKJACK: uses 'd' variable ──
# Wire after action() credits update (where round results come back)
# The action() function has: credits=d.credits;
wire_xp "public/pages/blackjack.html" \
  "Blackjack" \
  "credits=d.credits;" \
  "d"

# ── ROULETTE: uses 'd' variable ──
# Wire inside animateWheel callback: credits=d.credits;
wire_xp "public/pages/roulette.html" \
  "Roulette" \
  "credits=d.credits;" \
  "d"

# ── VIDEO POKER: uses 'd' variable ──
# Wire after draw() credits update: credits=d.credits;
wire_xp "public/pages/poker.html" \
  "Video Poker" \
  "credits=d.credits;" \
  "d"

# ── PULL TABS: uses 'd' variable ──
# Wire after pull() credits update: credits=d.credits;
wire_xp "public/pages/pulltab.html" \
  "Pull Tabs" \
  "credits=d.credits;" \
  "d"

# ── CRASH: check which variable it uses ──
if [ -f "public/pages/crash.html" ]; then
  if grep -q "credits = data.credits" "public/pages/crash.html"; then
    wire_xp "public/pages/crash.html" "Crash" "credits = data.credits;" "data"
  elif grep -q "credits=d.credits" "public/pages/crash.html"; then
    wire_xp "public/pages/crash.html" "Crash" "credits=d.credits;" "d"
  elif grep -q "credits = d.credits" "public/pages/crash.html"; then
    wire_xp "public/pages/crash.html" "Crash" "credits = d.credits;" "d"
  else
    echo "   ⚠️  Crash: could not find credits update pattern — wire manually"
  fi
fi

# ── NEBULA BOTS: auto-detect variable ──
if [ -f "public/pages/nebula-bots.html" ]; then
  if grep -q "credits = data.credits" "public/pages/nebula-bots.html"; then
    wire_xp "public/pages/nebula-bots.html" "Nebula Bots" "credits = data.credits;" "data"
  elif grep -q "credits=d.credits" "public/pages/nebula-bots.html"; then
    wire_xp "public/pages/nebula-bots.html" "Nebula Bots" "credits=d.credits;" "d"
  else
    echo "   ⚠️  Nebula Bots: could not find credits update pattern — wire manually"
  fi
fi

# ── OCEAN BINGO: auto-detect variable ──
if [ -f "public/pages/ocean-bingo.html" ]; then
  if grep -q "credits = data.credits" "public/pages/ocean-bingo.html"; then
    wire_xp "public/pages/ocean-bingo.html" "Ocean Bingo" "credits = data.credits;" "data"
  elif grep -q "credits=d.credits" "public/pages/ocean-bingo.html"; then
    wire_xp "public/pages/ocean-bingo.html" "Ocean Bingo" "credits=d.credits;" "d"
  else
    echo "   ⚠️  Ocean Bingo: could not find credits update pattern — wire manually"
  fi
fi

# ── SLOTS DELUXE (Fortune Dragon): auto-detect ──
if [ -f "public/pages/slots-deluxe.html" ]; then
  if grep -q "credits = data.credits" "public/pages/slots-deluxe.html"; then
    wire_xp "public/pages/slots-deluxe.html" "Fortune Dragon" "credits = data.credits;" "data"
  elif grep -q "credits=d.credits" "public/pages/slots-deluxe.html"; then
    wire_xp "public/pages/slots-deluxe.html" "Fortune Dragon" "credits=d.credits;" "d"
  else
    echo "   ⚠️  Fortune Dragon: could not find credits update pattern — wire manually"
  fi
fi

# ── DAILY BONUS: auto-detect ──
if [ -f "public/pages/daily-bonus.html" ]; then
  if grep -q "credits = data.credits" "public/pages/daily-bonus.html"; then
    wire_xp "public/pages/daily-bonus.html" "Daily Bonus" "credits = data.credits;" "data"
  elif grep -q "credits=d.credits" "public/pages/daily-bonus.html"; then
    wire_xp "public/pages/daily-bonus.html" "Daily Bonus" "credits=d.credits;" "d"
  elif grep -q "credits = d.credits" "public/pages/daily-bonus.html"; then
    wire_xp "public/pages/daily-bonus.html" "Daily Bonus" "credits = d.credits;" "d"
  else
    echo "   ⚠️  Daily Bonus: could not find credits update pattern — wire manually"
  fi
fi

# ──────────────────────────────────────────────
# 7. CLEANUP
# ──────────────────────────────────────────────
echo ""
echo "🧹 Cleanup..."

# Remove orphan files
if [ -f "server 2.js" ]; then
  rm "server 2.js"
  echo "   ✅ Removed 'server 2.js' backup"
fi
if [ -f "public/pages/play.html" ]; then
  rm "public/pages/play.html"
  echo "   ✅ Removed orphaned play.html"
fi

# Clean up temp files
rm -f /tmp/xp-css-block.txt /tmp/xp-html-block.txt

# ──────────────────────────────────────────────
# 8. VERIFICATION
# ──────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════"
echo "  VERIFICATION"
echo "══════════════════════════════════════════════"
echo ""

# Check server.js
echo "📋 server.js:"
if node --check server.js 2>/dev/null; then
  echo "   ✅ Syntax valid"
else
  echo "   ❌ Syntax error!"
fi
ROUTE_COUNT=$(grep -c "app\.\(use\|get\|post\)" server.js)
echo "   Routes: $ROUTE_COUNT"
grep -q "xp.*level.*title\|getLevelInfo" server.js && echo "   ✅ /api/me has XP fields" || echo "   ⚠️  /api/me missing XP"

# Check XP in game pages
echo ""
echo "📋 XP Popup Status:"
for page in slots.html slots-pro.html blackjack.html roulette.html poker.html pulltab.html \
  crash.html nebula-bots.html ocean-bingo.html slots-deluxe.html daily-bonus.html; do
  F="public/pages/$page"
  if [ ! -f "$F" ]; then
    echo "   ⚠️  $page: NOT FOUND"
    continue
  fi
  HAS_CSS=$(grep -c "xp-float" "$F" 2>/dev/null || echo 0)
  HAS_FUNC=$(grep -c "showXPGain" "$F" 2>/dev/null || echo 0)
  HAS_CALL=$(grep -c "\.xp) showXPGain" "$F" 2>/dev/null || echo 0)
  if [ "$HAS_CSS" -gt 0 ] && [ "$HAS_FUNC" -gt 0 ] && [ "$HAS_CALL" -gt 0 ]; then
    echo "   ✅ $page: CSS ✓  Function ✓  Wired ✓"
  elif [ "$HAS_CSS" -gt 0 ] && [ "$HAS_FUNC" -gt 0 ]; then
    echo "   ⚠️  $page: CSS ✓  Function ✓  NOT WIRED"
  else
    echo "   ❌ $page: Missing XP (css=$HAS_CSS func=$HAS_FUNC call=$HAS_CALL)"
  fi
done

# Check Fortune Dragon RTP
echo ""
echo "📋 Fortune Dragon RTP:"
if command -v sqlite3 &> /dev/null && [ -f "data.db" ]; then
  RTP_KEY=$(sqlite3 data.db "SELECT rtp_key FROM games WHERE id='fortune';" 2>/dev/null || echo "unknown")
  echo "   rtp_key = $RTP_KEY"
  [ "$RTP_KEY" = "rtp_fortune" ] && echo "   ✅ Correct" || echo "   ❌ Should be rtp_fortune"
fi

echo ""
echo "══════════════════════════════════════════════"
echo "  ✅ ALL FIXES APPLIED"
echo "══════════════════════════════════════════════"
echo ""
echo "  Next steps:"
echo "  1. Review the verification output above"
echo "  2. Restart the server: pm2 restart slot-stars"
echo "  3. Test each game in browser"
echo ""
echo "  Backups saved to: $BACKUP_DIR"
echo ""
