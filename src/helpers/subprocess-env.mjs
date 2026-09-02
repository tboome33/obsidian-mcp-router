/**
 * subprocess-env.mjs — the environment a child process receives, built from a
 * per-tool ALLOWLIST OF NAMES. Never ...process.env, never a prefix rule.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS CLOSES
 * ---------------------------------------------------------------------------
 * Confirmed 2026-09-02 by an adversarial Codex review (DonSeTch study, lot
 * W-0, point P3): not one `execFile` / `spawn` call in this repository passed
 * an `env` option, so every child inherited the router's ENTIRE environment.
 *
 * That environment is not innocent. `bin/obsidian-mcp-router.mjs` loads the
 * workspace .env into process.env at startup, and the MCP host adds
 * whatever its server declaration carries — so `OBSIDIAN_ROUTER_SMART_LINK_SECRET`,
 * `OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN`, and any `*_API_KEY` a user keeps in the
 * same `.env` for other tools were handed, verbatim, to markitdown, Docling,
 * repomix, yt-dlp, and a `python --version` probe. A crash dump, a `--verbose`
 * flag, a plugin one of those tools loads, or a tool doing what an
 * attacker-controlled URL made it fetch is enough to read them back out.
 *
 * And a workspace `.env` is not only a place secrets leak FROM: it is a place
 * an attacker writes TO. A cloned repository carrying `.env` is loaded by the
 * router at startup, so anything that file can set and a child would obey —
 * `NODE_OPTIONS=--require=…` for a Node child, `GIT_SSH_COMMAND` for git,
 * `npm_config_registry` for npm — was a code-execution path. That is why this
 * module has a NEVER list as well as an allowlist (see below).
 *
 * This module filters what a CHILD receives, by name; it cannot know where a
 * value came from. The other half lives in workspace-dotenv.mjs: a workspace
 * .env may set ONLY the handful of keys the router's own writers put there
 * (the default vault, the lock, the auto-enrich mode, VAULT_PATH, the MD_*
 * sandbox, the enumerated NO_* opt-outs), so a repository's .env can no
 * longer put a GIT_CONFIG_GLOBAL, a HOME, a tool override — or an
 * OBSIDIAN_ROUTER_CONFIG — into this process in the first place. Together
 * the two fences close the vector above; either one alone would not.
 *
 * The rule is the one a careful operator applies by hand: a child gets what
 * IT needs to do the job the router asked of it — nothing that merely happens
 * to be in the parent. The tables below are that "needs" list, per tool,
 * MEASURED on this repository's real toolchain ON WINDOWS (markitdown on an
 * accented document, a full Docling conversion, yt-dlp, repomix, the
 * PowerShell process scan, `python --version`); the POSIX names come from the
 * tools' documentation and are exercised by the CI ubuntu leg through the
 * fake instrument only. The v0.87.0 changelog records the runs.
 *
 * ---------------------------------------------------------------------------
 * HOW A SITE USES IT
 * ---------------------------------------------------------------------------
 *
 *     execFileAsync(cmd, args, subprocessOptions('markitdown', { cwd, maxBuffer }))
 *
 * `subprocessOptions` REFUSES an `env` key: the environment is never supplied
 * whole. Additions go through `extraEnv`, and an `extraEnv` key is accepted
 * ONLY if the tool's own allowlist names it — so a call site cannot launder
 * `{ ...process.env }` back in through the side door, and a fixed value
 * cannot be overridden from there either. `tests/subprocess-env.test.mjs`
 * proves, with a REAL executable that prints its environment, that a sentinel
 * set in the router does not reach any of the guarded children — and that the
 * same sentinel DOES reach a child spawned without this helper, so the test
 * cannot pass by accident. Its structural guard then requires every spawn in
 * `src/`, `scripts/`, `hooks/` and `bin/` to pass `subprocessOptions(...)` as
 * its options argument, or to be listed there by file, by count and by
 * command, with a reason.
 *
 * ---------------------------------------------------------------------------
 * WHY EXPLICIT NAMES, AND NO PREFIX AT ALL
 * ---------------------------------------------------------------------------
 * An `OBSIDIAN_ROUTER_*` rule would have carried the two secrets above
 * straight through, because they share their prefix with the configuration
 * variables. A `GIT_*` rule would have carried `GIT_SSH_COMMAND` (a command),
 * `GIT_CONFIG_VALUE_n` (arbitrary config), `GIT_DIR` (another repository);
 * an `npm_config_*` rule would have carried `npm_config__authToken` (a
 * secret) and `npm_config_registry` (a supply-chain redirect). So every name
 * is written out — including the locale family, which used to be `LC_*`.
 *
 * THE NEVER LIST — a second fence, independent of the tables. A name that
 * carries a command, a library injection, an interpreter hijack, a
 * repository redirect or a credential is refused everywhere: from the source,
 * from `extraEnv`, and from the tables themselves (the module throws at load
 * if an allowlist ever names one). It is a backstop for the day a name is
 * added in a hurry, not the primary mechanism.
 *
 * WHAT IS DELIBERATELY NOT PASSED
 *   - `HF_TOKEN`, `NPM_TOKEN`, `GITHUB_TOKEN` — real secrets. Docling's default
 *     models are public and the router's npm dependencies are public; a job
 *     that needs one of these is not a job the router asks for.
 *   - `PYTHONPATH`, `PYTHONHOME`, `PYTHONSTARTUP` — an import-hijack surface
 *     with no legitimate use for a venv the router installed itself.
 *   - `NODE_OPTIONS` and `NODE_TLS_REJECT_UNAUTHORIZED` — the first executes
 *     code at start-up (`--require`), the second turns TLS off; both are
 *     settable from a workspace `.env`. An operator's `--max-old-space-size`
 *     no longer reaches repomix or the provisioning engine: that is a
 *     deliberate behaviour change, recorded in the v0.87.0 changelog.
 *     `NODE_EXTRA_CA_CERTS` (a CA file to trust) and `NODE_USE_ENV_PROXY`
 *     still pass — they add trust, they cannot execute anything.
 *
 * ONE FIXED VALUE: `PYTHONIOENCODING=utf-8` for the five Python children this
 * module guards (markitdown, the python probe, the render script, Docling,
 * yt-dlp). Measured on Windows: without it a piped Python stdout uses the
 * ANSI code page, so `Élève — café` reached the router as `�l�ve � caf�` —
 * under the full inherited environment too, i.e. this was the shipped
 * behaviour of eight conversion tools. The router decodes stdout as UTF-8, so
 * the child must write UTF-8; this is a requirement of the pipe, not a
 * preference to pass through, which is why it is applied LAST and neither a
 * source value nor `extraEnv` can override it.
 *
 * `withIsolatedCwd` is the companion: a private, empty, throwaway working
 * directory for tools that do not need the router's. MEASURED: yt-dlp reads a
 * `yt-dlp.conf` from its current directory (its "home configuration"), and
 * the router's cwd is the user's WORKSPACE — a repository carrying that file
 * could have appended `--exec …` to every caption fetch. repomix reads
 * `repomix.config.json` from cwd the same way. A consequence the resolvers
 * handle: a RELATIVE executable override (`MARKITDOWN_PATH=./venv/bin/x`) is
 * made absolute against the router's cwd BEFORE the spawn, or it would be
 * looked up inside the throwaway directory.
 *
 * Node builtins only: `ensure-deps.mjs` imports this before any dependency is
 * known to exist.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// The NEVER list — refused everywhere, whatever the tables say.
// ---------------------------------------------------------------------------

/**
 * Names and shapes no child may receive. Names are matched case-insensitively
 * on every platform (a denylist that cares about case is a denylist with a
 * hole); patterns are tested against the upper-cased name.
 */
