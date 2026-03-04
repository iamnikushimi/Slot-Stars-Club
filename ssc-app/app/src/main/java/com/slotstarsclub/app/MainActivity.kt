package com.slotstarsclub.app

import android.Manifest
import android.animation.AnimatorSet
import android.animation.ObjectAnimator
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.view.animation.AccelerateDecelerateInterpolator
import android.view.animation.OvershootInterpolator
import android.webkit.*
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import kotlinx.coroutines.launch
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter

class MainActivity : AppCompatActivity() {

    private var webView: WebView? = null
    private var splashView: FrameLayout? = null
    private var errorView: LinearLayout? = null
    private var retryButton: Button? = null
    private var swipeRefresh: SwipeRefreshLayout? = null
    private var pageLoadingOverlay: FrameLayout? = null
    private var downloadOverlay: FrameLayout? = null
    private var downloadProgress: ProgressBar? = null
    private var downloadPercent: TextView? = null
    private var biometricOverlay: FrameLayout? = null
    private var unlockButton: Button? = null

    // Splash animation views
    private var splashStar: TextView? = null
    private var splashTitle: TextView? = null
    private var splashTagline: TextView? = null
    private var splashProgress: ProgressBar? = null

    // Page loading dot views
    private var loadDot1: View? = null
    private var loadDot2: View? = null
    private var loadDot3: View? = null

    private var hapticManager: HapticManager? = null

    companion object {
        private const val TAG = "SSC-App"
    }

    private val siteUrl = BuildConfig.BASE_URL

    private val internalHosts = setOf(
        "slotstarsclub.fun",
        "www.slotstarsclub.fun",
        "localhost"
    )

    private var pageLoaded = false
    private var pendingDeepLink: String? = null
    private var isNavigating = false
    private var biometricAuthenticated = false
    private val handler = Handler(Looper.getMainLooper())

