package com.slotstarsclub.app

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.*
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter

class MainActivity : AppCompatActivity() {

    private var webView: WebView? = null
    private var splashView: LinearLayout? = null
    private var errorView: LinearLayout? = null
    private var retryButton: Button? = null

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

    override fun onCreate(savedInstanceState: Bundle?) {
        try {
            Log.d(TAG, "onCreate started")
            Log.d(TAG, "URL: $siteUrl")
            super.onCreate(savedInstanceState)

            val defaultHandler = Thread.getDefaultUncaughtExceptionHandler()
            Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
                Log.e(TAG, "UNCAUGHT EXCEPTION", throwable)
                saveCrashLog(throwable)
                defaultHandler?.uncaughtException(thread, throwable)
            }

            Log.d(TAG, "Setting up window")
            try { goFullScreen() } catch (e: Exception) { Log.e(TAG, "goFullScreen failed", e) }
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            window.statusBarColor = Color.parseColor("#050510")
            window.navigationBarColor = Color.parseColor("#050510")

            Log.d(TAG, "Setting content view")
            setContentView(R.layout.activity_main)

            Log.d(TAG, "Finding views")
            webView = findViewById(R.id.webView)
            splashView = findViewById(R.id.splashView)
            errorView = findViewById(R.id.errorView)
            retryButton = findViewById(R.id.retryButton)

            Log.d(TAG, "Views found: webView=${webView != null}, splash=${splashView != null}")

            retryButton?.setOnClickListener {
                errorView?.visibility = View.GONE
                splashView?.visibility = View.VISIBLE
                loadSite()
            }

            Log.d(TAG, "Setting up WebView")
            setupWebView()

            Log.d(TAG, "Loading site")
            loadSite()

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
                userAgentString = "$userAgentString SlotStarsClub/1.0"
            }

            webViewClient = object : WebViewClient() {
                override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                    Log.d(TAG, "Page started: $url")
                    super.onPageStarted(view, url, favicon)
                    errorView?.visibility = View.GONE
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    Log.d(TAG, "Page finished: $url")
                    super.onPageFinished(view, url)
                    if (!pageLoaded) {
                        pageLoaded = true
                        splashView?.animate()
                            ?.alpha(0f)
                            ?.setDuration(400)
                            ?.withEndAction {
                                splashView?.visibility = View.GONE
                                splashView?.alpha = 1f
                            }
                            ?.start()
                    }

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
            showError("NO INTERNET", "Connect to the internet to play")
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
    }

    @Deprecated("Use onBackPressedDispatcher")
    override fun onBackPressed() {
        if (webView?.canGoBack() == true) {
            webView?.goBack()
        } else {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        Log.d(TAG, "onDestroy")
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
                Toast.makeText(this, "Previous crash detected — check logcat for details", Toast.LENGTH_LONG).show()
                file.delete()
            }
        } catch (_: Exception) {}
    }
}
