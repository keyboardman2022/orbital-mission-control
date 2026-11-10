package com.orbital.offline;

import android.content.Context;
import android.os.SystemClock;
import android.util.Log;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.SecureRandom;
import java.util.concurrent.CompletableFuture;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import org.json.JSONObject;

final class OfflineRuntime {
    private static CompletableFuture<Endpoint> startup;

    static final class Endpoint {
        final String origin;
        final String cookie;

        Endpoint(String origin, String secret) {
            this.origin = origin;
            this.cookie = "orbital_device=" + secret;
        }
    }

    static synchronized CompletableFuture<Endpoint> start(Context context) {
        if (startup == null) {
            Context app = context.getApplicationContext();
            startup = CompletableFuture.supplyAsync(() -> initialize(app));
        }
        return startup;
    }

    private static Endpoint initialize(Context app) {
        try {
            File web = unpack(app);
            File data = new File(app.getNoBackupFilesDir(), "orbital");
            makeDirectory(data);
            File cache = app.getCacheDir();
            File status = new File(cache, "orbital-runtime.json");
            Files.deleteIfExists(status.toPath());
            String secret = newSecret();
            String[] args = {"orbital-node", new File(web, "android-offline/offline.cjs").getPath(),
                data.getPath(), status.getPath(), secret};

            System.loadLibrary("node");
            System.loadLibrary("orbital_bridge");
            Thread runtime = new Thread(null, () -> {
                int exit = nativeStart(args, cache.getPath());
                Log.e("OrbitalRuntime", "Local runtime stopped (" + exit + ")");
            }, "OrbitalSimulation", 4 * 1024 * 1024);
            runtime.start();
            long deadline = SystemClock.elapsedRealtime() + 45000;
            while (SystemClock.elapsedRealtime() < deadline) {
                if (status.isFile()) {
                    JSONObject result = new JSONObject(new String(
                        Files.readAllBytes(status.toPath()), StandardCharsets.UTF_8));
                    if (result.has("error")) throw new IOException(result.getString("error"));
                    String url = result.getString("url");
                    if (!url.matches("http://127\\.0\\.0\\.1:[0-9]{1,5}")) {
                        throw new IOException("离线地址无效");
                    }
                    Log.i("OrbitalRuntime", "Local simulation ready");
                    return new Endpoint(url, secret);
                }
                if (!runtime.isAlive()) throw new IOException("离线模拟已停止");
                SystemClock.sleep(50);
            }
            throw new IOException("离线模拟启动超时");
        } catch (Exception | LinkageError failure) {
            Log.e("OrbitalRuntime", "Cannot start offline simulation", failure);
            throw new IllegalStateException("无法启动离线模拟，请重新打开 ORBITAL。", failure);
        }
    }

    private static String newSecret() {
        byte[] random = new byte[32];
        new SecureRandom().nextBytes(random);
        StringBuilder hex = new StringBuilder(64);
        for (byte b : random) {
            hex.append(Character.forDigit((b >> 4) & 15, 16));
            hex.append(Character.forDigit(b & 15, 16));
        }
        return hex.toString();
    }

    private static File unpack(Context app) throws Exception {
        long update = app.getPackageManager().getPackageInfo(app.getPackageName(), 0).lastUpdateTime;
        File web = new File(app.getCacheDir(), "web-" + update);
        if (web.isDirectory()) return web;
        File staging = Files.createTempDirectory(app.getCacheDir().toPath(), "web-install-").toFile();
        String prefix = staging.getCanonicalPath() + File.separator;
        try (ZipInputStream archive = new ZipInputStream(app.getAssets().open("orbital-web.zip"))) {
            for (ZipEntry entry; (entry = archive.getNextEntry()) != null;) {
                File output = new File(staging, entry.getName());
                if (!output.getCanonicalPath().startsWith(prefix)) {
                    throw new IOException("应用资源路径无效");
                }
                if (entry.isDirectory()) {
                    makeDirectory(output);
                } else {
                    makeDirectory(output.getParentFile());
                    try (FileOutputStream file = new FileOutputStream(output)) {
                        transfer(archive, file);
                    }
                }
                archive.closeEntry();
            }
        }
        Files.move(staging.toPath(), web.toPath());
        return web;
    }

    private static void makeDirectory(File path) throws IOException {
        if (!path.isDirectory() && !path.mkdirs()) throw new IOException("无法创建应用目录");
    }

    static void transfer(InputStream input, java.io.OutputStream output) throws IOException {
        byte[] buffer = new byte[65536];
        for (int count; (count = input.read(buffer)) != -1;) output.write(buffer, 0, count);
    }

    private static native int nativeStart(String[] args, String temporaryDirectory);
}
