using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("ORBITAL Launcher")]
[assembly: AssemblyDescription("Starts the local ORBITAL mission control service")]
[assembly: AssemblyProduct("ORBITAL")]
[assembly: AssemblyVersion("1.0.0.0")]

internal static class OrbitalLauncher
{
    private const int DefaultPort = 4174;

    [STAThread]
    private static int Main(string[] args)
    {
        bool checkOnly = HasArgument(args, "--check");
        bool noBrowser = HasArgument(args, "--no-browser");
        bool quiet = checkOnly || noBrowser;
        string root = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string serverScript = Path.Combine(root, "server", "index.js");
        string node = FindNode(root);

        if (!File.Exists(serverScript)) return Fail("找不到 server\\index.js。请把 ORBITAL.exe 放在项目根目录。", quiet);
        if (node == null) return Fail("找不到 Node.js。请保留 D:\\node\\node.exe，或把 Node 加入 PATH。", quiet);
        if (checkOnly) return 0;

        int port = ReadPort();
        string baseUrl = "http://127.0.0.1:" + port;
        if (!IsOrbitalService(baseUrl))
        {
            string dataDir = Path.Combine(root, "data");
            Directory.CreateDirectory(dataDir);
            string log = Path.Combine(dataDir, "server.launcher.log");
            try { StartServer(root, node, serverScript, log); }
            catch (Exception error) { return Fail("启动服务失败：" + error.Message + "\n\n日志：" + log, quiet); }

            bool ready = false;
            for (int attempt = 0; attempt < 80; attempt++)
            {
                Thread.Sleep(250);
                if (IsOrbitalService(baseUrl)) { ready = true; break; }
            }
            if (!ready) return Fail("服务未能在 20 秒内启动。请查看：\n" + log, quiet);
        }

        if (!noBrowser)
        {
            try { Process.Start(new ProcessStartInfo(baseUrl + "/mission.html") { UseShellExecute = true }); }
            catch (Exception error) { return Fail("服务已经启动，但无法打开浏览器：" + error.Message, false); }
        }
        return 0;
    }

    private static bool HasArgument(string[] args, string wanted)
    {
        foreach (string argument in args) if (String.Equals(argument, wanted, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    private static int ReadPort()
    {
        int port;
        return Int32.TryParse(Environment.GetEnvironmentVariable("PORT"), out port) && port > 0 && port < 65536 ? port : DefaultPort;
    }

    private static string FindNode(string root)
    {
        string configured = Environment.GetEnvironmentVariable("ORBITAL_NODE_EXE");
        string[] candidates = {
            configured,
            Path.Combine(root, "runtime", "node.exe"),
            Path.Combine(root, "node.exe"),
            @"D:\node\node.exe"
        };
        foreach (string candidate in candidates) if (!String.IsNullOrWhiteSpace(candidate) && File.Exists(candidate)) return Path.GetFullPath(candidate);
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string directory in path.Split(Path.PathSeparator))
        {
            if (String.IsNullOrWhiteSpace(directory)) continue;
            try { string candidate = Path.Combine(directory.Trim(), "node.exe"); if (File.Exists(candidate)) return Path.GetFullPath(candidate); }
            catch { }
        }
        return null;
    }

    private static bool IsOrbitalService(string baseUrl)
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(baseUrl + "/health");
            request.Timeout = 700;
            request.ReadWriteTimeout = 700;
            request.Proxy = null;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
            {
                string body = reader.ReadToEnd();
                return body.IndexOf("\"status\"", StringComparison.Ordinal) >= 0;
            }
        }
        catch (WebException error)
        {
            HttpWebResponse response = error.Response as HttpWebResponse;
            if (response == null) return false;
            using (response)
            using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                return reader.ReadToEnd().IndexOf("\"status\"", StringComparison.Ordinal) >= 0;
        }
        catch { return false; }
    }

    private static void StartServer(string root, string node, string serverScript, string log)
    {
        string shell = Environment.GetEnvironmentVariable("ComSpec") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");
        string command = "\"\"" + node + "\" \"" + serverScript + "\" >> \"" + log + "\" 2>&1\"";
        ProcessStartInfo start = new ProcessStartInfo(shell, "/d /s /c " + command);
        start.WorkingDirectory = root;
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.WindowStyle = ProcessWindowStyle.Hidden;
        Process process = Process.Start(start);
        if (process == null) throw new InvalidOperationException("无法创建后台进程");
    }

    private static int Fail(string message, bool quiet)
    {
        if (!quiet) MessageBox.Show(message, "ORBITAL 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
        return 1;
    }
}
