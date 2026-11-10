"""Build and sign the Windows-hosted ORBITAL Android project with pinned tools."""

import argparse
import concurrent.futures
import hashlib
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import urllib.request
import zipfile

MOBILE = Path(__file__).resolve().parent
ROOT = MOBILE.parent
BUILD = MOBILE / ".build"
DEPS = BUILD / "deps"
APP = MOBILE / "app"
GOOGLE = "https://dl.google.com/android/repository/"
NODE = "https://github.com/fogtape/nodejs-mobile/releases/download/v24.22.1-0/"
PLATFORM = ("platform-35_r02.zip", "0bb560a90a7a2cbd0dd8348224d518b638fe7949")
BUILD_TOOLS = ("build-tools_r35_windows.zip", "af059bb67cf7786f45ee0db85e2d24985df1b4b6")
NDK = ("android-ndk-r28c-windows.zip", "086bba43ff2f5eb0e387b15c8278bb4e0d89ba1d")
RUNTIME = (
    "nodejs-mobile-android-24.22.1-0.zip",
    "d6fd9f610fe5d81fede8f0d400c5a62723247725a19831835f15abf4f0604250",
)
ABIS = {"arm64-v8a": "aarch64-linux-android", "x86_64": "x86_64-linux-android"}
WEB_FILES = """
camera.js history-webgl.js preview-worker.js orbital-visuals.js stellar-renderer.js
seed-preview.html seed-preview.css seed-preview.js
gravity-lab.html gravity-lab.css gravity-lab.js shared/nbody.js
map-3d.html map-3d.css map-3d.js flight-controls-3d.js mobile-map.css
shared/history-window.js shared/map-sweep.js shared/simulation.js shared/units.js shared/world-generator.js
server/index.js server/engine.js server/export-worker.js server/simulation-worker.js server/purge-flat-maps.js server/body-fields.js
server/stream-snapshot.js server/trajectory-budget.js server/trajectory-sampler.js server/trajectory-store.js
android-offline/offline.cjs
""".split()


def run(*args, **kwargs):
    return subprocess.run([str(value) for value in args], check=True, **kwargs)


def digest(path, expected):
    with path.open("rb") as stream:
        algorithm = "sha256" if len(expected) == 64 else "sha1"
        return hashlib.file_digest(stream, algorithm).hexdigest()


def download_ndk(url, target):
    # The repository's Windows NDK is large. Independent byte ranges allow slow
    # connections to retry one segment without discarding the complete download.
    size = 748118221
    block = 24 * 1024 * 1024

    def fetch(start):
        stop = min(start + block, size) - 1
        part = target.with_name(f"{target.name}.{start}")
        if part.exists() and part.stat().st_size == stop - start + 1:
            return part
        for attempt in range(3):
            try:
                request = urllib.request.Request(url, headers={"Range": f"bytes={start}-{stop}"})
                with urllib.request.urlopen(request, timeout=60) as response:
                    if response.headers.get("Content-Range") != f"bytes {start}-{stop}/{size}":
                        raise OSError("Android repository returned the wrong range")
                    with part.open("wb") as output:
                        shutil.copyfileobj(response, output)
                if part.stat().st_size != stop - start + 1:
                    raise OSError("Incomplete NDK range")
                return part
            except OSError:
                if attempt == 2:
                    raise

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        parts = list(pool.map(fetch, range(0, size, block)))
    with target.open("wb") as output:
        for part in parts:
            with part.open("rb") as source:
                shutil.copyfileobj(source, output)
    for part in parts:
        part.unlink()


def dependency(base, spec, top=None):
    name, expected = spec
    destination = DEPS / name.removesuffix(".zip")
    marker = destination / ".verified"
    if not marker.is_file() or marker.read_text().strip() != expected:
        archive = DEPS / name
        if not archive.is_file() or digest(archive, expected) != expected:
            print("Downloading", name, flush=True)
            pending = archive.with_suffix(".download")
            if spec == NDK:
                download_ndk(base + name, pending)
            else:
                with urllib.request.urlopen(base + name, timeout=90) as response, pending.open("wb") as output:
                    shutil.copyfileobj(response, output)
            if digest(pending, expected) != expected:
                raise ValueError("Checksum mismatch for " + name)
            pending.replace(archive)
        destination.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(archive) as source:
            for entry in source.infolist():
                if spec == RUNTIME and entry.filename.startswith(("bin/", "include/")):
                    parts = entry.filename.split("/")
                    if parts[0] == "bin" and len(parts) > 1 and parts[1] not in ABIS and parts[1]:
                        continue
                source.extract(entry, destination)
        marker.write_text(expected + "\n")
    return destination / top if top else destination