export const NEVER_PASS = Object.freeze({
  names: Object.freeze([
    // executes code, or turns a protection off, in a Node child
    'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_REPL_EXTERNAL_MODULE',
    // library injection
    'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
    // interpreter hijack
    'PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'PYTHONEXECUTABLE', 'PYTHONUSERBASE',
    // git: runs a command, points at another repository, or injects config
    'GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_PROXY_COMMAND', 'GIT_ASKPASS', 'SSH_ASKPASS',
    'GIT_EXEC_PATH', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
    'GIT_CONFIG_SYSTEM', 'GIT_CONFIG', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'GIT_PAGER',
    'GIT_EXTERNAL_DIFF', 'GIT_TEMPLATE_DIR', 'GIT_NAMESPACE',
    // editors and pagers are commands
    'EDITOR', 'VISUAL', 'PAGER',
    // npm: registry redirect and auth
    'npm_config_registry', 'npm_config_userconfig', 'npm_config_globalconfig', 'npm_config_prefix',
    'npm_config_script_shell', 'npm_config_ignore_scripts', 'npm_config_ca', 'npm_config_cafile',
    'npm_config_strict_ssl', 'npm_config__auth', 'npm_config_otp',
    // code loading by a side door: a warnings filter names a module Python
    // IMPORTS to resolve the category (`-W default::pkg.Cls`); PSModulePath
    // is where PowerShell auto-loads modules from, CimCmdlets included — and
    // the CIM scan was measured to work without it.
    'PYTHONWARNINGS', 'PSModulePath',
  ]),
  // Credential shapes match on WORD boundaries (`_TOKEN`, `TOKEN_`, a bare
  // `TOKEN`), so `TOKENIZERS_PARALLELISM` — a real Hugging Face knob Docling's
  // stack reads — is not mistaken for a secret.
  patterns: Object.freeze([
    /^GIT_CONFIG_(KEY|VALUE)_/,
    /(?:^|_)TOKENS?(?:_|$)|AUTHTOKEN|(?:^|_)SECRETS?(?:_|$)|PASSWORD|PASSWD|CREDENTIALS?|COOKIES?|API_?KEYS?|PRIVATE_?KEY|ASKPASS/,
    /_AUTH$|_COMMAND$|_EXEC$|_PRELOAD$|_INSERT_LIBRARIES$/,
  ]),
});

