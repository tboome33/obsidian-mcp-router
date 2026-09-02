// env-echo — a REAL executable that reports what it was given.
//
// tests/subprocess-env.test.mjs compiles this with the csc.exe that ships in
// every Windows .NET Framework install, then points MARKITDOWN_PATH,
// DOCLING_PATH, YTDLP_PATH, REPOMIX_PATH, PDF_IMAGES_PYTHON and PATH at copies
// of it, and drives the router's real spawn sites. Each copy writes its
// environment, working directory and argv to `env-dump.json` beside itself,
// then produces whatever artifact the impersonated tool's caller goes on to
// read (a `.md` in --output, a `.png` in --out, a `.vtt` beside -o), so the
// call completes exactly as it would with the real tool.
//
// Why a compiled binary and not a script: on Windows, `execFile` without a
// shell can only start a PE image, and every tool here is launched with a
// fixed argv whose first token is a long option — no interpreter on the
// machine will run a script under those arguments. On POSIX the test writes an
// equivalent shebang script instead.
using System;
using System.Collections;
using System.IO;
using System.Text;

class EnvEcho {
  static string J(string s) {
    var sb = new StringBuilder("\"");
    foreach (char c in s) {
      switch (c) {
        case '"': sb.Append("\\\""); break;
        case '\\': sb.Append("\\\\"); break;
        case '\n': sb.Append("\\n"); break;
        case '\r': sb.Append("\\r"); break;
        case '\t': sb.Append("\\t"); break;
        default:
          if (c < 0x20 || c > 0x7e) sb.Append("\\u").Append(((int)c).ToString("x4"));
          else sb.Append(c);
          break;
      }
    }
    return sb.Append('"').ToString();
  }

  static int Main(string[] args) {
    var sb = new StringBuilder();
    sb.Append("{\"cwd\":").Append(J(Environment.CurrentDirectory));
    sb.Append(",\"argv\":[");
    for (int i = 0; i < args.Length; i++) { if (i > 0) sb.Append(','); sb.Append(J(args[i])); }
    sb.Append("],\"env\":{");
    bool first = true;
    foreach (DictionaryEntry e in Environment.GetEnvironmentVariables()) {
      if (!first) sb.Append(',');
      first = false;
      sb.Append(J((string)e.Key)).Append(':').Append(J(((string)e.Value) ?? ""));
    }
    sb.Append("}}");
    string self = System.Reflection.Assembly.GetExecutingAssembly().Location;
    File.WriteAllText(Path.Combine(Path.GetDirectoryName(self), "env-dump.json"), sb.ToString(), new UTF8Encoding(false));

    for (int i = 0; i < args.Length - 1; i++) {
      if (args[i] == "--output") {
        Directory.CreateDirectory(args[i + 1]);
        File.WriteAllText(Path.Combine(args[i + 1], "out.md"), "# env-echo\n");
      }
      if (args[i] == "--out") {
        Directory.CreateDirectory(args[i + 1]);
        File.WriteAllBytes(Path.Combine(args[i + 1], "page-0001.png"), new byte[] { 0x89, 0x50, 0x4e, 0x47 });
      }
      if (args[i] == "-o") {
        string d = Path.GetDirectoryName(args[i + 1]);
        Directory.CreateDirectory(d);
        File.WriteAllText(Path.Combine(d, "sub.en.vtt"), "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nenv-echo\n");
      }
    }
    foreach (string a in args) {
      if (a == "--version") { Console.Out.Write("Python 3.99.0\n"); return 0; }
    }
    Console.Out.Write("env-echo ok\n");
    return 0;
  }
}
