#!/bin/bash
# ╔══════════════════════════════════════════════════════════════╗
# ║  PATCH: App Download Popup on Login                         ║
# ║  Run from /root/slot-stars:  bash patch-app-popup.sh        ║
# ╚══════════════════════════════════════════════════════════════╝
set -e

TS=$(date +%Y%m%d_%H%M%S)
echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  Patch: App Download Popup                   ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

mkdir -p backups/$TS
[ -f public/pages/lobby.html ] && cp public/pages/lobby.html "backups/$TS/lobby.html"
echo "📦 Backed up to backups/$TS/"

echo ""
echo "🔧 Injecting app download popup..."

python3 << 'PYEOF'
f = 'public/pages/lobby.html'
try:
    content = open(f).read()
except FileNotFoundError:
    print("   ⚠️  lobby.html not found"); exit(1)

if 'app-download-popup' in content:
    print("   ℹ️  App popup already exists — skipping")
    exit(0)

# ═══════════════════════════════════════════════════
# CSS for the popup — injected before </style> (first)
# ═══════════════════════════════════════════════════
popup_css = """
  /* ── App Download Popup ── */
  .app-popup-overlay{display:none;position:fixed;inset:0;z-index:250;background:rgba(0,0,0,0.7);backdrop-filter:blur(6px);align-items:center;justify-content:center;animation:appPopFadeIn 0.3s ease;}
  .app-popup-overlay.show{display:flex;}
  @keyframes appPopFadeIn{from{opacity:0}to{opacity:1}}

  .app-popup{
    background:linear-gradient(165deg, var(--dark2) 0%, var(--dark3) 100%);
    border:1px solid var(--border);
    border-top:3px solid var(--gold);
    max-width:380px;width:90%;padding:0;
    position:relative;overflow:hidden;
    animation:appPopSlideIn 0.4s cubic-bezier(0.175,0.885,0.32,1.275);
  }
  @keyframes appPopSlideIn{from{opacity:0;transform:translateY(30px) scale(0.95)}to{opacity:1;transform:translateY(0) scale(1)}}

  .app-popup-glow{position:absolute;top:-60px;left:50%;transform:translateX(-50%);width:200px;height:120px;background:radial-gradient(ellipse,rgba(255,215,0,0.12),transparent 70%);pointer-events:none;}
  .app-popup-close{position:absolute;top:0.7rem;right:0.8rem;background:none;border:none;color:var(--muted);font-size:1.2rem;cursor:pointer;line-height:1;padding:0.2rem;transition:color 0.2s;z-index:2;}
  .app-popup-close:hover{color:var(--red);}

  .app-popup-header{padding:1.8rem 1.5rem 0.8rem;text-align:center;position:relative;}
  .app-popup-phone{font-size:2.8rem;line-height:1;margin-bottom:0.5rem;display:block;filter:drop-shadow(0 0 12px rgba(255,215,0,0.3));}
  .app-popup-title{font-family:'Bebas Neue',sans-serif;font-size:1.6rem;letter-spacing:4px;background:linear-gradient(135deg,var(--gold),var(--gold2),#fff);-webkit-background-clip:text;-webkit-text-fill-color:transparent;line-height:1.1;}
  .app-popup-subtitle{font-size:0.72rem;letter-spacing:2px;color:var(--muted);text-transform:uppercase;margin-top:0.3rem;}

  .app-popup-body{padding:0.8rem 1.5rem 1.2rem;}

  .app-popup-perks{display:flex;flex-direction:column;gap:0.55rem;margin-bottom:1.2rem;}
  .app-perk{display:flex;align-items:center;gap:0.6rem;font-size:0.82rem;color:rgba(255,255,255,0.75);line-height:1.3;}
  .app-perk-icon{font-size:1.1rem;flex-shrink:0;width:1.5rem;text-align:center;}
  .app-perk strong{color:var(--gold);font-weight:700;}

  .app-popup-dl{
    display:block;width:100%;padding:0.85rem;
    background:linear-gradient(135deg, rgba(255,215,0,0.15), rgba(255,165,0,0.08));
    border:2px solid var(--gold);color:var(--gold);
    font-family:'Bebas Neue',sans-serif;font-size:1.15rem;letter-spacing:3px;
    text-align:center;text-decoration:none;
    cursor:pointer;transition:all 0.25s;
    position:relative;overflow:hidden;
  }
  .app-popup-dl:hover{background:linear-gradient(135deg, rgba(255,215,0,0.25), rgba(255,165,0,0.15));transform:translateY(-1px);box-shadow:0 6px 25px rgba(255,215,0,0.15);}
  .app-popup-dl:active{transform:scale(0.98);}
  .app-popup-dl::after{content:'';position:absolute;top:0;left:-100%;width:50%;height:100%;background:linear-gradient(90deg,transparent,rgba(255,215,0,0.08),transparent);animation:appDlShimmer 3s infinite;}
  @keyframes appDlShimmer{0%{left:-100%}100%{left:200%}}

  .app-popup-version{text-align:center;font-size:0.6rem;color:var(--muted);letter-spacing:1.5px;margin-top:0.5rem;}

  .app-popup-footer{padding:0.8rem 1.5rem 1.2rem;border-top:1px solid rgba(255,255,255,0.04);display:flex;align-items:center;justify-content:center;gap:0.6rem;}
  .app-popup-dismiss{background:none;border:none;color:var(--muted);font-family:'Rajdhani',sans-serif;font-size:0.78rem;font-weight:600;letter-spacing:1px;cursor:pointer;padding:0.3rem 0;transition:color 0.2s;display:flex;align-items:center;gap:0.4rem;}
  .app-popup-dismiss:hover{color:rgba(255,255,255,0.7);}
  .app-popup-checkbox{width:13px;height:13px;accent-color:var(--gold);cursor:pointer;}
"""