const NEVER_NAMES = new Set(NEVER_PASS.names.map((n) => n.toUpperCase()));

/** True when `name` may never reach a child, on any platform. */
export function isNeverPassed(name) {
  const upper = String(name).toUpperCase();
  if (NEVER_NAMES.has(upper)) return true;
  return NEVER_PASS.patterns.some((re) => re.test(upper));
}

// ---------------------------------------------------------------------------
// The platform base — what every child needs to START, on this OS.
// ---------------------------------------------------------------------------

// Every child, every platform. PATH is where the executable and its helpers
// (git for repomix, a venv's interpreter for a console-script launcher) are
// found — and libuv resolves a bare command name through the CHILD's PATH,
// measured, so it can never be omitted. HOME is listed for every platform:
// Git for Windows and MSYS shells set it, and git reads it before USERPROFILE.
// The locale family is written out: `LC_*` used to be the one prefix left.
const COMMON_NAMES = [
  'PATH', 'HOME', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LANGUAGE', 'TZ',
  'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LC_COLLATE', 'LC_NUMERIC', 'LC_TIME', 'LC_MONETARY',
];

// Windows: what the C runtime, Python and cmd.exe need to start at all
// (SystemRoot, ComSpec, PATHEXT), the profile roots every tool keeps its
// configuration and caches under, and the processor facts `platform.machine()`
// reports from. None of these can hold a secret.
const WIN32_NAMES = [
  'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'USERNAME',
  'OS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432', 'NUMBER_OF_PROCESSORS',
];

// POSIX: the identity a tool writes into a commit or a cache path, and the XDG
// roots where it keeps its configuration.
const POSIX_NAMES = ['USER', 'LOGNAME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR'];

// ---------------------------------------------------------------------------
// Families a tool may need, by what the tool does. Names only.
// ---------------------------------------------------------------------------

