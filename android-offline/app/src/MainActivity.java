package com.orbital.offline;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;
import java.io.ByteArrayInputStream;

public final class MainActivity extends Activity {
    private static final int BACKGROUND = Color.rgb(8, 13, 25);
    private static final String LAST_PAGE = "lastPage";
    private WebView web;
    private FileDownloads downloads;
    private TextView loading;
    private Uri localOrigin;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BACKGROUND);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                Insets area = insets.getInsets(WindowInsets.Type.systemBars()
                    | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(area.left, area.top, area.right, area.bottom);
                return insets;
            });
        }
        web = new WebView(this);
        web.setBackgroundColor(BACKGROUND);
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        loading = new TextView(this);
        loading.setBackgroundColor(BACKGROUND);
        loading.setTextColor(Color.WHITE);
        loading.setGravity(Gravity.CENTER);
        loading.setTextSize(18);
        loading.setText("ORBITAL\n正在启动离线模拟…");
        root.addView(loading, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, false);
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (isLocal(request.getUrl())) return false;
                if (request.isForMainFrame()) {
                    Toast.makeText(MainActivity.this, "离线版仅打开本机页面", Toast.LENGTH_SHORT).show();
                }
                return true;
            }

            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (isLocal(request.getUrl())) return null;
                return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden",
                    java.util.Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
            }

            @Override public void onPageFinished(WebView view, String url) {
                if (isLocal(Uri.parse(url))) {
                    downloads.installBlobDownloads();
                    String page = gamePage(Uri.parse(url));
                    if (page != null) getPreferences(MODE_PRIVATE).edit().putString(LAST_PAGE, page).apply();
                    loading.setVisibility(View.GONE);
                }
            }
        });
        OfflineRuntime.start(this).whenComplete((endpoint, error) -> runOnUiThread(() -> {
            if (isDestroyed() || isFinishing()) return;
            if (error != null) {
                loading.setText("无法启动离线模拟。\n请重新打开 ORBITAL。");
                return;
            }
            localOrigin = Uri.parse(endpoint.origin);
            downloads = new FileDownloads(this, web, endpoint.origin);
            cookies.setCookie(endpoint.origin, endpoint.cookie + "; Path=/; HttpOnly; SameSite=Strict", ok -> {
                if (isDestroyed() || isFinishing()) return;
                if (!ok) {
                    loading.setText("无法建立本机会话。\n请重新打开 ORBITAL。");
                    return;
                }
                String stored = getPreferences(MODE_PRIVATE).getString(LAST_PAGE, "/map-3d.html");
                String page = gamePage(Uri.parse(stored));
                web.loadUrl(endpoint.origin + (page == null ? "/map-3d.html" : page));
            });
        }));
    }

    private boolean isLocal(Uri uri) {
        return localOrigin != null && "http".equals(uri.getScheme())
            && "127.0.0.1".equals(uri.getHost()) && localOrigin.getPort() == uri.getPort()
            && uri.getUserInfo() == null;
    }

    private static String gamePage(Uri uri) {
        String path = uri.getEncodedPath();
        if (path == null || !path.matches("/(?:map-3d|seed-preview)\\.html")) return null;
        String query = uri.getEncodedQuery();
        return query == null ? path : path + "?" + query;
    }

    @Override public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (downloads != null) downloads.onActivityResult(request, result, data);
    }

    @Override protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override protected void onPause() {
        if (web != null) web.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override protected void onDestroy() {
        if (web != null) {
            web.removeJavascriptInterface("OrbitalFiles");
            ((FrameLayout) web.getParent()).removeView(web);
            web.destroy();
        }
        super.onDestroy();
    }
}
