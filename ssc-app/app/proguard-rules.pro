# WebView
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface

# Keep WebView bridge
-keep class com.slotstarsclub.app.WebAppInterface { *; }
