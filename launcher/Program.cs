using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Windows.Forms;

namespace RoyStudioDesktopLauncher
{
    internal static class Program
    {
        private static readonly Dictionary<string, string> MimeTypes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            { ".html", "text/html; charset=utf-8" },
            { ".js", "application/javascript; charset=utf-8" },
            { ".mjs", "application/javascript; charset=utf-8" },
            { ".css", "text/css; charset=utf-8" },
            { ".json", "application/json; charset=utf-8" },
            { ".png", "image/png" },
            { ".jpg", "image/jpeg" },
            { ".svg", "image/svg+xml" },
            { ".ico", "image/x-icon" }
        };

        private static int GetFreePort()
        {
            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            int port = ((IPEndPoint)listener.LocalEndpoint).Port;
            listener.Stop();
            return port;
        }

        private static string FindBrowser()
        {
            string[] candidates =
            {
                @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                @"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
                @"C:\Program Files\Google\Chrome\Application\chrome.exe",
                @"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
            };
            foreach (var p in candidates)
            {
                if (File.Exists(p)) return p;
            }
            return null;
        }

        [STAThread]
        private static void Main()
        {
            string exeDir = AppDomain.CurrentDomain.BaseDirectory;
            string webRoot = Path.Combine(exeDir, "src");
            if (!Directory.Exists(webRoot))
            {
                webRoot = Path.GetFullPath(Path.Combine(exeDir, @"..\src"));
            }
            if (!Directory.Exists(webRoot))
            {
                MessageBox.Show("Не найдена папка src/ рядом с RoyStudioDesktop.exe", "RoyStudio Desktop", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            int port = GetFreePort();
            string prefix = string.Format("http://127.0.0.1:{0}/", port);
            var http = new HttpListener();
            http.Prefixes.Add(prefix);
            http.Start();

            bool running = true;
            var serverThread = new Thread(() =>
            {
                while (running)
                {
                    try
                    {
                        var ctx = http.GetContext();
                        ThreadPool.QueueUserWorkItem(_ => HandleRequest(ctx, webRoot));
                    }
                    catch
                    {
                        if (!running) break;
                    }
                }
            }) { IsBackground = true };
            serverThread.Start();

            string url = prefix + "index.html";
            string browser = FindBrowser();
            if (browser != null)
            {
                string profileDir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "RoyStudioDesktop", "WebProfile"
                );
                Directory.CreateDirectory(profileDir);

                var psi = new ProcessStartInfo
                {
                    FileName = browser,
                    Arguments = string.Format("--app=\"{0}\" --user-data-dir=\"{1}\" --window-size=1440,880 --no-first-run", url, profileDir),
                    UseShellExecute = false
                };
                using (var proc = Process.Start(psi))
                {
                    if (proc != null) proc.WaitForExit();
                }
            }
            else
            {
                Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
                MessageBox.Show("RoyStudio Desktop запущен в браузере.\nНажмите OK, чтобы остановить локальный сервер.", "RoyStudio Desktop", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }

            running = false;
            try { http.Stop(); } catch { }
        }

        private static void HandleRequest(HttpListenerContext ctx, string webRoot)
        {
            try
            {
                string rel = (ctx.Request.Url.AbsolutePath ?? "/").TrimStart('/');
                if (string.IsNullOrEmpty(rel)) rel = "index.html";
                rel = rel.Replace('/', Path.DirectorySeparatorChar);
                string full = Path.GetFullPath(Path.Combine(webRoot, rel));
                string rootFull = Path.GetFullPath(webRoot);
                if (!full.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase) || !File.Exists(full))
                {
                    ctx.Response.StatusCode = 404;
                    ctx.Response.Close();
                    return;
                }
                string ext = Path.GetExtension(full);
                string mime;
                if (!MimeTypes.TryGetValue(ext, out mime)) mime = "application/octet-stream";
                byte[] data = File.ReadAllBytes(full);
                ctx.Response.ContentType = mime;
                ctx.Response.ContentLength64 = data.Length;
                ctx.Response.OutputStream.Write(data, 0, data.Length);
                ctx.Response.Close();
            }
            catch
            {
                try { ctx.Response.Abort(); } catch { }
            }
        }
    }
}
