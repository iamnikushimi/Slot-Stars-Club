#!/bin/bash
# ╔══════════════════════════════════════════════════════════════╗
# ║  PATCH: Remove hardcoded tags + Add category editing        ║
# ║  Run from project root: bash patch-categories.sh            ║
# ╚══════════════════════════════════════════════════════════════╝
set -e

TS=$(date +%Y%m%d_%H%M%S)
echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  Patch: Categories + Remove Hardcoded Tags   ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ─── Backup ───
mkdir -p backups/$TS
for f in public/pages/lobby.html public/pages/admin.html routes/admin.js; do
  [ -f "$f" ] && cp "$f" "backups/$TS/$(basename $f)"
done
echo "📦 Backed up to backups/$TS/"

# ══════════════════════════════════════════════════
# 1. PATCH routes/admin.js — add 'category' to
#    the games/update endpoint
# ══════════════════════════════════════════════════
echo ""
echo "🔧 [1/3] Patching routes/admin.js..."

python3 << 'PYEOF'
f = 'routes/admin.js'
try:
    content = open(f).read()
except FileNotFoundError:
    print("   ⚠️  routes/admin.js not found"); exit(0)

if "category" in content and "SET category" in content:
    print("   ℹ️  Already has category support"); exit(0)

# Add category to destructuring
old_d = "const { gameId, name, description, tags, icon } = req.body;"
new_d = "const { gameId, name, description, tags, icon, category } = req.body;"
if old_d in content:
    content = content.replace(old_d, new_d, 1)

# Add category UPDATE after icon UPDATE
old_u = "if (icon !== undefined) db.prepare('UPDATE games SET icon=? WHERE id=?').run(icon, gameId);"
new_u = old_u + "\n    if (category !== undefined) db.prepare('UPDATE games SET category=? WHERE id=?').run(category, gameId);"
if old_u in content and "SET category" not in content:
    content = content.replace(old_u, new_u, 1)

open(f, 'w').write(content)
print("   ✅ admin.js: category added to games/update endpoint")
PYEOF

# ══════════════════════════════════════════════════
# 2. PATCH admin.html — add category dropdown +
#    wire into showGameCard() and ugcSaveCard()
# ══════════════════════════════════════════════════
echo ""
echo "🔧 [2/3] Patching admin.html..."

python3 << 'PYEOF'
f = 'public/pages/admin.html'
try:
    content = open(f).read()
except FileNotFoundError:
    print("   ⚠️  admin.html not found"); exit(0)

changes = 0

# ── A) Add Category dropdown BEFORE the Tags field in the game edit card ──
if 'ugc-category' not in content:
    # The tags field HTML block
    tags_marker = '''<div class="le-field">
              <div class="le-label">Tags / Badges</div>'''

    category_html = '''<div class="le-field">
              <div class="le-label">Category</div>
              <select class="le-input" id="ugc-category" style="cursor:pointer">
                <option value="slots">Slots</option>
                <option value="live">Live Action</option>
                <option value="cards">Card Games</option>
                <option value="instant">Instant Win</option>
                <option value="other">Other</option>
              </select>
            </div>
            '''

    if tags_marker in content:
        content = content.replace(tags_marker, category_html + tags_marker, 1)
        changes += 1
        print("   ✅ Category dropdown added to game edit card")
    else:
        print("   ⚠️  Could not find tags field marker in HTML")

# ── B) Wire category into showGameCard() — populate dropdown when game selected ──
# The function sets: document.getElementById('ugc-desc').value = g.description||'';
if 'ugc-category' in content and "ugc-category').value = g.category" not in content:
    desc_line = "document.getElementById('ugc-desc').value = g.description||'';"
    if desc_line in content:
        new_line = desc_line + "\n  document.getElementById('ugc-category').value = g.category||'slots';"
        content = content.replace(desc_line, new_line, 1)
        changes += 1
        print("   ✅ showGameCard() now populates category dropdown")
    else:
        print("   ⚠️  Could not find ugc-desc setter in showGameCard()")

# ── C) Wire category into ugcSaveCard() — include in save request ──
# The function builds: body:JSON.stringify({gameId,name,description,tags,icon})
if 'ugc-category' in content:
    old_body = "body:JSON.stringify({gameId,name,description,tags,icon})"
    if old_body in content and "category:" not in content.split("ugcSaveCard")[1]:
        new_body = old_body.replace(
            "{gameId,name,description,tags,icon}",
            "{gameId,name,description,tags,icon,category:document.getElementById('ugc-category').value}"
        )
        content = content.replace(old_body, new_body, 1)
        changes += 1
        print("   ✅ ugcSaveCard() now sends category in request")

# ── D) Add Category column to All Games Overview table ──
old_th = "<th></th><th>Game</th><th>Status</th><th>RTP</th>"
new_th = "<th></th><th>Game</th><th>Category</th><th>Status</th><th>RTP</th>"
if "Category</th>" not in content and old_th in content:
    content = content.replace(old_th, new_th, 1)
    # Fix colspan
    content = content.replace('colspan="7"', 'colspan="8"', 1)
    changes += 1
    print("   ✅ Category column added to All Games Overview header")

