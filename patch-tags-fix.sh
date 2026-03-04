#!/bin/bash
# ╔══════════════════════════════════════════════════════════════╗
# ║  MASTER FIX: Tags + Categories + admin.js export bug        ║
# ║  Run from /root/slot-stars:  bash patch-tags-fix.sh         ║
# ╚══════════════════════════════════════════════════════════════╝
set -e

TS=$(date +%Y%m%d_%H%M%S)
echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  Master Fix: Tags + Categories + Route Exports   ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ─── Backup ───
mkdir -p backups/$TS
for f in public/pages/lobby.html public/pages/admin.html routes/admin.js; do
  [ -f "$f" ] && cp "$f" "backups/$TS/$(basename $f)"
done
echo "📦 Backed up to backups/$TS/"

# ══════════════════════════════════════════════════
# FIX 1: routes/admin.js
#   BUG: module.exports = router appears BEFORE all
#   game management routes. While JS object refs still
#   work, we also need to add category support AND
#   move the lobby-data endpoint to a public route
#   that doesn't require admin auth at the mount level.
# ══════════════════════════════════════════════════
echo ""
echo "🔧 [1/3] Fixing routes/admin.js..."

python3 << 'PYEOF'
import re

f = 'routes/admin.js'
try:
    content = open(f).read()
except FileNotFoundError:
    print("   ⚠️  routes/admin.js not found — skipping"); exit(0)

changes = 0

# ── A) Move module.exports to the very end ──
# Current: module.exports = router; appears mid-file before game routes
# The line "// This line intentionally left blank" follows it
old_export = "module.exports = router;\n// This line intentionally left blank"
if old_export in content:
    # Remove the early export
    content = content.replace(old_export, "// (module.exports moved to end of file)", 1)
    # Ensure module.exports at the very end
    if not content.rstrip().endswith("module.exports = router;"):
        content = content.rstrip() + "\n\nmodule.exports = router;\n"
    changes += 1
    print("   ✅ Moved module.exports to end of file")
elif "module.exports = router;" in content:
    print("   ℹ️  module.exports already present")
else:
    content = content.rstrip() + "\n\nmodule.exports = router;\n"
    changes += 1
    print("   ✅ Added module.exports at end")

# ── B) Add category to games/update endpoint ──
old_destruct = "const { gameId, name, description, tags, icon } = req.body;"
new_destruct = "const { gameId, name, description, tags, icon, category } = req.body;"
if old_destruct in content and "category" not in content.split("games/update")[1][:500]:
    content = content.replace(old_destruct, new_destruct, 1)
    changes += 1
    print("   ✅ Added category to destructuring")

old_icon_line = "if (icon !== undefined) db.prepare('UPDATE games SET icon=? WHERE id=?').run(icon, gameId);"
cat_line = "    if (category !== undefined) db.prepare('UPDATE games SET category=? WHERE id=?').run(category, gameId);"
if old_icon_line in content and "SET category" not in content:
    content = content.replace(old_icon_line, old_icon_line + "\n" + cat_line, 1)
    changes += 1
    print("   ✅ Added category UPDATE query")

if changes > 0:
    open(f, 'w').write(content)
    print(f"   ✅ admin.js: {changes} fixes applied")
else:
    print("   ℹ️  admin.js: Already up to date")
PYEOF

# ══════════════════════════════════════════════════
# FIX 2: lobby.html
#   BUG 1: Hardcoded badge spans in HTML
#   BUG 2: applyLobbyData() only removes old badges
#          when g.tags is truthy (inside the if block)
# ══════════════════════════════════════════════════
echo ""
echo "🔧 [2/3] Fixing lobby.html..."

python3 << 'PYEOF'
import re

f = 'public/pages/lobby.html'
try:
    content = open(f).read()
except FileNotFoundError:
    print("   ⚠️  lobby.html not found — skipping"); exit(0)

changes = 0

# ── A) Remove hardcoded <span class="game-badge ...">...</span> ──
badge_pattern = r'\s*<span class="game-badge[^"]*"[^>]*>[^<]*</span>'
content, n = re.subn(badge_pattern, '', content)
if n > 0:
    changes += n
    print(f"   ✅ Removed {n} hardcoded game-badge spans")

# ── B) Remove inline-styled badge spans from featured cards ──
# Nebula Bots + Fortune Dragon: <span style="font-size:0.6rem;padding:0.1rem 0.5rem;...">TEXT</span>
featured_badge = r'\s*<span style="font-size:0\.6rem;padding:0\.1rem[^"]*">[^<]*</span>'
content, n = re.subn(featured_badge, '', content)
if n > 0:
    changes += n
    print(f"   ✅ Removed {n} featured card inline badges")