    // Notification permission launcher (Android 13+)
    private val notificationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            Log.d(TAG, "Notification permission granted: $granted")
            if (granted) {
                NotificationScheduler.scheduleDailyBonus(this)
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        try {
            Log.d(TAG, "onCreate started — v${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
            super.onCreate(savedInstanceState)

            val defaultHandler = Thread.getDefaultUncaughtExceptionHandler()
            Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
                Log.e(TAG, "UNCAUGHT EXCEPTION", throwable)
                saveCrashLog(throwable)
                defaultHandler?.uncaughtException(thread, throwable)
            }

            // Window setup
            try { goFullScreen() } catch (e: Exception) { Log.e(TAG, "goFullScreen failed", e) }
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            window.statusBarColor = Color.parseColor("#050510")
            window.navigationBarColor = Color.parseColor("#050510")

            setContentView(R.layout.activity_main)

            // ── Find all views ───────────────────────────────────────────────
            webView = findViewById(R.id.webView)
            splashView = findViewById(R.id.splashView)
            errorView = findViewById(R.id.errorView)
            retryButton = findViewById(R.id.retryButton)
            swipeRefresh = findViewById(R.id.swipeRefresh)
            pageLoadingOverlay = findViewById(R.id.pageLoadingOverlay)
            downloadOverlay = findViewById(R.id.downloadOverlay)
            downloadProgress = findViewById(R.id.downloadProgress)
            downloadPercent = findViewById(R.id.downloadPercent)
            biometricOverlay = findViewById(R.id.biometricOverlay)
            unlockButton = findViewById(R.id.unlockButton)

            // Splash views
            splashStar = findViewById(R.id.splashStar)
            splashTitle = findViewById(R.id.splashTitle)
            splashTagline = findViewById(R.id.splashTagline)
            splashProgress = findViewById(R.id.splashProgress)

            // Loading dots
            loadDot1 = findViewById(R.id.loadDot1)
            loadDot2 = findViewById(R.id.loadDot2)
            loadDot3 = findViewById(R.id.loadDot3)

            // ── Init haptics ─────────────────────────────────────────────────
            hapticManager = HapticManager(this)

            // ── Setup listeners ──────────────────────────────────────────────
            retryButton?.setOnClickListener {
                errorView?.visibility = View.GONE
                splashView?.visibility = View.VISIBLE
                animateSplash()
                loadSite()
            }

            unlockButton?.setOnClickListener {
                performBiometricAuth()
            }

            // ── Pull-to-refresh ──────────────────────────────────────────────
            setupSwipeRefresh()

            // ── Deep links ───────────────────────────────────────────────────
            handleDeepLink(intent)

            // ── Setup WebView ────────────────────────────────────────────────
            setupWebView()

            // ── Request notification permission ──────────────────────────────
            requestNotificationPermission()

            // ── Start splash animation ───────────────────────────────────────
            animateSplash()

            // ── Biometric or direct launch ───────────────────────────────────
            if (BiometricHelper.isAvailable(this) && BiometricHelper.isEnabled(this)) {
                showBiometricLock()
            } else {
                biometricAuthenticated = true
                checkForUpdates()
            }

            Log.d(TAG, "onCreate complete")
            showLastCrashLog()

        } catch (e: Exception) {
            Log.e(TAG, "FATAL: onCreate crashed", e)
            saveCrashLog(e)
            try {
                Toast.makeText(this, "App error: ${e.message}", Toast.LENGTH_LONG).show()
            } catch (_: Exception) {}
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // ██  1. ANIMATED SPLASH SCREEN
    // ═════════════════════════════════════════════════════════════════════════

    private fun animateSplash() {
        val star = splashStar ?: return
        val title = splashTitle ?: return
        val tagline = splashTagline ?: return
        val progress = splashProgress ?: return

        // Reset states
        star.scaleX = 0.3f
        star.scaleY = 0.3f
        star.alpha = 0f
        star.rotation = -30f
        title.alpha = 0f
        title.translationY = 20f
        tagline.alpha = 0f
        tagline.translationY = 15f
        progress.alpha = 0f

        // Star: scale up + rotate + fade in with overshoot
        val starScaleX = ObjectAnimator.ofFloat(star, "scaleX", 0.3f, 1.15f, 1f).apply { duration = 800 }
        val starScaleY = ObjectAnimator.ofFloat(star, "scaleY", 0.3f, 1.15f, 1f).apply { duration = 800 }
        val starAlpha = ObjectAnimator.ofFloat(star, "alpha", 0f, 1f).apply { duration = 400 }
        val starRotate = ObjectAnimator.ofFloat(star, "rotation", -30f, 10f, 0f).apply { duration = 800 }

        val starSet = AnimatorSet().apply {
            playTogether(starScaleX, starScaleY, starAlpha, starRotate)
            interpolator = OvershootInterpolator(1.5f)
        }

        // Title: slide up + fade in
        val titleAlpha = ObjectAnimator.ofFloat(title, "alpha", 0f, 1f).apply { duration = 500 }
        val titleSlide = ObjectAnimator.ofFloat(title, "translationY", 20f, 0f).apply { duration = 500 }
        val titleSet = AnimatorSet().apply {
            playTogether(titleAlpha, titleSlide)
            startDelay = 500
            interpolator = AccelerateDecelerateInterpolator()
        }

        // Tagline: fade in
        val taglineAlpha = ObjectAnimator.ofFloat(tagline, "alpha", 0f, 1f).apply { duration = 400 }
        val taglineSlide = ObjectAnimator.ofFloat(tagline, "translationY", 15f, 0f).apply { duration = 400 }
        val taglineSet = AnimatorSet().apply {
            playTogether(taglineAlpha, taglineSlide)
            startDelay = 800
        }

        // Progress spinner: fade in last
        val progressAlpha = ObjectAnimator.ofFloat(progress, "alpha", 0f, 1f).apply {
            duration = 300
            startDelay = 1000
        }

        // Start continuous star pulse
        startStarPulse(star)

        AnimatorSet().apply {
            playTogether(starSet, titleSet, taglineSet, progressAlpha)
            start()
        }
    }

    private var starPulseRunnable: Runnable? = null

    private fun startStarPulse(star: TextView) {
        starPulseRunnable = object : Runnable {
            override fun run() {
                if (splashView?.visibility != View.VISIBLE) return
                ObjectAnimator.ofFloat(star, "scaleX", 1f, 1.08f, 1f).apply { duration = 1500; start() }
                ObjectAnimator.ofFloat(star, "scaleY", 1f, 1.08f, 1f).apply { duration = 1500; start() }
                handler.postDelayed(this, 1600)
            }
        }
        handler.postDelayed(starPulseRunnable!!, 1500)
    }

    private fun dismissSplash() {
        val splash = splashView ?: return
        if (splash.visibility != View.VISIBLE) return

        starPulseRunnable?.let { handler.removeCallbacks(it) }

        splash.animate()
            .alpha(0f)
            .setDuration(500)
            .withEndAction {
                splash.visibility = View.GONE
                splash.alpha = 1f
            }
            .start()
    }

    // ═════════════════════════════════════════════════════════════════════════
    // ██  2. PULL-TO-REFRESH
    // ═════════════════════════════════════════════════════════════════════════

    private fun setupSwipeRefresh() {
        swipeRefresh?.apply {
            setColorSchemeColors(
                Color.parseColor("#FFD700"),
                Color.parseColor("#00FFCC"),
                Color.parseColor("#FF6B6B")
            )
            setProgressBackgroundColorSchemeColor(Color.parseColor("#0a0a1f"))

            setOnRefreshListener {
                Log.d(TAG, "Pull-to-refresh triggered")
                val wv = webView
                if (wv != null) {
                    if (errorView?.visibility == View.VISIBLE) {
                        errorView?.visibility = View.GONE
                        loadSite()
                    } else {
                        wv.reload()
                    }
                }
            }
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // ██  3. PAGE LOADING ANIMATIONS
    // ═════════════════════════════════════════════════════════════════════════

    private var dotAnimationRunnable: Runnable? = null

    private fun showPageLoading() {
        if (!pageLoaded) return // Splash handles initial load

        pageLoadingOverlay?.apply {
            alpha = 0f
            visibility = View.VISIBLE
            animate().alpha(1f).setDuration(200).start()
        }
        startDotAnimation()
    }

    private fun hidePageLoading() {
        pageLoadingOverlay?.animate()
            ?.alpha(0f)
            ?.setDuration(250)
            ?.withEndAction {
                pageLoadingOverlay?.visibility = View.GONE
            }
            ?.start()
        stopDotAnimation()
    }

    private fun startDotAnimation() {
        val dots = listOf(loadDot1, loadDot2, loadDot3)
        var step = 0

        dotAnimationRunnable = object : Runnable {
            override fun run() {
                val activeDot = step % 3
                dots.forEachIndexed { i, dot ->
                    dot?.animate()
                        ?.scaleX(if (i == activeDot) 1.5f else 1f)
                        ?.scaleY(if (i == activeDot) 1.5f else 1f)
                        ?.alpha(if (i == activeDot) 1f else 0.3f)
                        ?.setDuration(250)
                        ?.start()
                }
                step++
                handler.postDelayed(this, 350)
            }
        }
        handler.post(dotAnimationRunnable!!)
    }

    private fun stopDotAnimation() {
        dotAnimationRunnable?.let { handler.removeCallbacks(it) }
        dotAnimationRunnable = null
    }

    // ═════════════════════════════════════════════════════════════════════════
    // ██  4. BIOMETRIC LOCK
    // ═════════════════════════════════════════════════════════════════════════

    private fun showBiometricLock() {
        biometricOverlay?.visibility = View.VISIBLE
        splashView?.visibility = View.GONE
        performBiometricAuth()
    }

    private fun performBiometricAuth() {
        BiometricHelper.authenticate(this) { success ->
            if (success) {
                biometricAuthenticated = true
                biometricOverlay?.animate()
                    ?.alpha(0f)
                    ?.setDuration(300)
                    ?.withEndAction {
                        biometricOverlay?.visibility = View.GONE
                        biometricOverlay?.alpha = 1f
                        splashView?.visibility = View.VISIBLE
                        animateSplash()
                        checkForUpdates()
                    }
                    ?.start()
            } else {
                biometricOverlay?.visibility = View.VISIBLE
            }
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // ██  5. IN-APP APK DOWNLOAD
    // ═════════════════════════════════════════════════════════════════════════

    private fun startInAppDownload(url: String) {
        downloadOverlay?.visibility = View.VISIBLE
        downloadProgress?.progress = 0
        downloadPercent?.text = "0%"

        lifecycleScope.launch {
            ApkDownloader.downloadApk(
                context = this@MainActivity,
                url = url,
                listener = object : ApkDownloader.DownloadListener {
                    override fun onProgress(percent: Int) {
                        downloadProgress?.progress = percent
                        downloadPercent?.text = "$percent%"
                    }

                    override fun onComplete(file: File) {
                        downloadOverlay?.visibility = View.GONE
                        ApkDownloader.installApk(this@MainActivity, file)
                    }

                    override fun onError(message: String) {
                        downloadOverlay?.visibility = View.GONE
                        Toast.makeText(
                            this@MainActivity,
                            "Download failed: $message",
                            Toast.LENGTH_LONG
                        ).show()
                    }
                }
            )
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // ██  CORE WEBVIEW + EXISTING FEATURES
    // ═════════════════════════════════════════════════════════════════════════

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        intent?.let { handleDeepLink(it) }
    }

    private fun handleDeepLink(intent: Intent) {
        val deepLink = intent.getStringExtra("deepLink")
        if (deepLink != null) {
            Log.d(TAG, "Deep link received: $deepLink")
            pendingDeepLink = deepLink
        }

        val data: Uri? = intent.data
        if (data != null) {
            Log.d(TAG, "URI deep link: $data")
            when {
                data.host == "bonus" -> pendingDeepLink = "/play/daily-bonus"
            }
        }
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            when {
                ContextCompat.checkSelfPermission(
                    this, Manifest.permission.POST_NOTIFICATIONS
                ) == PackageManager.PERMISSION_GRANTED -> {
                    NotificationScheduler.scheduleDailyBonus(this)
                }
                else -> {
                    notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                }
            }
        } else {
            NotificationScheduler.scheduleDailyBonus(this)
        }
    }

    private fun checkForUpdates() {
        lifecycleScope.launch {
            try {
                val versionInfo = UpdateChecker.checkForUpdate()

                if (versionInfo != null && UpdateChecker.needsUpdate(versionInfo.latestCode)) {
                    if (versionInfo.forceUpdate) {
                        Log.w(TAG, "Force update required: ${versionInfo.latestVersion}")
                        splashView?.visibility = View.GONE
                        UpdateChecker.showForceUpdateDialog(
                            this@MainActivity,
                            versionInfo
                        ) { url -> startInAppDownload(url) }
                    } else {
                        Log.d(TAG, "Optional update available: ${versionInfo.latestVersion}")
                        loadSite()
                        UpdateChecker.showOptionalUpdateDialog(
                            this@MainActivity,
                            versionInfo
                        ) { url -> startInAppDownload(url) }
                    }
                } else {
                    loadSite()
                }
            } catch (e: Exception) {
                Log.e(TAG, "Update check failed", e)
                loadSite()
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val wv = webView ?: return
        wv.apply {
            setBackgroundColor(Color.parseColor("#050510"))
            overScrollMode = View.OVER_SCROLL_NEVER

            settings.apply {
                javaScriptEnabled = true
                javaScriptCanOpenWindowsAutomatically = true
                domStorageEnabled = true
                databaseEnabled = true
                mediaPlaybackRequiresUserGesture = false
                useWideViewPort = true
                loadWithOverviewMode = true
                setSupportZoom(false)
                builtInZoomControls = false
                displayZoomControls = false
                cacheMode = WebSettings.LOAD_DEFAULT
                mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
                allowFileAccess = true
                val currentUA = userAgentString
                userAgentString = "$currentUA SlotStarsClub/${BuildConfig.VERSION_NAME}"
            }

            // ── Add Haptic JS Bridge ─────────────────────────────────────
            hapticManager?.let {
                addJavascriptInterface(it, "SSCHaptic")
            }

            // ── Add Security JS Bridge (biometric toggle) ────────────────
            addJavascriptInterface(object {
                @JavascriptInterface
                fun enableBiometric() {
                    BiometricHelper.setEnabled(this@MainActivity, true)
                }
                @JavascriptInterface
                fun disableBiometric() {
                    BiometricHelper.setEnabled(this@MainActivity, false)
                }
                @JavascriptInterface
                fun isBiometricEnabled(): Boolean {
                    return BiometricHelper.isEnabled(this@MainActivity)
                }
                @JavascriptInterface
                fun isBiometricAvailable(): Boolean {
                    return BiometricHelper.isAvailable(this@MainActivity)
                }
            }, "SSCSecurity")

            // Persistent cookies
            CookieManager.getInstance().apply {
                setAcceptCookie(true)
                setAcceptThirdPartyCookies(wv, true)
            }

            webViewClient = object : WebViewClient() {
                override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                    Log.d(TAG, "Page started: $url")
                    super.onPageStarted(view, url, favicon)
                    errorView?.visibility = View.GONE

                    // Show page loading animation for internal navigation
                    if (pageLoaded) {
                        isNavigating = true
                        showPageLoading()
                    }
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    Log.d(TAG, "Page finished: $url")
                    super.onPageFinished(view, url)

                    // Stop pull-to-refresh spinner
                    swipeRefresh?.isRefreshing = false

                    // Flush cookies
                    CookieManager.getInstance().flush()

                    // Hide page loading animation
                    if (isNavigating) {
                        isNavigating = false
                        hidePageLoading()
                    }

                    if (!pageLoaded) {
                        pageLoaded = true
                        dismissSplash()

                        // Navigate to deep link
                        pendingDeepLink?.let { link ->
                            Log.d(TAG, "Navigating to deep link: $link")
                            view?.loadUrl("${BuildConfig.BASE_URL}$link")
                            pendingDeepLink = null
                        }
                    }

                    // Inject viewport meta
                    view?.evaluateJavascript("""
                        (function() {
                            var meta = document.querySelector('meta[name=viewport]');
                            if (!meta) {
                                meta = document.createElement('meta');
                                meta.name = 'viewport';
                                document.head.appendChild(meta);
                            }
                            meta.content = 'width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no';
                        })();
                    """.trimIndent(), null)
                }

                override fun onReceivedError(
                    view: WebView?, request: WebResourceRequest?, error: WebResourceError?
                ) {
                    Log.e(TAG, "WebView error: ${error?.description} (${error?.errorCode}) url=${request?.url}")
                    swipeRefresh?.isRefreshing = false
                    hidePageLoading()
                    if (request?.isForMainFrame == true) {
                        showError("CONNECTION LOST", "Error: ${error?.description}\nCheck your internet connection and try again")
                    }
                }

                override fun onReceivedHttpError(
                    view: WebView?, request: WebResourceRequest?, errorResponse: WebResourceResponse?
                ) {
                    Log.e(TAG, "HTTP error: ${errorResponse?.statusCode} url=${request?.url}")
                    if (request?.isForMainFrame == true) {
                        val code = errorResponse?.statusCode ?: 0
                        if (code >= 500) {
                            swipeRefresh?.isRefreshing = false
                            hidePageLoading()
                            showError("SERVER ERROR", "HTTP $code — The server is temporarily unavailable.")
                        }
                    }
                }

                override fun shouldOverrideUrlLoading(
                    view: WebView?, request: WebResourceRequest?
                ): Boolean {
                    val url = request?.url ?: return false
                    val host = url.host ?: return false

                    if (internalHosts.any { host.endsWith(it) }) return false

                    // APK downloads — use in-app downloader
                    if (url.toString().endsWith(".apk")) {
                        startInAppDownload(url.toString())
                        return true
                    }

                    try { startActivity(Intent(Intent.ACTION_VIEW, url)) } catch (_: Exception) {}
                    return true
                }
            }

            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean {
                    Log.d("SSC-WebView", "${consoleMessage?.message()} [${consoleMessage?.sourceId()}:${consoleMessage?.lineNumber()}]")
                    return true
                }
            }
        }
    }

    private fun loadSite() {
        Log.d(TAG, "loadSite() — checking network")
        if (isNetworkAvailable()) {
            Log.d(TAG, "Network OK — loading $siteUrl")
            webView?.loadUrl(siteUrl)
        } else {
            Log.e(TAG, "No network available")
            showError("NO INTERNET", "Connect to the internet and pull down to refresh")
        }
    }

    private fun showError(title: String, message: String) {
        Log.e(TAG, "showError: $title — $message")
        splashView?.visibility = View.GONE
        errorView?.visibility = View.VISIBLE
        findViewById<TextView>(R.id.errorTitle)?.text = title
        findViewById<TextView>(R.id.errorMessage)?.text = message
    }

    private fun isNetworkAvailable(): Boolean {
        return try {
            val cm = getSystemService(CONNECTIVITY_SERVICE) as ConnectivityManager
            val network = cm.activeNetwork ?: return false
            val caps = cm.getNetworkCapabilities(network) ?: return false
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        } catch (e: Exception) {
            Log.e(TAG, "Network check failed", e)
            true
        }
    }

    private fun goFullScreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.insetsController?.apply {
                hide(WindowInsets.Type.systemBars())
                systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    or View.SYSTEM_UI_FLAG_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                )
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) try { goFullScreen() } catch (_: Exception) {}
    }

    override fun onResume() {
        super.onResume()
        Log.d(TAG, "onResume")
        webView?.onResume()
        try { goFullScreen() } catch (_: Exception) {}
    }

    override fun onPause() {
        super.onPause()
        Log.d(TAG, "onPause")
        webView?.onPause()
        CookieManager.getInstance().flush()
    }

    @Deprecated("Use onBackPressedDispatcher")
    override fun onBackPressed() {
        if (downloadOverlay?.visibility == View.VISIBLE) return

        val wv = webView
        if (wv != null && wv.canGoBack()) {
            val currentUrl = wv.url ?: ""
            if (currentUrl.endsWith("/play") || currentUrl.endsWith("/")) {
                @Suppress("DEPRECATION")
                super.onBackPressed()
            } else {
                wv.goBack()
            }
        } else {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        Log.d(TAG, "onDestroy")
        starPulseRunnable?.let { handler.removeCallbacks(it) }
        dotAnimationRunnable?.let { handler.removeCallbacks(it) }
        webView?.destroy()
        super.onDestroy()
    }

    private fun saveCrashLog(throwable: Throwable) {
        try {
            val sw = StringWriter()
            throwable.printStackTrace(PrintWriter(sw))
            val log = "=== SSC CRASH ${java.util.Date()} ===\n${sw}\n"
            File(filesDir, "crash.log").appendText(log)
            Log.e(TAG, "Crash log saved")
        } catch (_: Exception) {}
    }

    private fun showLastCrashLog() {
        try {
            val file = File(filesDir, "crash.log")
            if (file.exists() && file.length() > 0) {
                val log = file.readText().takeLast(2000)
                Log.w(TAG, "=== PREVIOUS CRASH LOG ===\n$log")
                Toast.makeText(this, "Previous crash detected — check logcat", Toast.LENGTH_LONG).show()
                file.delete()
            }
        } catch (_: Exception) {}
    }
}
