#!/bin/bash
# ══════════════════════════════════════════════════════════════
# Deploy Batch 2 (Monetization) + Batch 3 (Polish)
# Promo Codes, Transaction History, Auto-Suspend, Charts,
# Sound Settings, Game Favorites
# ══════════════════════════════════════════════════════════════
set -e
cd /root/slot-stars

echo "═══ Deploying Batch 2+3 Features ═══"
echo ""

# ── Backup ──
BACKUP="backups/batch23_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP"
cp server.js "$BACKUP/"
cp routes/game.js "$BACKUP/"
echo "✓ Backed up to $BACKUP"

# ── Check files exist ──
for f in routes/monetization.js routes/preferences.js; do
  if [ ! -f "$f" ]; then
    echo "ERROR: $f not found. Upload it first."
    exit 1
  fi
done
echo "✓ All route files present"

# ── Register routes in server.js ──
node -e "
  const fs = require('fs');
  let s = fs.readFileSync('server.js','utf8');
  let changed = false;

  // Add monetization routes (promo under admin, transactions/redeem under game)
  if (!s.includes('monetization')) {
    const marker = \"app.use('/api/admin',    require('./routes/admin'));\";
    if (s.includes(marker)) {
      s = s.replace(marker, marker + \"\\napp.use('/api/admin',    require('./routes/monetization'));\\napp.use('/api/game',     require('./routes/monetization'));\");
      changed = true;
    }
  }

  // Add preferences routes
  if (!s.includes('preferences')) {
    const marker = \"app.use('/api/game',     require('./routes/daily-bonus'));\";
    if (s.includes(marker)) {
      s = s.replace(marker, marker + \"\\napp.use('/api/game',     require('./routes/preferences'));\");
      changed = true;
    }
  }

  // Add page routes
  const pages = [
    ['/play/history',    'history.html'],
    ['/play/settings',   'settings.html'],
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
    console.log('✓ Routes registered in server.js');
  } else {
    console.log('✓ Routes already registered');
  }
"

# ── Restart ──
echo ""
echo "Restarting PM2..."
pm2 restart all
sleep 2

# ── Test ──
echo ""
echo "Testing endpoints..."
for ep in /api/game/transactions /api/game/preferences /api/game/favorites /api/admin/promo/list /api/admin/suspicion/flags /api/admin/charts/revenue; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000$ep)
  if [ "$CODE" = "401" ] || [ "$CODE" = "200" ] || [ "$CODE" = "403" ]; then
    echo "  ✓ $ep → $CODE"
  else
    echo "  ✗ $ep → $CODE"
  fi
done

echo ""
echo "═══ Batch 2+3 Deployed! ═══"
echo ""
echo "New player pages:"
echo "  /play/history   — Transaction history + promo code redemption"
echo "  /play/settings  — Sound, music, haptic, notification preferences"
echo ""
echo "New admin sections:"
echo "  Promo Codes    — Create and manage promo codes"
echo "  Suspicion Flags — View auto-detected suspicious activity"
echo "  Charts         — Revenue, signups, and RTP charts"
echo ""
echo "Lobby upgrades:"
echo "  ❤️ Game favorites (heart icon on cards)"
echo "  'My Games' section at top of lobby"
echo "  History & Settings in hamburger menu"