// `paths` names the variables whose VALUE is a filesystem path. A child that
// runs in a private working directory (markitdown, repomix, Docling, the
// render script, yt-dlp) would otherwise read `DOCLING_ARTIFACTS_PATH=./artifacts`
// or `SSL_CERT_FILE=ca.pem` relative to a throwaway temp dir; those values are
// made absolute against the ROUTER's cwd before the spawn, exactly like a
// relative executable override. Absolute values are passed byte-for-byte.
// `pathLists` names the variables whose value is a DELIMITED LIST of paths
// (SSL_CERT_DIR): each entry is resolved on its own, the delimiter of the
// child's platform and any empty entry preserved.
const GROUPS = Object.freeze({
  // Anything that opens a socket: proxies and the CA bundles a corporate
  // network makes mandatory. Both spellings of the proxy variables, because
  // curl-derived tools read the lowercase ones and ignore the uppercase.
  network: {
    names: [
      'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
      'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
      'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
    ],
    paths: ['SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE'],
    // OpenSSL reads SSL_CERT_DIR as a LIST of directories (':' on POSIX, ';'
    // on Windows): each relative entry is made absolute on its own.
    pathLists: ['SSL_CERT_DIR'],
  },
  // A Python interpreter, launched by absolute path from a venv the router
  // installed (or an operator's explicit override). Encoding and buffering
  // knobs only — nothing that changes WHAT gets imported: not PYTHONPATH, and
  // not PYTHONWARNINGS either, whose filter can name a module the interpreter
  // imports to resolve the category (both on the NEVER list).
  python: {
    names: ['PYTHONUTF8', 'PYTHONUNBUFFERED', 'PYTHONDONTWRITEBYTECODE', 'PYTHONNOUSERSITE'],
    fixed: { PYTHONIOENCODING: 'utf-8' },
  },
  // A Node process: TLS trust for it, and the two Electron switches. NOT
  // `NODE_OPTIONS` — see the header. `ELECTRON_RUN_AS_NODE` matters when the
  // host runs this server inside Electron (Claude Desktop, the .mcpb bundle):
  // there `process.execPath` is the host binary, and a child started from it
  // WITHOUT that variable launches the application instead of the script.
  // It reached children by inheritance before v0.87.0; it is named now.
  node: {
    names: ['NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE'],
    paths: ['NODE_EXTRA_CA_CERTS'],
  },
  // git, and anything that runs git: the identity it writes into a commit,
  // where its global config lives, the SSH agent and the signing agent.
  // Written out — `GIT_SSH_COMMAND`, `GIT_CONFIG_VALUE_n`, `GIT_DIR` and the
  // like are on the NEVER list and would have ridden a `GIT_*` prefix.
  git: {
    names: [
      'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE',
      'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE',
      'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT', 'GIT_CEILING_DIRECTORIES',
      // a corporate CA declared to git by variable rather than by config
      'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH',
      'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'GPG_TTY', 'GNUPGHOME', 'EMAIL', 'TERM', 'DISPLAY',
    ],
    paths: ['GIT_CONFIG_GLOBAL', 'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH', 'GNUPGHOME'],
  },
  // Docling: where its layout/table models are cached, and the thread knobs
  // torch and onnxruntime read. `HF_TOKEN` is deliberately absent — see the
  // header. `DOCLING_ARTIFACTS_PATH` is the documented local-models root.
  ml: {
    names: [
      'HF_HOME', 'HF_HUB_CACHE', 'HF_HUB_OFFLINE', 'HF_HUB_DISABLE_TELEMETRY', 'HF_HUB_DISABLE_PROGRESS_BARS', 'HF_ENDPOINT',
      'TRANSFORMERS_CACHE', 'TRANSFORMERS_OFFLINE', 'TORCH_HOME', 'TOKENIZERS_PARALLELISM',
      'OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'CUDA_VISIBLE_DEVICES',
      'TESSDATA_PREFIX', 'KMP_DUPLICATE_LIB_OK', 'DOCLING_ARTIFACTS_PATH',
    ],
    paths: ['HF_HOME', 'HF_HUB_CACHE', 'TRANSFORMERS_CACHE', 'TORCH_HOME', 'TESSDATA_PREFIX', 'DOCLING_ARTIFACTS_PATH'],
  },
});

// ---------------------------------------------------------------------------
// The tools — one entry per thing the router spawns. An unknown name throws:
// a new spawn site must say what it runs and what that needs.
// ---------------------------------------------------------------------------