# Find the first </style> to inject CSS before it
first_style_end = content.find('</style>')
if first_style_end == -1:
    print("   ⚠️  No </style> tag found"); exit(1)
content = content[:first_style_end] + popup_css + "\n" + content[first_style_end:]
print("   ✅ Popup CSS injected")

# ═══════════════════════════════════════════════════
# HTML for the popup — injected before </body>
# ═══════════════════════════════════════════════════
popup_html = """
<!-- App Download Popup -->
<div class="app-popup-overlay" id="app-download-popup" onclick="if(event.target===this)closeAppPopup()">
  <div class="app-popup">
    <div class="app-popup-glow"></div>
    <button class="app-popup-close" onclick="closeAppPopup()" title="Close">&times;</button>

    <div class="app-popup-header">
      <span class="app-popup-phone">📲</span>
      <div class="app-popup-title">Get the App</div>
      <div class="app-popup-subtitle">Slot Stars Club for Android</div>
    </div>

    <div class="app-popup-body">
      <div class="app-popup-perks">
        <div class="app-perk">
          <span class="app-perk-icon">⚡</span>
          <span><strong>Faster gameplay</strong> — native performance, no browser lag</span>
        </div>
        <div class="app-perk">
          <span class="app-perk-icon">🔔</span>
          <span><strong>Push notifications</strong> — never miss daily bonuses or jackpots</span>
        </div>
        <div class="app-perk">
          <span class="app-perk-icon">🎰</span>
          <span><strong>Instant access</strong> — one tap from your home screen</span>
        </div>
        <div class="app-perk">
          <span class="app-perk-icon">🏆</span>
          <span><strong>Full screen mode</strong> — immersive, distraction-free play</span>
        </div>
      </div>

      <a href="https://slotstarsclub.fun/Slot-Stars-ClubV1.0.apk" class="app-popup-dl" id="appDownloadBtn">
        ★ Download APK — Free
      </a>
      <div class="app-popup-version">V1.0 · Android 8.0+ · 12 MB</div>
    </div>

    <div class="app-popup-footer">
      <input type="checkbox" class="app-popup-checkbox" id="appDontShow">
      <label for="appDontShow" class="app-popup-dismiss">Don't show this again</label>
    </div>
  </div>
</div>
"""

