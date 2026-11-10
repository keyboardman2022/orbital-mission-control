# ORBITAL 安卓离线版

将同目录的 `ORBITAL-Offline.apk` 复制到安卓手机后打开安装。安装包适用于 Android 8.0 及以上的 64 位 ARM 手机和 x86_64 模拟器，界面使用设备的系统 WebView。

安装后进入 3D 星图，可生成种子地图、发射和追踪卫星、回放轨迹并导出。覆盖升级后首次启动会清理应用内的旧 2D 存档。保存轨迹和恢复密钥时，系统文件选择器会让你指定位置。

应用在手机上建立独立存档。再次打开时会回到上次打开的页面及种子地图。模拟随应用进程运行，安卓结束该进程后会从最近的存档继续，停机时段不会补算。清除应用数据或卸载会清除本地存档。

## 重新构建

在项目根目录的 PowerShell 中运行，需安装 Python 3.11+ 和 JDK 17+。

```powershell
python android-offline/build.py --jdk 'C:\Path\To\JDK'
node --test android-offline/tests/offline.test.cjs
```

脚本会校验并下载固定版本的 Android SDK、NDK 和 Node.js 移动运行时。已有 Windows NDK r28c 时可传 `--ndk` 指向它的安装目录。游戏和服务源码从父目录打包，下载与中间产物保存在 `.build`。签名密钥保存在 `.signing`，后续覆盖安装须使用同一个密钥。

嵌入的 [Node.js for Mobile Apps](https://github.com/fogtape/nodejs-mobile/releases/tag/v24.22.1-0) 使用带 SQLite 的完整版本。第三方许可收录在 `NODE-LICENSE.txt`，并随 APK 打包。