export const SUBPROCESS_TOOLS = Object.freeze({
  // The markitdown Python CLI, behind eight conversion tools. It reads a file
  // the router already fetched — no network of its own in this flow.
  markitdown: { groups: ['python'], runs: 'the markitdown CLI (src/markdownify/markitdown.mjs)' },
  // `python --version`, twice, on the markitdown ENOENT path and in the installers.
  'python-probe': { groups: ['python'], runs: 'python3/python --version (src/helpers/conversion-readiness.mjs)' },
  // scripts/render-pdf-images.py under the Docling venv's interpreter.
  'pdf-images': { groups: ['python'], runs: 'the pdf_to_images render script (src/markdownify/pdf-images.mjs)' },
  // Docling downloads its models on first use, so it gets the network family.
  docling: { groups: ['python', 'network', 'ml'], runs: 'the docling CLI (src/markdownify/docling.mjs)' },
  // yt-dlp is a Python program (a PyInstaller binary or a zipapp) that talks to YouTube.
  'yt-dlp': { groups: ['python', 'network'], runs: 'yt-dlp caption fetch (src/markdownify/youtube-fallback.mjs)' },
  // repomix is Node, and clones the remote repository with git.
  repomix: { groups: ['node', 'network', 'git'], runs: 'repomix --remote (src/markdownify/markitdown.mjs)' },
  // git talks to a remote in plugin-auto-update (fetch/pull), so it gets the
  // network family: a corporate proxy or CA bundle must reach it.
  git: { groups: ['git', 'network'], runs: 'git (hooks/wiki-autocommit.mjs, scripts/setup-vault.mjs, src/helpers/plugin-auto-update.mjs)' },
  // npm: its cache and its chatter knobs, and proxies. NOT the registry, the
  // user/global config files, the script shell or any auth — a workspace
  // `.env` could set those, and `npm install` would then obey a stranger.
  // `NPM_TOKEN` is deliberately absent — the router's dependencies are public.
  // `OBSIDIAN_ROUTER_SKIP_MARKITDOWN` is the belt-and-braces flag ensure-deps
  // adds through `extraEnv`, so it must be named here to be accepted there.
  npm: {
    groups: ['node', 'network'],
    names: [
      'CI', 'NO_COLOR', 'FORCE_COLOR', 'NO_UPDATE_NOTIFIER',
      'npm_config_cache', 'npm_config_loglevel', 'npm_config_progress', 'npm_config_color',
      'npm_config_fund', 'npm_config_audit', 'npm_config_update_notifier',
      'OBSIDIAN_ROUTER_SKIP_MARKITDOWN',
    ],
    paths: ['npm_config_cache'],
    runs: 'npm install (src/helpers/ensure-deps.mjs, src/helpers/plugin-auto-update.mjs)',
  },
  // `powershell -NoProfile … Get-CimInstance` / `ps -eo args`. Measured: the
  // CIM query lists every process with PATH and SystemRoot alone. PSModulePath
  // is NOT passed: it is where PowerShell auto-loads modules from (CimCmdlets
  // included), so it is on the NEVER list; the shell rebuilds its default
  // module path when the variable is absent.
  'process-scan': { runs: 'the live-process scan (src/helpers/plugin-cache-purge.mjs)' },
  taskkill: { runs: 'taskkill /T on a timed-out npm (src/helpers/ensure-deps.mjs)' },
  // This package's own provisioning engine, run as a child of the MCP server,
  // of the CLI (`--attach`) and of the SessionStart sync hook. It reads three
  // OBSIDIAN_ROUTER_* variables — named, not prefixed, because the same prefix
  // carries the smart-link secret — spawns git, and fetches from GitHub.
  // With `--open` the engine ends by launching the desktop app through the OS
  // handler (`cmd /c start`, `open`, `xdg-open`), which on Linux needs the
  // graphical session's sockets to reach the running Obsidian — paths and
  // addresses, not secrets — so those are named here too.
  'setup-vault': {
    groups: ['node', 'network', 'git'],
    names: [
      'OBSIDIAN_ROUTER_CONFIG', 'OBSIDIAN_ROUTER_NO_AUTO_INSTALL_HOOKS', 'OBSIDIAN_ROUTER_PROVISION_NONCE',
      'NO_COLOR', 'FORCE_COLOR', 'CI',
      'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_SESSION_TYPE',
      // where xdg-open finds a Flatpak/Snap Obsidian's protocol handler
      'XDG_DATA_DIRS', 'XDG_CURRENT_DESKTOP', 'DESKTOP_SESSION',
    ],
    runs: 'scripts/setup-vault.mjs (src/helpers/vault-wizard-engine.mjs, bin/obsidian-mcp-router.mjs --attach, scripts/sync-hook.mjs)',
  },
});

/**
 * The names and fixed values a tool's environment is built from, for
 * `platform`. Exported so a test can state properties of the whole table
 * ("no name looks like a secret") rather than of one call.
 *
 * @param {string} tool a key of SUBPROCESS_TOOLS
 * @param {string} [platform]
 * @returns {{ names: string[], paths: string[], pathLists: string[], fixed: Record<string,string> }}
 */
