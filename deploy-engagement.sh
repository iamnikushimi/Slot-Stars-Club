#!/bin/bash
# ══════════════════════════════════════════════════════════════
# Deploy Player Engagement Batch 1
# Referrals, Achievements, Live Feed, Tournaments
# ══════════════════════════════════════════════════════════════
set -e
cd /root/slot-stars

echo "═══ Deploying Player Engagement Features ═══"
echo ""

# ── Backup ──
BACKUP="backups/engage_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP"
cp server.js "$BACKUP/"
cp routes/game.js "$BACKUP/"
echo "✓ Backed up to $BACKUP"

# ── 1. Check route files exist ──
for f in routes/referrals.js routes/achievements.js routes/tournaments.js; do
  if [ ! -f "$f" ]; then
    echo "ERROR: $f not found. Upload it first."
    exit 1
  fi
done
echo "✓ All route files present"

# ── 2. Register routes in server.js ──
if grep -q "referrals" server.js; then
  echo "✓ Referral routes already registered"
else
  node -e "
    const fs = require('fs');
    let s = fs.readFileSync('server.js','utf8');
    const marker = \"app.use('/api/game',     require('./routes/daily-bonus'));\";
    if (s.includes(marker)) {
      s = s.replace(marker, marker + \"\\napp.use('/api/game',     require('./routes/referrals'));\\napp.use('/api/game',     require('./routes/achievements'));\\napp.use('/api/game',     require('./routes/tournaments'));\");
      fs.writeFileSync('server.js', s);
      console.log('✓ Routes registered in server.js');
    } else {
      console.error('ERROR: Could not find insertion marker in server.js');
      process.exit(1);
    }
  "
fi

# ── 3. Patch game.js to track achievements after spins ──
# Add achievement tracking to all spin endpoints
if grep -q "checkAfterSpin" routes/game.js; then
  echo "✓ Achievement tracking already in game.js"
else
  node -e "
    const fs = require('fs');
    let s = fs.readFileSync('routes/game.js','utf8');

    // Add require at top
    const reqLine = \"const router = express.Router();\";
    if (s.includes(reqLine) && !s.includes('achievements')) {
      s = s.replace(reqLine, reqLine + \"\\nvar achievementsModule = null;\\ntry { achievementsModule = require('./achievements'); } catch(e) { console.log('Achievements module not loaded:', e.message); }\\nvar tournamentsModule = null;\\ntry { tournamentsModule = require('./tournaments'); } catch(e) { console.log('Tournaments module not loaded:', e.message); }\");
    }

    // Find all res.json lines that return spin results and add achievement check before them
    // We need to add tracking calls. The safest approach is to add a helper function
    // and call it from each endpoint.

    // Add helper after the requires
    const helperCode = \"\\n// Achievement & tournament tracking helper\\nfunction trackSpin(userId, bet, payout, game) {\\n  try {\\n    var newAchievements = [];\\n    if (achievementsModule && achievementsModule.checkAfterSpin) {\\n      newAchievements = achievementsModule.checkAfterSpin(userId, bet, payout, game);\\n    }\\n    if (tournamentsModule && tournamentsModule.recordTournamentSpin) {\\n      tournamentsModule.recordTournamentSpin(userId, bet, payout, game);\\n    }\\n    return newAchievements;\\n  } catch(e) { console.error('Track spin error:', e.message); return []; }\\n}\\n\";

    if (!s.includes('trackSpin')) {
      // Insert after the tournament require
      const insertAfter = s.indexOf('tournamentsModule');
      if (insertAfter > -1) {
        const lineEnd = s.indexOf('\\n', s.indexOf('}', s.indexOf('tournamentsModule', insertAfter + 30)));
        s = s.slice(0, lineEnd + 1) + helperCode + s.slice(lineEnd + 1);
      }
    }

    fs.writeFileSync('routes/game.js', s);
    console.log('✓ Achievement/tournament tracking added to game.js');
  "
fi

# ── 4. Add pages route for new pages ──
if grep -q "referral" server.js && grep -q "achievements" server.js && grep -q "tournaments" server.js; then
  echo "Checking page routes..."
fi

node -e "
  const fs = require('fs');
  let s = fs.readFileSync('server.js','utf8');
  let changed = false;
  
  const pages = [
    ['/play/referrals',    'referrals.html'],
    ['/play/achievements', 'achievements.html'],
    ['/play/tournaments',  'tournaments.html'],
  ];
  
  pages.forEach(([route, file]) => {
    if (!s.includes(route)) {
      const marker = \"app.get('/play/leaderboard',\";
      if (s.includes(marker)) {
        s = s.replace(marker, \"app.get('\" + route + \"', page('\" + file + \"'));\\n\" + marker);
        changed = true;
      }
    }
  });
  
  if (changed) {
    fs.writeFileSync('server.js', s);
    console.log('✓ Page routes added');
  } else {
    console.log('✓ Page routes already present');
  }
"

# ── 5. Restart ──
echo ""
echo "Restarting PM2..."
pm2 restart all
sleep 2

# ── 6. Test endpoints ──
echo ""
echo "Testing endpoints..."
for ep in /api/game/referral /api/game/achievements /api/game/live-feed /api/game/tournaments; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000$ep)
  if [ "$CODE" = "401" ] || [ "$CODE" = "200" ]; then
    echo "  ✓ $ep → $CODE (OK)"
  else
    echo "  ✗ $ep → $CODE"
  fi
done

echo ""
echo "═══ Backend deployed! ═══"
echo ""
echo "Next steps:"
echo "  1. Upload the frontend pages (referrals.html, achievements.html, tournaments.html)"
echo "  2. Add trackSpin() calls to individual spin endpoints in game.js"
echo "     (The helper function is ready — just add 'var newAch = trackSpin(userId, bet, payout, \"game_name\");')"
echo "     before each res.json() in spin/bet handlers."
echo "  3. Add live feed widget to lobby.html"
echo ""
echo "To create a test tournament:"
echo "  curl -X POST http://localhost:3000/api/game/tournaments/create \\"
echo "    -H 'Content-Type: application/json' -b 'connect.sid=SESSION' \\"
echo "    -d '{\"name\":\"Launch Tournament\",\"type\":\"most_wins\",\"prizePool\":50,\"startsAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"endsAt\":\"$(date -u -d '+24 hours' +%Y-%m-%dT%H:%M:%SZ)\"}'"
