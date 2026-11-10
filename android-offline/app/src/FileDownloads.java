package com.orbital.offline;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import android.util.Log;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.WebView;
import android.widget.Toast;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public final class FileDownloads {
    private static final int CREATE_FILE = 101;
    private static final int MAX_BLOB = 16 * 1024 * 1024;
    private final Activity activity;
    private final WebView web;
    private final String origin;
    private Download pending;

    private static final class Download {
        final String url;
        final String name;
        final String mime;
        byte[] blob;

        Download(String url, String name, String mime) {
            this.url = url;
            this.name = name;
            this.mime = mime;
        }
    }

    FileDownloads(Activity activity, WebView web, String origin) {
        this.activity = activity;
        this.web = web;
        this.origin = origin;
        web.addJavascriptInterface(this, "OrbitalFiles");
        web.setDownloadListener((url, userAgent, disposition, mime, length) ->
            request(url, disposition, mime));
    }

    private void request(String url, String disposition, String mime) {
        if (pending != null) {
            notifyUser("请先完成当前文件保存");
            return;
        }
        if (!url.startsWith(origin + "/")) return;
        if (!Uri.parse(url).getPath().matches("/api/exports/[a-f0-9-]{36}/download")) return;
        String type = mime == null || mime.isEmpty() ? "application/octet-stream" : mime.split(";")[0];
        pending = new Download(url, URLUtil.guessFileName(url, disposition, type), type);
        chooseDestination();
    }

    void installBlobDownloads() {
        // The original pages generate files in memory and click detached anchors.
        // Forward those blobs before their object URLs are revoked.
        web.evaluateJavascript(String.join("\n",
            "(() => {",
            "  if (window.orbitalBlobDownloads) return;",
            "  window.orbitalBlobDownloads = true;",
            "  const blobs = new Map();",
            "  const create = URL.createObjectURL.bind(URL);",
            "  const revoke = URL.revokeObjectURL.bind(URL);",
            "  const click = HTMLAnchorElement.prototype.click;",
            "  URL.createObjectURL = blob => {",
            "    const url = create(blob);",
            "    if (blob instanceof Blob) blobs.set(url, blob);",
            "    return url;",
            "  };",
            "  URL.revokeObjectURL = url => { blobs.delete(url); return revoke(url); };",
            "  HTMLAnchorElement.prototype.click = function () {",
            "    const blob = this.download && blobs.get(this.href);",
            "    if (!blob) return click.call(this);",
            "    const name = this.download;",
            "    const reader = new FileReader();",
            "    reader.onload = () => OrbitalFiles.saveBlob(name, blob.type, reader.result.split(',')[1]);",
            "    reader.onerror = () => OrbitalFiles.saveBlob(name, blob.type, null);",
            "    if (blob.size > " + MAX_BLOB + ") reader.onerror();",
            "    else reader.readAsDataURL(blob);",
            "  };",
            "})()"), null);
    }

    @JavascriptInterface public void saveBlob(String name, String mime, String encoded) {
        activity.runOnUiThread(() -> {
            if (activity.isDestroyed() || activity.isFinishing()) return;
            if (pending != null) {
                notifyUser("请先完成当前文件保存");
                return;
            }
            try {
                if (name == null || !name.matches("[A-Za-z0-9_-]{1,100}\\.(txt|png)")
                    || !("text/plain".equals(mime) || "image/png".equals(mime))
                    || encoded == null || encoded.length() > (MAX_BLOB + 2) / 3 * 4) {
                    throw new IllegalArgumentException("Invalid download");
                }
                pending = new Download(null, name, mime);
                pending.blob = Base64.decode(encoded, Base64.DEFAULT);
                chooseDestination();
            } catch (IllegalArgumentException error) {
                pending = null;
                notifyUser("读取文件失败，请重试");
            }
        });
    }

    private void chooseDestination() {
        Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        save.addCategory(Intent.CATEGORY_OPENABLE);
        save.setType(pending.mime);
        save.putExtra(Intent.EXTRA_TITLE, pending.name);
        try {
            activity.startActivityForResult(save, CREATE_FILE);
        } catch (ActivityNotFoundException failure) {
            pending = null;
            notifyUser("系统文件选择器不可用");
        }
    }

    void onActivityResult(int request, int result, Intent data) {
        if (request != CREATE_FILE || pending == null) return;
        Download file = pending;
        pending = null;
        if (result != Activity.RESULT_OK || data == null || data.getData() == null) return;
        Uri destination = data.getData();
        String cookie = file.blob == null ? CookieManager.getInstance().getCookie(file.url) : null;
        new Thread(() -> {
            HttpURLConnection connection = null;
            try {
                InputStream input;
                if (file.blob != null) {
                    input = new ByteArrayInputStream(file.blob);
                } else {
                    connection = (HttpURLConnection) new URL(file.url).openConnection(java.net.Proxy.NO_PROXY);
                    connection.setInstanceFollowRedirects(false);
                    connection.setConnectTimeout(10000);
                    connection.setReadTimeout(30000);
                    if (cookie != null) connection.setRequestProperty("Cookie", cookie);
                    if (connection.getResponseCode() != 200) throw new IOException("Export request failed");
                    input = connection.getInputStream();
                }
                try (InputStream source = input;
                     OutputStream output = activity.getContentResolver().openOutputStream(destination, "w")) {
                    if (output == null) throw new IOException("Cannot open destination");
                    OfflineRuntime.transfer(source, output);
                }
                notifyUser("文件已保存");
            } catch (IOException | SecurityException failure) {
                Log.w("OrbitalFiles", "Could not save download", failure);
                notifyUser("保存文件失败，请重试");
            } finally {
                if (connection != null) connection.disconnect();
            }
        }, "OrbitalExport").start();
    }

    private void notifyUser(String message) {
        activity.runOnUiThread(() -> Toast.makeText(activity, message, Toast.LENGTH_SHORT).show());
    }
}
