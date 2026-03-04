# Slot Stars Club — Android App

A native Android WebView wrapper for Slot Stars Club.

## Features

- **Full-screen immersive mode** — no status bar or nav bar, 100% game space
- **Splash screen** with gold star logo while the site loads
- **Offline error screen** with retry button when connection is lost
- **Hardware accelerated** WebView for smooth canvas/PixiJS rendering
- **Web Audio API enabled** for game sounds
- **DOM Storage enabled** for session/login persistence
- **Back button navigation** — goes back in web history before exiting
- **Screen stays on** while the app is active
- **Deep linking** — taps on slotstarsclub.fun links open in the app
- **External links** open in the system browser

## Setup

### 1. Open in Android Studio

Open the `ssc-app` folder in Android Studio (Arctic Fox or newer).

### 2. Set Your URL

Edit `app/build.gradle` and change the `BASE_URL` to your server:

```gradle
buildConfigField "String", "BASE_URL", "\"https://slotstarsclub.fun\""
```

For local development, use your computer's IP:
```gradle
buildConfigField "String", "BASE_URL", "\"http://192.168.1.100:3000\""
```

### 3. Update the Domain

In `AndroidManifest.xml`, update the deep link host:
```xml
<data android:scheme="https" android:host="slotstarsclub.fun" />
```

In `MainActivity.kt`, update the `internalHosts` set:
```kotlin
private val internalHosts = setOf(
    "slotstarsclub.fun",
    "www.slotstarsclub.fun",
    "localhost"
)
```

### 4. Replace Icons (Optional)

Replace the generated icons in `app/src/main/res/mipmap-*/` with your own.
Use Android Studio's **Image Asset Studio** (right-click res → New → Image Asset).

### 5. Build & Run

- **Debug**: Run directly from Android Studio to your phone/emulator
- **Release APK**: Build → Generate Signed Bundle/APK → APK
- **Release AAB** (for Play Store): Build → Generate Signed Bundle/APK → Android App Bundle

## Project Structure

```
ssc-app/
├── app/
│   ├── build.gradle              ← Dependencies & URL config
│   ├── proguard-rules.pro        ← ProGuard keep rules
│   └── src/main/
│       ├── AndroidManifest.xml   ← Permissions & deep links
│       ├── java/.../
│       │   └── MainActivity.kt  ← WebView setup & lifecycle
│       └── res/
│           ├── layout/
│           │   └── activity_main.xml  ← WebView + splash + error UI
│           ├── mipmap-*/              ← App icons (all densities)
│           ├── values/
│           │   ├── colors.xml
│           │   ├── strings.xml
│           │   └── themes.xml
│           ├── values-night/
│           │   └── themes.xml
│           └── xml/
│               └── network_security_config.xml
├── build.gradle                  ← Root build config
├── settings.gradle
├── gradle.properties
└── gradle/wrapper/
    └── gradle-wrapper.properties
```

## Signing for Release

1. Generate a keystore:
   ```bash
   keytool -genkey -v -keystore ssc-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias ssc
   ```

2. Add to `app/build.gradle`:
   ```gradle
   android {
       signingConfigs {
           release {
               storeFile file('../ssc-release.jks')
               storePassword 'your-password'
               keyAlias 'ssc'
               keyPassword 'your-password'
           }
       }
       buildTypes {
           release {
               signingConfig signingConfigs.release
           }
       }
   }
   ```

## Requirements

- Android Studio Hedgehog (2023.1) or newer
- Android SDK 34
- Min SDK 24 (Android 7.0+)
- Kotlin 1.9+