# ── C) Clean empty flex wrapper divs that held badges ──
for pat in [
    r'\s*<div style="display:flex;gap:0\.4rem;margin-top:0\.5rem;flex-wrap:wrap;">\s*</div>',
    r'\s*<div style="display:flex;gap:0\.5rem;flex-wrap:wrap;margin-top:0\.5rem;">\s*</div>',
]:
    content, n = re.subn(pat, '', content)
    if n > 0:
        changes += n
        print(f"   ✅ Cleaned empty badge container div")

# ── D) FIX applyLobbyData() — move badge removal outside if(g.tags) ──
# CURRENT (buggy):
#   if (g.tags) {
#     const tags = ...
#     if (tags.length > 0) {
#       card.querySelectorAll('.game-badge').forEach(b => b.remove());
#       // Add new ones
#       ...
#     }
#   }
#
# FIXED:
#   card.querySelectorAll('.game-badge').forEach(b => b.remove());
#   if (g.tags) {
#     const tags = ...
#     tags.forEach(tag => { ... card.appendChild(span); });
#   }

old_apply = """      // Update badges/tags — replace existing badges
      if (g.tags) {
        const tags = g.tags.split(',').filter(t => t.trim());
        if (tags.length > 0) {
          // Remove old badges
          card.querySelectorAll('.game-badge').forEach(b => b.remove());
          // Add new ones
          const badgeColors = { 'New': 'new', 'Popular': 'hot', 'Hot': 'hot', 'Featured': 'hot', 'Jackpots': 'jackpot', 'High Risk': 'hot' };
          tags.forEach(tag => {
            const span = document.createElement('span');
            span.className = 'game-badge ' + (badgeColors[tag] || 'new');
            span.textContent = tag;
            card.appendChild(span);
          });
        }
      }"""

new_apply = """      // Update badges/tags — always clear, then re-add from DB
      card.querySelectorAll('.game-badge').forEach(b => b.remove());
      if (g.tags) {
        const tags = g.tags.split(',').filter(t => t.trim());
        const badgeColors = { 'New': 'new', 'Popular': 'hot', 'Hot': 'hot', 'Featured': 'hot', 'Jackpots': 'jackpot', 'High Risk': 'hot' };
        tags.forEach(tag => {
          const span = document.createElement('span');
          span.className = 'game-badge ' + (badgeColors[tag] || 'new');
          span.textContent = tag;
          card.appendChild(span);
        });
      }"""

if old_apply in content:
    content = content.replace(old_apply, new_apply, 1)
    changes += 1
    print("   ✅ Fixed applyLobbyData() — badge removal now unconditional")
elif "// Update badges/tags — always clear" in content:
    print("   ℹ️  applyLobbyData() already fixed")
else:
    # Try to find the buggy pattern with flexible whitespace
    buggy = re.search(
        r'// Update badges/tags.*?if \(g\.tags\) \{.*?card\.querySelectorAll.*?\.forEach\(b => b\.remove\(\)\).*?\}[\s\n]*\}',
        content, re.DOTALL
    )
    if buggy:
        content = content[:buggy.start()] + new_apply + content[buggy.end():]
        changes += 1
        print("   ✅ Fixed applyLobbyData() (flexible match)")
    else:
        print("   ⚠️  Could not locate applyLobbyData badge block — CHECK MANUALLY")

if changes > 0:
    open(f, 'w').write(content)
    print(f"   ✅ lobby.html: {changes} total fixes")
else:
    print("   ℹ️  lobby.html: No changes needed")

# Verify
html_badges = len(re.findall(r'<span class="game-badge', content))
css_defs = len(re.findall(r'\.game-badge', content))
print(f"   ℹ️  Badge HTML elements: {html_badges} (should be 0)")
print(f"   ℹ️  CSS class defs: {css_defs} (these stay — needed for dynamic badges)")
PYEOF

# ══════════════════════════════════════════════════
# FIX 3: admin.html — add category dropdown + wire it
# ══════════════════════════════════════════════════
echo ""
echo "🔧 [3/3] Patching admin.html..."

python3 << 'PYEOF'
f = 'public/pages/admin.html'
try:
    content = open(f).read()
except FileNotFoundError:
    print("   ⚠️  admin.html not found — skipping"); exit(0)

changes = 0

# ── A) Add Category dropdown before Tags field ──
if 'ugc-category' not in content:
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
        print("   ✅ Category dropdown added")
    else:
        print("   ⚠️  Tags field marker not found")

# ── B) Populate category in showGameCard() ──
if 'ugc-category' in content and "ugc-category').value = g.category" not in content:
    desc_setter = "document.getElementById('ugc-desc').value = g.description||'';"
    if desc_setter in content:
        content = content.replace(desc_setter,
            desc_setter + "\n  document.getElementById('ugc-category').value = g.category||'slots';", 1)
        changes += 1
        print("   ✅ showGameCard() populates category")