# ── E) Add category cell to the table row rendering in JS ──
# The row template has: <td><strong>${g.name}</strong></td>\n      <td><span class="status-pill ${g.status}"
old_row = '<td><strong>${g.name}</strong></td>\n      <td><span class="status-pill ${g.status}"'
new_row = '<td><strong>${g.name}</strong></td>\n      <td style="font-size:0.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:1px">${g.category||\'\\u2014\'}</td>\n      <td><span class="status-pill ${g.status}"'

if old_row in content and "g.category" not in content[content.find("allGamesTable"):content.find("allGamesTable")+2000]:
    content = content.replace(old_row, new_row, 1)
    changes += 1
    print("   ✅ Category cell added to All Games table rows")

if changes > 0:
    open(f, 'w').write(content)
    print(f"   ✅ admin.html: {changes} changes saved")
else:
    print("   ℹ️  admin.html: No changes needed")
PYEOF

# ══════════════════════════════════════════════════
# 3. PATCH lobby.html — remove ALL hardcoded badges
# ══════════════════════════════════════════════════
echo ""
echo "🔧 [3/3] Removing hardcoded tags from lobby.html..."

python3 << 'PYEOF'
import re

f = 'public/pages/lobby.html'
try:
    content = open(f).read()
except FileNotFoundError:
    print("   ⚠️  lobby.html not found"); exit(0)

original = content
changes = 0

# ── Remove <span class="game-badge ...">...</span> from all game cards ──
# These are the "Popular", "New", "Jackpots", "High Risk", "Featured", "Free Spins", "PixiJS" tags
badge_pattern = r'\s*<span class="game-badge[^"]*"[^>]*>[^<]*</span>'
content, n = re.subn(badge_pattern, '', content)
if n > 0:
    changes += n
    print(f"   ✅ Removed {n} game-badge spans")

# ── Remove inline-styled badge spans from featured cards ──
# These look like: <span style="font-size:0.6rem;padding:0.1rem 0.5rem;border:...">NEW</span>
featured_badge = r'\s*<span style="font-size:0\.6rem;padding:0\.1rem[^"]*">[^<]*</span>'
content, n = re.subn(featured_badge, '', content)
if n > 0:
    changes += n
    print(f"   ✅ Removed {n} featured card inline badge spans")

# ── Clean up the now-empty flex wrapper divs that held the badges ──
# Nebula Bots wrapper
empty_flex1 = r'\s*<div style="display:flex;gap:0\.4rem;margin-top:0\.5rem;flex-wrap:wrap;">\s*</div>'
content, n = re.subn(empty_flex1, '', content)
if n > 0: changes += n

# Fortune Dragon wrapper
empty_flex2 = r'\s*<div style="display:flex;gap:0\.5rem;flex-wrap:wrap;margin-top:0\.5rem;">\s*</div>'
content, n = re.subn(empty_flex2, '', content)
if n > 0: changes += n

if changes > 0:
    print(f"   ✅ Cleaned up empty badge containers")

if content != original:
    open(f, 'w').write(content)
    print(f"   ✅ lobby.html: {changes} total removals")
    # Verify
    html_badges = len(re.findall(r'class="game-badge', content))
    css_defs = len(re.findall(r'\.game-badge', content))
    print(f"   ℹ️  Remaining: {html_badges} in HTML (should be 0), {css_defs} in CSS (expected)")
else:
    print("   ℹ️  No hardcoded tags found to remove")
PYEOF

# ══════════════════════════════════════════════════
# VERIFICATION
# ══════════════════════════════════════════════════
echo ""
echo "══════════════════════════════════════════════"
echo "  VERIFICATION"
echo "══════════════════════════════════════════════"
echo ""

[ -f routes/admin.js ] && grep -q "SET category" routes/admin.js && echo "✅ admin.js: category UPDATE present" || echo "⚠️  admin.js: missing"
[ -f public/pages/admin.html ] && grep -q "ugc-category" public/pages/admin.html && echo "✅ admin.html: category dropdown present" || echo "⚠️  admin.html: missing"
[ -f public/pages/admin.html ] && grep -q "g.category" public/pages/admin.html && echo "✅ admin.html: category wired in JS" || echo "⚠️  admin.html: missing"

if [ -f public/pages/lobby.html ]; then
  BC=$(grep -c 'class="game-badge' public/pages/lobby.html 2>/dev/null || echo 0)
  echo "ℹ️  lobby.html: $BC badge instances in HTML (0 = all removed)"
fi

echo ""
echo "══════════════════════════════════════════════"
echo "  ✅ PATCH COMPLETE"
echo "══════════════════════════════════════════════"
echo ""
echo "  What changed:"
echo "  • lobby.html — Removed ALL hardcoded badge/tag spans"
echo "    (Popular, New, Jackpots, High Risk, Featured, PixiJS, etc)"
echo "  • admin.html — Added Category dropdown to game editor"
echo "    Options: Slots, Live Action, Card Games, Instant Win, Other"
echo "  • admin.html — Category shown in All Games Overview table"
echo "  • admin.js  — /api/admin/games/update now accepts 'category'"
echo ""
echo "  How it works:"
echo "  The lobby's applyLobbyData() already reads tags from the DB"
echo "  and renders them dynamically. With hardcoded tags removed,"
echo "  only DB-configured tags will show on game cards."
echo ""
echo "  To manage tags: Admin → Games → select game → Tags/Badges"
echo "  To change category: Admin → Games → select game → Category"
echo ""
echo "  Next: pm2 restart slot-stars"
echo ""
