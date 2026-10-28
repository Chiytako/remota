plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.remota.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.remota.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 2
        versionName = "0.1.1"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Signed with the debug key so `assembleRelease` yields an installable APK without a
            // keystore; use your own signingConfig for distribution.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/webassets"))
}

// The app shows the same UI as the browser version: copy ../public and the xterm.js / jsQR bundles
// (run `npm install` in the repository root first).
val repoRoot = rootProject.projectDir.parentFile
val syncWebAssets by tasks.registering(Sync::class) {
    into(layout.buildDirectory.dir("generated/webassets/web"))
    from(File(repoRoot, "public")) { exclude("sw.js") }
    from(File(repoRoot, "node_modules/@xterm/xterm/lib/xterm.js")) { into("vendor") }
    from(File(repoRoot, "node_modules/@xterm/xterm/css/xterm.css")) { into("vendor") }
    from(File(repoRoot, "node_modules/@xterm/addon-fit/lib/addon-fit.js")) { into("vendor") }
    from(File(repoRoot, "node_modules/@xterm/addon-web-links/lib/addon-web-links.js")) { into("vendor") }
    from(File(repoRoot, "node_modules/jsqr/dist/jsQR.js")) { into("vendor"); rename { "jsqr.js" } }
    doFirst {
        check(File(repoRoot, "node_modules/@xterm/xterm/lib/xterm.js").exists()) {
            "node_modules がありません。リポジトリのルートで npm install を実行してください。"
        }
    }
}
tasks.named("preBuild") { dependsOn(syncWebAssets) }

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.fragment:fragment-ktx:1.8.9")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.unifiedpush.android:connector:3.3.5")

    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("com.squareup.okhttp3:okhttp-tls:4.12.0")
}