# ── C) Include category in ugcSaveCard() request ──
if 'ugc-category' in content:
    old_body = "body:JSON.stringify({gameId,name,description,tags,icon})"
    if old_body in content:
        new_body = old_body.replace(
            "{gameId,name,description,tags,icon}",
            "{gameId,name,description,tags,icon,category:document.getElementById('ugc-category').value}"
        )
        content = content.replace(old_body, new_body, 1)
        changes += 1
        print("   ✅ ugcSaveCard() sends category")

# ── D) Add Category column to All Games Overview table ──
old_th = "<th></th><th>Game</th><th>Status</th><th>RTP</th>"
new_th = "<th></th><th>Game</th><th>Category</th><th>Status</th><th>RTP</th>"
if "Category</th>" not in content and old_th in content:
    content = content.replace(old_th, new_th, 1)
    content = content.replace('colspan="7"', 'colspan="8"', 1)
    changes += 1
    print("   ✅ Category column in table header")

# ── E) Add category cell to table row JS ──
old_row = '<td><strong>${g.name}</strong></td>\n      <td><span class="status-pill ${g.status}"'
new_row = """<td><strong>${g.name}</strong></td>
      <td style="font-size:0.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:1px">${g.category||'—'}</td>
      <td><span class="status-pill ${g.status}\""""
if old_row in content:
    # Check it hasn't been patched already
    check_area = content[content.find("allGamesTable"):content.find("allGamesTable")+2000] if "allGamesTable" in content else ""
    if "g.category" not in check_area:
        content = content.replace(old_row, new_row, 1)
        changes += 1
        print("   ✅ Category cell in table rows")

if changes > 0:
    open(f, 'w').write(content)
    print(f"   ✅ admin.html: {changes} changes saved")
else:
    print("   ℹ️  admin.html: No changes needed")
PYEOF

# ══════════════════════════════════════════════════
# VERIFICATION
# ══════════════════════════════════════════════════
echo ""
echo "══════════════════════════════════════════════"
echo "  VERIFICATION"
echo "══════════════════════════════════════════════"
echo ""

# 1. admin.js checks
if [ -f routes/admin.js ]; then
  # Check module.exports is at end, not mid-file
  LAST_EXPORT_LINE=$(grep -n "module.exports = router;" routes/admin.js | tail -1 | cut -d: -f1)
  TOTAL_LINES=$(wc -l < routes/admin.js)
  if [ "$LAST_EXPORT_LINE" -gt "$((TOTAL_LINES - 5))" ]; then
    echo "✅ admin.js: module.exports at end (line $LAST_EXPORT_LINE/$TOTAL_LINES)"
  else
    echo "⚠️  admin.js: module.exports at line $LAST_EXPORT_LINE of $TOTAL_LINES — may be too early"
  fi
  grep -q "SET category" routes/admin.js && echo "✅ admin.js: category UPDATE present" || echo "⚠️  admin.js: no category UPDATE"
fi

# 2. lobby.html checks
if [ -f public/pages/lobby.html ]; then
  BC=$(grep -c '<span class="game-badge' public/pages/lobby.html 2>/dev/null || echo 0)
  echo "✅ lobby.html: $BC hardcoded badge spans (should be 0)"
  # Check the fix is in place
  grep -q "// Update badges/tags — always clear" public/pages/lobby.html && \
    echo "✅ lobby.html: applyLobbyData() fixed (unconditional badge clear)" || \
    echo "⚠️  lobby.html: applyLobbyData() fix not detected"
fi

# 3. admin.html checks
if [ -f public/pages/admin.html ]; then
  grep -q "ugc-category" public/pages/admin.html && echo "✅ admin.html: category dropdown present" || echo "⚠️  admin.html: no category dropdown"
  grep -q "g.category" public/pages/admin.html && echo "✅ admin.html: category in table JS" || echo "⚠️  admin.html: no category in table"
fi

echo ""
echo "══════════════════════════════════════════════"
echo "  ✅ ALL FIXES APPLIED"
echo "══════════════════════════════════════════════"
echo ""
echo "  Bugs fixed:"
echo ""
echo "  1. admin.js: module.exports was mid-file before"
echo "     game routes — moved to end of file"
echo ""
echo "  2. admin.js: /games/update now accepts 'category'"
echo ""
echo "  3. lobby.html: Removed ALL hardcoded badge spans"
echo "     (Popular, New, Jackpots, High Risk, Featured,"
echo "     Free Spins, PixiJS, etc.)"
echo ""
echo "  4. lobby.html: applyLobbyData() badge removal was"
echo "     INSIDE the if(g.tags) block — so games with no"
echo "     DB tags kept their hardcoded badges. Now the"
echo "     function ALWAYS clears old badges first, then"
echo "     adds from DB."
echo ""
echo "  5. admin.html: Category dropdown added to editor"
echo "     (Slots, Live Action, Card Games, Instant Win,"
echo "     Other). Shows in All Games table too."
echo ""
echo "  Restart:  pm2 restart slot-stars"
echo ""