export function allowlistFor(tool, platform = process.platform) {
  const spec = SUBPROCESS_TOOLS[tool];
  if (!spec) {
    throw new Error(
      `subprocess-env: unknown tool "${tool}" — add it to SUBPROCESS_TOOLS with an explicit allowlist ` +
        `(known: ${Object.keys(SUBPROCESS_TOOLS).join(', ')})`,
    );
  }
  const groups = (spec.groups || []).map((g) => {
    const group = GROUPS[g];
    if (!group) throw new Error(`subprocess-env: tool "${tool}" names an unknown group "${g}"`);
    return group;
  });
  const names = [
    ...COMMON_NAMES,
    ...(platform === 'win32' ? WIN32_NAMES : POSIX_NAMES),
    ...groups.flatMap((g) => g.names || []),
    ...(spec.names || []),
  ];
  const paths = [
    ...groups.flatMap((g) => g.paths || []),
    ...(spec.paths || []),
  ];
  const pathLists = [
    ...groups.flatMap((g) => g.pathLists || []),
    ...(spec.pathLists || []),
  ];
  const fixed = Object.assign({}, ...groups.map((g) => g.fixed || {}));
  return { names: [...new Set(names)], paths: [...new Set(paths)], pathLists: [...new Set(pathLists)], fixed };
}

/**
 * A path-valued variable, made absolute against the router's cwd when it is
 * relative — the child may run in a throwaway directory where `./artifacts`
 * or `ca.pem` would mean nothing. An absolute value, or an empty one, is
 * returned byte-for-byte.
 */
function absolutizePathValue(value) {
  const t = String(value).trim();
  if (!t || path.isAbsolute(t)) return value;
  return path.resolve(t);
}

/**
 * A path-LIST variable (SSL_CERT_DIR): every entry made absolute on its own;
 * the delimiter of the CHILD's platform and any empty entry are preserved.
 */
function absolutizePathList(value, platform) {
  const delimiter = platform === 'win32' ? ';' : ':';
  return String(value).split(delimiter).map((entry) => absolutizePathValue(entry)).join(delimiter);
}

// The tables cannot name what the NEVER list refuses. Checked once, at load,
// so a hurried addition fails the import — and the first test — not a user.
for (const tool of Object.keys(SUBPROCESS_TOOLS)) {
  for (const platform of ['win32', 'linux']) {
    const { names, fixed } = allowlistFor(tool, platform);
    for (const n of [...names, ...Object.keys(fixed)]) {
      if (isNeverPassed(n)) {
        throw new Error(`subprocess-env: the "${tool}" allowlist names "${n}", which is on the NEVER list`);
      }
    }
  }
}

/**
 * Build the environment for `tool` from `source` (default process.env).
 *
 * Windows environment names are case-insensitive, and a shell may spell
 * `SystemRoot` as `SYSTEMROOT` or `Path` as `PATH`; matching is therefore
 * case-insensitive on win32 and the SOURCE's spelling is what the child sees.
 * Order: the allowlisted names are copied from the source; `extra` is layered
 * on — every key of it must be in the tool's allowlist, or the call throws;
 * the fixed values are applied LAST, so neither the source nor `extra` can
 * override them. The NEVER list is enforced on every key, from every origin.
 *
 * @param {string} tool
 * @param {{ source?: object, platform?: string, extra?: object }} [opts]
 * @returns {Record<string,string>}
 */
