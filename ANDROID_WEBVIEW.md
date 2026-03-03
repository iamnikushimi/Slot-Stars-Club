# Slot Stars Club — Android WebView Integration Guide

## Overview
The app is a full web app designed to run inside an Android WebView. It handles auth, games, and balance entirely via the Node.js backend — the Android app just wraps it in a native shell.

---

## Minimum Android Setup (build.gradle)

```groovy
minSdkVersion 21  // Android 5.0+
targetSdkVersion 34
```

**Permissions (AndroidManifest.xml):**
```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
```

---

## WebView Configuration (MainActivity.java / .kt)

```kotlin
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Full-screen immersive (hide status bar)
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
            View.SYSTEM_UI_FLAG_FULLSCREEN or
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        )

        webView = WebView(this)
        setContentView(webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true          // Required for sessions
            allowContentAccess = true
            loadWithOverviewMode = true
            useWideViewPort = true
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
        }

        // Optional: JavaScript bridge for native features
        webView.addJavascriptInterface(AndroidBridge(this), "Android")

        // Handle back button — navigate in WebView instead of exiting
        webView.canGoBack()

        webView.loadUrl("https://yourdomain.com/play")
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }
}
```

---

## JavaScript ↔ Android Bridge (Optional)

The web app already calls `Android.onLogin()` and `Android.onBalance()` if the bridge exists.

```kotlin
class AndroidBridge(private val context: Context) {

    // Called when user logs in
    @JavascriptInterface
    fun onLogin(userJson: String) {
        // Parse user info if needed for native features
        Log.d("SSC", "User logged in: $userJson")
    }

    // Called when balance changes
    @JavascriptInterface
    fun onBalance(balance: String) {
        Log.d("SSC", "Balance: $balance")
    }

    // Call from Android to update the web app (e.g. push credits)
    fun refreshBalance() {
        (context as Activity).runOnUiThread {
            webView.evaluateJavascript("loadUser()", null)
        }
    }
}
```

---

## Handling Safe Areas (Notch/Punch-hole)

The web app already uses `env(safe-area-inset-top)` in CSS padding.
Enable in Android by setting:

```kotlin
// In styles.xml or theme:
// <item name="android:windowLayoutInDisplayCutoutMode">shortEdges</item>
```

Or programmatically:
```kotlin
if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
    window.attributes.layoutInDisplayCutoutMode =
        WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
}
```

---

## Handling Network Errors

```kotlin
webView.webViewClient = object : WebViewClient() {
    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
        if (request.isForMainFrame) {
            view.loadUrl("about:blank")
            // Show offline UI or retry button
        }
    }
}
```

---

## Deep Links (Optional)

To handle `slotstar://play/slots` deep links:

```xml
<!-- AndroidManifest.xml inside <activity> -->
<intent-filter>
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="slotstar" android:host="play" />
</intent-filter>
```

```kotlin
override fun onNewIntent(intent: Intent?) {
    super.onNewIntent(intent)
    intent?.data?.let { uri ->
        val path = uri.path ?: "/play"
        webView.loadUrl("https://yourdomain.com$path")
    }
}
```

---

## Recommended Dependencies (build.gradle)

```groovy
dependencies {
    implementation 'androidx.appcompat:appcompat:1.6.1'
    implementation 'androidx.webkit:webkit:1.8.0'  // Modern WebView APIs
}
```

---

## PWA / Manifest

A `manifest.json` is served at `/manifest.json` — this powers:
- Home screen install prompt
- Full-screen standalone mode
- Theme color (matches dark casino theme)

---

## Performance Tips

1. **Cache API responses** — sessions persist via cookies, no localStorage needed
2. **Hardware acceleration** — enabled by default in WebView API 23+
3. **Preload** — load the WebView in background before showing it
4. The app uses `100dvh` units for proper mobile height handling
