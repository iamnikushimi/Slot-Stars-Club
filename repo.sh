#!/bin/bash
# ╔══════════════════════════════════════════════════════════════╗
# ║  GitHub Repo Raw Link Grabber                                ║
# ║  Usage: bash grab-repo-links.sh                              ║
# ╚══════════════════════════════════════════════════════════════╝

OWNER="iamnikushimi"
REPO="Slot-Stars-Club"
BRANCH="master"
API_URL="https://api.github.com/repos/$OWNER/$REPO/git/trees/$BRANCH?recursive=1"
RAW_BASE="https://raw.githubusercontent.com/$OWNER/$REPO/$BRANCH"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  Grabbing all files from $OWNER/$REPO        "
echo "╚══════════════════════════════════════════════╝"
echo ""

# Fetch the full file tree from GitHub API
RESPONSE=$(curl -s "$API_URL")

# Check for errors
if echo "$RESPONSE" | grep -q '"message"'; then
  echo "❌ API error:"
  echo "$RESPONSE" | grep '"message"'
  echo ""
  echo "If rate-limited, wait a minute and try again."
  exit 1
fi

# Parse all file paths (type=blob means it's a file, not a directory)
FILES=$(echo "$RESPONSE" | grep '"path"' | grep -B1 '"blob"' | grep '"path"' | sed 's/.*"path": "//;s/".*//')

# Alternative parsing if the above doesn't work (simpler grep)
if [ -z "$FILES" ]; then
  FILES=$(echo "$RESPONSE" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for item in data.get('tree', []):
    if item.get('type') == 'blob':
        print(item['path'])
" 2>/dev/null)
fi

if [ -z "$FILES" ]; then
  echo "❌ Could not parse file list. Raw API response:"
  echo "$RESPONSE" | head -50
  exit 1
fi

# Count and display
TOTAL=$(echo "$FILES" | wc -l | tr -d ' ')
echo "📂 Found $TOTAL files"
echo ""

# Output raw links
echo "═══════════════════════════════════════════════"
echo "  RAW LINKS"
echo "═══════════════════════════════════════════════"
echo ""

echo "$FILES" | while read -r filepath; do
  echo "$RAW_BASE/$filepath"
done

# Also save to a file
OUTFILE="repo-links.txt"
echo "$FILES" | while read -r filepath; do
  echo "$RAW_BASE/$filepath"
done > "$OUTFILE"

echo ""
echo "═══════════════════════════════════════════════"
echo "  ✅ Saved to $OUTFILE ($TOTAL links)"
echo "═══════════════════════════════════════════════"
echo ""