export function buildSubprocessEnv(tool, { source = process.env, platform = process.platform, extra = {} } = {}) {
  const { names, paths, pathLists, fixed } = allowlistFor(tool, platform);
  const win = platform === 'win32';
  const norm = (k) => (win ? String(k).toUpperCase() : String(k));
  const wanted = new Set(names.map(norm));
  const pathValued = new Set(paths.map(norm));
  const listValued = new Set(pathLists.map(norm));
  const fixedNorm = new Set(Object.keys(fixed).map(norm));
  const resolved = (nk, value) => {
    if (pathValued.has(nk)) return absolutizePathValue(value);
    if (listValued.has(nk)) return absolutizePathList(value, platform);
    return value;
  };

  const out = {};
  const keyByNorm = new Map();
  const put = (key, value) => {
    const nk = norm(key);
    const prev = keyByNorm.get(nk);
    // Two spellings of one Windows name would give the child a block with a
    // duplicate — libuv rejects that. Keep the latest, drop the earlier.
    if (prev !== undefined && prev !== key) delete out[prev];
    keyByNorm.set(nk, key);
    out[key] = value;
  };

  for (const key of Object.keys(source || {})) {
    const value = source[key];
    if (typeof value !== 'string') continue;
    const nk = norm(key);
    if (!wanted.has(nk) || fixedNorm.has(nk) || isNeverPassed(key)) continue;
    put(key, resolved(nk, value));
  }
  for (const [key, value] of Object.entries(extra || {})) {
    // The KEY is judged before the value: a null under a forbidden name is
    // still a call site naming something it may not name.
    const nk = norm(key);
    if (isNeverPassed(key)) {
      throw new Error(`subprocess-env: extraEnv "${key}" for "${tool}" is on the NEVER list`);
    }
    if (fixedNorm.has(nk)) {
      throw new Error(`subprocess-env: extraEnv cannot override the fixed "${key}" of "${tool}"`);
    }
    if (!wanted.has(nk)) {
      throw new Error(
        `subprocess-env: extraEnv "${key}" is not in the "${tool}" allowlist — ` +
          'add it to SUBPROCESS_TOOLS by name, in a change that says which tool reads it and why',
      );
    }
    if (value === undefined || value === null) continue;
    put(key, resolved(nk, String(value)));
  }
  for (const [key, value] of Object.entries(fixed)) put(key, value);
  return out;
}

/**
 * The options object for `execFile` / `spawn` / `spawnSync`: `options` with
 * the tool's environment added. Refuses an `env` key — the environment is
 * never supplied whole; additions go through `extraEnv`, and only names the
 * tool's allowlist already carries are accepted there.
 *
 * @param {string} tool
 * @param {object} [options] any child_process option except `env`, plus `extraEnv`
 */
export function subprocessOptions(tool, options = {}) {
  const opts = options || {};
  if (Object.prototype.hasOwnProperty.call(opts, 'env')) {
    throw new Error(
      `subprocess-env: refusing an \`env\` option for "${tool}" — the child environment is built ` +
        'from the allowlist; add variables through `extraEnv`',
    );
  }
  const { extraEnv, ...rest } = opts;
  return { ...rest, env: buildSubprocessEnv(tool, { extra: extraEnv || {} }) };
}

/**
 * An executable override taken from the environment (`MARKITDOWN_PATH`,
 * `REPOMIX_PATH`, `YTDLP_PATH`, `DOCLING_PATH`, `PDF_IMAGES_PYTHON`): a bare
 * command name is returned as-is for the child's PATH lookup; anything with a
 * path separator is made absolute against the router's cwd NOW, because the
 * spawn may run in a throwaway directory where a relative path means nothing.
 *
 * @param {string|undefined} value
 * @returns {string|undefined}
 */
export function absolutizeExecutableOverride(value) {
  if (!value) return value;
  const s = String(value);
  // A bare name and an absolute path are returned BYTE-FOR-BYTE — padding
  // included: `path.resolve` would normalise separators and strip spaces, and
  // the readiness probe compares the runtime's path with the configured one
  // verbatim (a check that names a different path than the one that runs is
  // a check that lies). Only a genuinely relative path changes.
  const t = s.trim();
  if (!/[\\/]/.test(t) || path.isAbsolute(t)) return s;
  return path.resolve(t);
}

/**
 * Run `fn(dir)` with `dir` a fresh, private, empty directory under the system
 * temp root, removed afterwards whether `fn` resolved or threw. The directory
 * exists when `fn` runs, so a spawn that uses it as `cwd` cannot fail with the
 * ENOENT that a missing cwd produces — which every ENOENT-branch in this
 * repository would otherwise read as "the executable is not installed".
 *
 * @template T
 * @param {string} prefix mkdtemp prefix, e.g. `markitdown-cwd-`
 * @param {(dir: string) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withIsolatedCwd(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    // Best effort: a straggling grandchild may still hold the directory on
    // Windows. A leftover empty temp dir is a nuisance; a thrown cleanup error
    // replacing the child's real result would be a defect.
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* see above */ }
  }
}