def sign(java, jdk, tools, unsigned, output):
    signing = MOBILE / ".signing"
    signing.mkdir(exist_ok=True)
    keystore = signing / "orbital.p12"
    password = signing / "password"
    if not password.exists():
        password.write_text(secrets.token_urlsafe(32), encoding="ascii")
    env = {**os.environ, "ORBITAL_SIGNING_PASSWORD": password.read_text(encoding="ascii").strip()}
    if not keystore.exists():
        run(jdk / "bin/keytool.exe", "-genkeypair", "-keystore", keystore, "-storetype", "PKCS12",
            "-storepass:env", "ORBITAL_SIGNING_PASSWORD", "-alias", "orbital-offline",
            "-dname", "CN=ORBITAL Offline", "-keyalg", "RSA", "-keysize", 3072, "-validity", 10000, env=env)
    signer = [java, "-jar", tools / "lib/apksigner.jar"]
    run(*signer, "sign", "--ks", keystore, "--ks-key-alias", "orbital-offline",
        "--ks-pass", "env:ORBITAL_SIGNING_PASSWORD", "--v4-signing-enabled", "false",
        "--out", output, unsigned, env=env)
    run(*signer, "verify", "--verbose", "--print-certs", output)


def build(jdk, ndk=None):
    DEPS.mkdir(parents=True, exist_ok=True)
    java = jdk / "bin/java.exe"
    platform = dependency(GOOGLE, PLATFORM, "android-35")
    tools = dependency(GOOGLE, BUILD_TOOLS, "android-15")
    runtime = dependency(NODE, RUNTIME)
    ndk = ndk or dependency(GOOGLE, NDK, "android-ndk-r28c")
    llvm = ndk / "toolchains/llvm/prebuilt/windows-x86_64"
    sdk = platform / "android.jar"
    classes = BUILD / "classes"
    dex = BUILD / "dex"
    for directory in (classes, dex):
        directory.mkdir(exist_ok=True)
    run(jdk / "bin/javac.exe", "-encoding", "UTF-8", "-source", "8", "-target", "8", "-Xlint:-options",
        "-classpath", sdk, "-d", classes, *sorted((APP / "src").glob("*.java")))
    run(java, "-cp", tools / "lib/d8.jar", "com.android.tools.r8.D8", "--lib", sdk,
        "--min-api", "26", "--output", dex, *sorted(classes.rglob("*.class")))
    res = BUILD / "res.zip"
    apk = BUILD / "resources.apk"
    run(tools / "aapt2.exe", "compile", "--dir", APP / "res", "-o", res)
    run(tools / "aapt2.exe", "link", "-I", sdk, "--manifest", APP / "AndroidManifest.xml", "-o", apk, res)

    web = BUILD / "orbital-web.zip"
    with zipfile.ZipFile(web, "w", zipfile.ZIP_DEFLATED) as assets:
        for name in WEB_FILES:
            assets.write(ROOT / name, name)
    with zipfile.ZipFile(apk, "a", zipfile.ZIP_DEFLATED) as package:
        package.write(dex / "classes.dex", "classes.dex")
        package.write(web, "assets/orbital-web.zip", compress_type=zipfile.ZIP_STORED)
        package.write(MOBILE / "NODE-LICENSE.txt", "assets/NODE-LICENSE.txt")
        package.write(ndk / "NOTICE.toolchain", "assets/ANDROID-TOOLCHAIN-NOTICE.txt")
        for abi, target in ABIS.items():
            node = runtime / "bin" / abi / "libnode.so"
            bridge = BUILD / f"liborbital_bridge-{abi}.so"
            run(llvm / "bin/clang++.exe", f"--target={target}26", "-std=c++20", "-shared", "-fPIC",
                "-fvisibility=hidden", "-Wl,--no-undefined",
                "-Wl,-z,max-page-size=16384", "-I", runtime / "include/node",
                APP / "src/node_bridge.cpp", node, "-o", bridge)
            libraries = {
                "libnode.so": node,
                "liborbital_bridge.so": bridge,
                "libc++_shared.so": llvm / "sysroot/usr/lib" / target / "libc++_shared.so",
            }
            for name, file in libraries.items():
                package.write(file, f"lib/{abi}/{name}")
    aligned = BUILD / "aligned.apk"
    run(tools / "zipalign.exe", "-P", "16", "-f", "4", apk, aligned)
    signed = BUILD / "signed.apk"
    sign(java, jdk, tools, aligned, signed)
    run(tools / "zipalign.exe", "-c", "-P", "16", "4", signed)
    run(tools / "aapt2.exe", "dump", "badging", signed)
    output = MOBILE / "ORBITAL-Offline.apk"
    signed.replace(output)
    print(output, flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jdk", type=Path, default=os.environ.get("JAVA_HOME"),
                        help="JDK 17 or newer (defaults to JAVA_HOME)")
    parser.add_argument("--ndk", type=Path, help="Existing Windows Android NDK r28c")
    options = parser.parse_args()
    if options.jdk is None or not (options.jdk / "bin/javac.exe").is_file():
        parser.error("--jdk must point to a JDK 17+ installation")
    build(options.jdk, options.ndk)