body_end = content.rfind('</body>')
if body_end == -1:
    print("   ⚠️  No </body> tag found"); exit(1)
content = content[:body_end] + popup_html + "\n" + content[body_end:]
print("   ✅ Popup HTML injected")

# ═══════════════════════════════════════════════════
# JS for the popup — injected before </script> (last)
# Uses localStorage for "don't show again"
# Shows popup 1.5s after lobby loads
# ═══════════════════════════════════════════════════
popup_js = """
// ─── App Download Popup ──────────────────────────────────
function showAppPopup() {
  // Don't show if user opted out or already on the app (standalone mode)
  if (localStorage.getItem('ssc_app_dismiss') === '1') return;
  if (window.matchMedia('(display-mode: standalone)').matches) return;
  if (window.navigator.standalone === true) return;

  setTimeout(function() {
    var popup = document.getElementById('app-download-popup');
    if (popup) popup.classList.add('show');
  }, 1500);
}

function closeAppPopup() {
  var popup = document.getElementById('app-download-popup');
  if (popup) popup.classList.remove('show');
  // Save "don't show again" preference
  var cb = document.getElementById('appDontShow');
  if (cb && cb.checked) {
    localStorage.setItem('ssc_app_dismiss', '1');
  }
}

// Track download click
var dlBtn = document.getElementById('appDownloadBtn');
if (dlBtn) {
  dlBtn.addEventListener('click', function() {
    // Auto-dismiss after clicking download
    setTimeout(closeAppPopup, 500);
  });
}

showAppPopup();
"""

# Find the last </script> and inject before it
last_script_end = content.rfind('</script>')
if last_script_end == -1:
    print("   ⚠️  No </script> tag found"); exit(1)
content = content[:last_script_end] + "\n" + popup_js + "\n" + content[last_script_end:]
print("   ✅ Popup JS injected")

open(f, 'w').write(content)
print("   ✅ lobby.html saved")
PYEOF

# ══════════════════════════════════════════════════
# VERIFICATION
# ══════════════════════════════════════════════════
echo ""
echo "══════════════════════════════════════════════"
echo "  VERIFICATION"
echo "══════════════════════════════════════════════"
echo ""

if [ -f public/pages/lobby.html ]; then
  grep -q "app-download-popup" public/pages/lobby.html && echo "✅ Popup HTML present" || echo "⚠️  Popup HTML missing"
  grep -q "showAppPopup" public/pages/lobby.html && echo "✅ Popup JS present" || echo "⚠️  Popup JS missing"
  grep -q "app-popup-overlay" public/pages/lobby.html && echo "✅ Popup CSS present" || echo "⚠️  Popup CSS missing"
  grep -q "ssc_app_dismiss" public/pages/lobby.html && echo "✅ Don't-show-again logic present" || echo "⚠️  Dismiss logic missing"
  grep -q "Slot-Stars-ClubV1.0.apk" public/pages/lobby.html && echo "✅ APK download link present" || echo "⚠️  APK link missing"
fi

echo ""
echo "══════════════════════════════════════════════"
echo "  ✅ PATCH COMPLETE"
echo "══════════════════════════════════════════════"
echo ""
echo "  What it does:"
echo "  • Shows a styled popup 1.5s after lobby loads"
echo "  • Gold/dark theme matching the SSC design"
echo "  • Lists 4 reasons to download the app:"
echo "    ⚡ Faster gameplay"
echo "    🔔 Push notifications"
echo "    🎰 Instant access"
echo "    🏆 Full screen mode"
echo "  • Big download button → links to APK"
echo "  • 'Don't show again' checkbox saves to localStorage"
echo "  • Auto-hides if user is already on the app"
echo "    (standalone/PWA mode detection)"
echo "  • Closes on X, overlay click, or after download"
echo ""
echo "  Next: pm2 restart slot-stars"
echo ""
