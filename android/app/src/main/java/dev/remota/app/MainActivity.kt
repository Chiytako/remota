package dev.remota.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.fragment.app.FragmentActivity
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import org.unifiedpush.android.connector.UnifiedPush

/**
 * The app is a native shell around the same UI as the browser version: the UI runs from bundled
 * assets in a WebView, while networking (with pinned keys), push, biometrics and the camera
 * permission are native.
 */
class MainActivity : FragmentActivity() {
    companion object {
        /** The running activity, for the push service to notify the page (weak: never keeps it alive). */
        @Volatile private var ref: java.lang.ref.WeakReference<MainActivity>? = null
        val current: MainActivity? get() = ref?.get()
        private const val ORIGIN = "https://appassets.androidplatform.net"
        private const val START = "$ORIGIN/assets/web/index.html"
    }

    private lateinit var web: WebView
    var bridge: NativeBridge? = null
        private set
    private var pending: JSONObject? = null
    private var pageReady = false

    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val pickFiles = registerForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        fileCallback?.onReceiveValue(uris.toTypedArray())
        fileCallback = null
    }

    private var cameraRequest: PermissionRequest? = null
    private val askCamera = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        cameraRequest?.let { if (granted) it.grant(it.resources) else it.deny() }
        cameraRequest = null
    }
    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { registerPush() }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ref = java.lang.ref.WeakReference(this)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        Push.ensureChannel(this)

        web = WebView(this)
        val root = FrameLayout(this).apply { addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)) }
        setContentView(root)
        // Keep the UI clear of the status bar, navigation bar and the on-screen keyboard.
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }

        val assets = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build()
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assets.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == Uri.parse(ORIGIN).host) return false
                // Links printed in the terminal open in the browser, never inside the app.
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                pageReady = true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    if (request.origin.toString().trimEnd('/') != ORIGIN || !request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) {
                        request.deny()
                    } else if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                    } else {
                        cameraRequest = request
                        askCamera.launch(Manifest.permission.CAMERA)
                    }
                }
            }

            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                val type = params.acceptTypes.firstOrNull { it.isNotBlank() } ?: "*/*"
                pickFiles.launch(type)
                return true
            }
        }
        bridge = NativeBridge(this, web).also { web.addJavascriptInterface(it, "RemotaNative") }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // The page closes a sheet or goes back to the list; at the top level the app closes.
                web.evaluateJavascript("window.RemotaBridge ? window.RemotaBridge.back() : false") { handled ->
                    if (handled != "true") {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                        isEnabled = true
                    }
                }
            }
        })

        handleIntent(intent)
        web.loadUrl(START)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        ref = java.lang.ref.WeakReference(this)
        web.evaluateJavascript("window.RemotaBridge && window.RemotaBridge.onResume()", null)
    }

    override fun onDestroy() {
        if (current == this) ref = null
        web.destroy()
        super.onDestroy()
    }

    /** Pairing links (remota://pair?...) and notification taps, handed to the page. */
    private fun handleIntent(intent: Intent?) {
        intent ?: return
        val event = when {
            intent.data?.scheme == "remota" -> JSONObject().put("type", "pair").put("link", intent.data.toString())
            intent.hasExtra("session") -> JSONObject().put("type", "open").put("device", intent.getStringExtra("device")).put("session", intent.getStringExtra("session"))
            else -> null
        } ?: return
        if (pageReady) bridge?.emit("onIntent", event) else pending = event
    }

    fun takePending(): String? = pending?.toString().also { pending = null }

    // ----- push -----

    fun enablePush() {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            registerPush()
        }
    }

    private fun registerPush() {
        UnifiedPush.tryUseCurrentOrDefaultDistributor(this) { ok ->
            if (ok) {
                UnifiedPush.register(this)
            } else {
                getSharedPreferences(Push.PREFS, MODE_PRIVATE).edit().putString("error", "NO_DISTRIBUTOR").apply()
                bridge?.emit("onPush", Push.status(this))
            }
        }
    }

    // ----- biometrics -----

    fun canAuthenticate(): Boolean =
        BiometricManager.from(this).canAuthenticate(BIOMETRIC_WEAK or DEVICE_CREDENTIAL) == BiometricManager.BIOMETRIC_SUCCESS

    fun authenticate(done: (Boolean) -> Unit) {
        val prompt = BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = done(true)
            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) = done(false)
        })
        prompt.authenticate(
            BiometricPrompt.PromptInfo.Builder()
                .setTitle("Remota のロックを解除")
                .setAllowedAuthenticators(BIOMETRIC_WEAK or DEVICE_CREDENTIAL)
                .build(),
        )
    }
}
