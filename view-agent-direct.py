#!/usr/bin/env python3
"""
view-agent-direct — a TUNNEL-LESS provider of the obsidian-mcp-router `/view` contract.

When to use it instead of view-agent.py
---------------------------------------
Use it when the reader can ALREADY reach the vault's web-streamed Obsidian GUI (e.g. a
Selkies container) over a private network such as WireGuard. A Cloudflare tunnel adds
nothing there, and the bridge's `/open` route stays loopback-only by design, so a link
straight to `/open` clicked from another machine gets `403 loopback only`.

What it does
------------
    GET /view?vault=<name>&note=<vault-relative-path>
      returns {"url": "<self_url>/go?v=<vault>&n=<note>[&h=<anchor>][&e=<exp>][&r=<rest>][&o=<name>]&s=<sig>"}
      (r/o: the router's vault hints, for a detected vault — see "Vault detection")
      — a link to THIS agent, HMAC-signed, pure computation (no navigation, no I/O), and
      stable in the chat history unless `link_ttl_s` is set.

    GET /go?v=&n=[&h=][&e=]&s=      (the reader's browser, on click)
      1. verifies the signature (constant-time) and the optional expiry,
      2. navigates the vault's Obsidian onto the note by calling the bridge's click-to-open
         route FROM THE CONTAINER'S LOOPBACK (`docker exec <container> curl ...`), so the
         bridge's loopback guard is satisfied without being relaxed. The route is the one
         the bridge announces in its `/ping` (`openPrefix`: `/mcp-router-bridge/open/` on
         bridge 0.10.0+, because Local REST API 5.4.0 reserves `/open/`), `/open/` for an
         older bridge — see "Click-to-open prefix" in the navigation section,
      3. answers 302 to the vault's `public_url` (the GUI).
      For a vault opened in the READER'S OWN desktop Obsidian (`open_mode: obsidian-uri`),
      steps 2-3 become a single 302 to `obsidian://open?vault=…&file=…`: nothing is driven
      from this host, the reader's Obsidian opens the note itself.
      A failed navigation yields an explicit 502 HTML page with a link to the GUI — never
      a silent redirect.

Navigating on click (not on /view) is deliberate: the router calls /view eagerly on every
note write, and navigating there would make Obsidian jump on each write. Set
`navigate_on_view: true` to navigate on both. See docs/CONTRACT.md, "Providers without a
tunnel".

Vault detection
---------------
A vault absent from `vaults` is classified from what the router knows about it, passed as
two optional /view parameters (docs/CONTRACT.md, "Vault hints"):

    rest=<scheme://host:port>   the vault's Local REST API origin, as the router reaches it
    obsidian_name=<label>       the vault's name in Obsidian (obsidian://open?vault=)

    host is this agent's host  → the ONE running container publishing that port
                                 → docker-exec on it + redirect to its published GUI port
    host is in desktop_hosts   → obsidian-uri (requires obsidian_name)
    anything else              → explicit 4xx, never a guessed link

Both hints are copied into the /go link and covered by its signature; /go re-runs the
detection on click, so a recreated container is found again. The manual `vaults` entry
always wins. Docker is only queried with fixed argument lists; the container is then
addressed by its validated hex ID, never by a string taken from the request.


Routes
------
    GET /health   — token-free, leaks nothing actionable (served vault names only)
    GET /view     — X-View-Token required when `token_file` exists
    GET /go       — signature required when a signing secret exists

Security posture
----------------
    1. NETWORK — bind to a private interface (loopback / WireGuard IP), firewall the port.
       The reader's browser must reach this agent too (it follows /go).
    2. TOKEN   — only the router (X-View-Token) can mint links.
    3. SIGNED LINKS — /go refuses any v/n/h/e the agent did not sign, so another host on
       the private network cannot drive the vault's Obsidian to arbitrary paths.
    4. GUI AUTH — the GUI is already private; the link exposes nothing new, it only
       navigates and redirects.

Python 3.8+ stdlib only — no pip dependencies. Configuration: see config.direct.example.json.
"""
import hashlib
import hmac
import html
import ipaddress
import json
import ntpath
import os
import re
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_CONFIG = {
    "bind": "127.0.0.1",
    "port": 27200,
    # Base URL under which the READER'S BROWSER reaches this agent (used to compose /go
    # links). Empty → derived from bind:port.
    "self_url": "",
    # Shared secret with the router (X-View-Token). Absent file = no token gate.
    "token_file": "view-agent.token",
    # HMAC secret for /go links. Absent file = sign with the token; both absent = unsigned
    # links (the private network is then the only lock).
    "link_secret_file": "link.secret",
    # Lifetime of /go links in seconds; 0 = no expiry (links stay valid in the chat history).
    "link_ttl_s": 0,
    # Also navigate Obsidian when /view is called. Off by default: the router calls /view
    # on every note write, which would make Obsidian jump on each write.
    "navigate_on_view": False,
    # vault name -> per-vault settings; see config.direct.example.json. Wins over detection.
    "vaults": {},
    # Classification of vaults absent from "vaults"; see DETECT_DEFAULTS.
    "detect": {},
}

DETECT_DEFAULTS = {
    "enabled": True,
    # Hosts that designate THIS machine in a router `rest` hint, besides loopback, `bind`
    # and the host of `self_url`.
    "local_hosts": [],
    # Hosts (IP, CIDR or name) whose vaults are opened in the reader's desktop Obsidian.
    # Empty: no vault is ever classified as a desktop one.
    "desktop_hosts": [],
    # Container-side port(s) of the web GUI (linuxserver/obsidian: 3001 = HTTPS), first hit wins.
    "gui_container_ports": [3001],
    # Reader-side GUI URL; {host} = host of the rest hint, {port} = the published GUI port.
    "gui_url": "https://{host}:{port}/",
    # Seconds a Docker inventory is reused (the eager /view path runs on every note write).
    "cache_s": 10,
    "docker_path": "docker",
    "curl_path": "curl",
}

VAULT_REQUIRED = ("public_url",)       # except open_mode obsidian-uri (see load_config)
VAULT_OPTIONAL = (
    "open_mode",          # "docker-exec" (default) | "http" | "none" | "obsidian-uri"
    "obsidian_vault",     # obsidian-uri: the vault's name as the reader's Obsidian knows it
    "container",          # docker-exec: container name
    "open_port",          # docker-exec: Local REST API HTTP port (insecurePort) INSIDE the container
    "open_url",           # http: Local REST API base URL (the bridge must see the call as loopback)
    "docker_path",        # docker-exec: docker binary (default "docker")
    "curl_path",          # docker-exec: curl binary INSIDE the container (default "curl")
    "open_scheme",        # docker-exec: "http" (default) | "https" (the REST API's TLS port, curl -k)
)


# ----------------------------------------------------------------------------- config

def load_config(path):
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except FileNotFoundError:
        raise ValueError("config not found: %s (copy config.direct.example.json)" % path)
    except json.JSONDecodeError as e:
        raise ValueError("config %s: invalid JSON: %s" % (path, e))

    cfg = dict(DEFAULT_CONFIG)
    cfg.update(raw or {})
    cfg["_dir"] = os.path.dirname(os.path.abspath(path))

    cfg["detect"] = _load_detect(cfg.get("detect"))
    if not isinstance(cfg.get("vaults"), dict) or not (cfg["vaults"] or cfg["detect"]["enabled"]):
        raise ValueError('config requires a non-empty "vaults" object (or detection enabled)')
    for name, v in cfg["vaults"].items():
        if not isinstance(v, dict):
            raise ValueError('vault "%s": must be an object' % name)
        mode = v.get("open_mode", "docker-exec")
        if mode not in ("docker-exec", "http", "none", "obsidian-uri"):
            raise ValueError('vault "%s": open_mode must be docker-exec | http | none | obsidian-uri' % name)
        # A desktop vault has no web GUI: it is opened by the reader's own Obsidian.
        required = () if mode == "obsidian-uri" else VAULT_REQUIRED
        for k in required:
            if not v.get(k):
                raise ValueError('vault "%s": missing required key "%s"' % (name, k))
        unknown = [k for k in v if not k.startswith("_") and k not in VAULT_REQUIRED + VAULT_OPTIONAL]
        if unknown:
            raise ValueError('vault "%s": unknown key(s) %s' % (name, ", ".join(unknown)))
        if mode == "obsidian-uri" and not (isinstance(v.get("obsidian_vault"), str) and v["obsidian_vault"].strip()):
            raise ValueError('vault "%s": open_mode obsidian-uri requires "obsidian_vault"' % name)
        if mode == "docker-exec" and not (v.get("container") and v.get("open_port")):
            raise ValueError('vault "%s": open_mode docker-exec requires "container" and "open_port"' % name)
        if v.get("open_scheme", "http") not in ("http", "https"):
            raise ValueError('vault "%s": open_scheme must be http or https' % name)
        if mode == "http" and not v.get("open_url"):
            raise ValueError('vault "%s": open_mode http requires "open_url"' % name)
    if not isinstance(cfg.get("port"), int):
        raise ValueError('"port" must be an integer')
    if not isinstance(cfg.get("link_ttl_s"), int) or cfg["link_ttl_s"] < 0:
        raise ValueError('"link_ttl_s" must be an integer >= 0')
    if not cfg.get("self_url"):
        cfg["self_url"] = "http://%s:%d" % (cfg["bind"], cfg["port"])
    cfg["self_url"] = cfg["self_url"].rstrip("/")
    d = cfg["detect"]
    local = {"127.0.0.1", "::1", "localhost"}
    for h in [cfg["bind"], urllib.parse.urlsplit(cfg["self_url"]).hostname] + d["local_hosts"]:
        if h and h not in ("0.0.0.0", "::"):
            local.add(_norm_host(h))
    d["_local"] = local
    clash = [h for h in local if _host_in(h, d["_desktop"])]
    if clash:
        raise ValueError('detect: %s is both local and in "desktop_hosts"' % ", ".join(sorted(clash)))
    return cfg


def _norm_host(h):
    h = str(h).strip().lower().rstrip(".")
    try:
        ip = ipaddress.ip_address(h.strip("[]"))
    except ValueError:
        return h
    # ::ffff:192.0.2.1 is 192.0.2.1: one spelling, so local/desktop matching cannot be sidestepped.
    return str(getattr(ip, "ipv4_mapped", None) or ip)


_HOSTNAME_RE = re.compile(r"^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)*$")


def _load_detect(raw):
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise ValueError('"detect" must be an object')
    unknown = [k for k in raw if not k.startswith("_") and k not in DETECT_DEFAULTS]
    if unknown:
        raise ValueError('detect: unknown key(s) %s' % ", ".join(unknown))
    d = dict(DETECT_DEFAULTS)
    d.update({k: v for k, v in raw.items() if not k.startswith("_")})
    if not isinstance(d["enabled"], bool):
        raise ValueError('detect.enabled must be true or false')
    for k in ("local_hosts", "desktop_hosts"):
        if not isinstance(d[k], list) or not all(isinstance(h, str) and h.strip() for h in d[k]):
            raise ValueError('detect.%s must be a list of non-empty strings' % k)
    desktop = []
    for h in d["desktop_hosts"]:
        try:
            net = ipaddress.ip_network(h.strip(), strict=False)
        except ValueError:
            net = None
        if net is not None:
            if net.version == 6 and net.subnet_of(ipaddress.ip_network("::ffff:0:0/96")):
                if net.prefixlen != 128:
                    raise ValueError('detect.desktop_hosts: write "%s" in IPv4 notation' % h)
                net = ipaddress.ip_network(_norm_host(str(net.network_address)))  # hints are normalized too
            desktop.append(net)
        else:
            n = _norm_host(h)
            if not _HOSTNAME_RE.match(n):
                raise ValueError('detect.desktop_hosts: "%s" is neither an IP, a CIDR nor a host name' % h)
            desktop.append(n)
    d["_desktop"] = desktop
    ports = d["gui_container_ports"]
    if (not isinstance(ports, list) or not ports
            or not all(isinstance(p, int) and not isinstance(p, bool) and 0 < p < 65536 for p in ports)):
        raise ValueError('detect.gui_container_ports must be a non-empty list of ports')
    g = d["gui_url"]
    if not (isinstance(g, str) and g.startswith(("http://", "https://")) and "{port}" in g):
        raise ValueError('detect.gui_url must be an http(s) URL template containing {port}')
    if re.search(r"[{}]", g.replace("{host}", "").replace("{port}", "")):
        raise ValueError('detect.gui_url may only use the {host} and {port} fields')
    if not re.fullmatch(r"https?://\{host\}:\{port\}(/[^?#]*)?", g):
        # The identity check covers the host and port the container publishes its GUI on:
        # the redirect must land exactly there, not on a fixed host or a proxy in front.
        raise ValueError('detect.gui_url must be http(s)://{host}:{port}/ optionally followed by a path')
    if not isinstance(d["cache_s"], (int, float)) or isinstance(d["cache_s"], bool) or d["cache_s"] < 0:
        raise ValueError('detect.cache_s must be a number >= 0')
    for k in ("docker_path", "curl_path"):
        if not (isinstance(d[k], str) and d[k].strip()):
            raise ValueError('detect.%s must be a non-empty string' % k)
    return d


def _host_in(host, entries):
    """host (normalized) matches a desktop_hosts entry: same name, or IP inside the network."""
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        ip = None
    for e in entries:
        if isinstance(e, str):
            if e == host:
                return True
        elif ip is not None and ip.version == e.version and ip in e:
            return True
    return False


def _resolve(cfg, p):
    return p if os.path.isabs(p) else os.path.join(cfg.get("_dir", "."), p)


def read_secret_file(cfg, key):
    """("off", None) when the file is not configured or absent; ("on", value); ("error", None)
    when the file exists but is unreadable or empty (fail CLOSED, like view-agent.py)."""
    p = cfg.get(key)
    if not p:
        return ("off", None)
    try:
        with open(_resolve(cfg, p), encoding="utf-8") as f:
            val = f.read().strip()
    except FileNotFoundError:
        return ("off", None)
    except OSError as e:
        print("view-agent-direct: %s unreadable (%s) — failing closed" % (key, e), file=sys.stderr)
        return ("error", None)
    if not val:
        print("view-agent-direct: %s is EMPTY — failing closed" % key, file=sys.stderr)
        return ("error", None)
    return ("on", val)


def link_secret(cfg):
    """Link-signing secret: link_secret_file, else token_file, else none."""
    mode, val = read_secret_file(cfg, "link_secret_file")
    if mode == "error":
        return ("error", None)
    if mode == "on":
        return ("on", val)
    return read_secret_file(cfg, "token_file")


# ----------------------------------------------------------------------------- signed links

def _canonical(vault, note, anchor, exp, hints=None):
    if hints:
        # Links carrying detection hints: an unambiguous encoding (JSON never contains a
        # raw newline), in a domain the legacy format below can never produce. Stripping
        # the hints from such a link therefore breaks its signature.
        return "v2\n" + json.dumps([vault, note, anchor or "", int(exp or 0),
                                    hints.get("rest", ""), hints.get("obsidian_name", ""),
                                    hints.get("container", ""), hints.get("vault_id", "")],
                                   ensure_ascii=True, separators=(",", ":"))
    return "\n".join([vault, note, anchor or "", str(exp or 0)])


def _has_line_break(*fields):
    """The legacy format joins fields with a newline, so a field that contains one could be
    re-split into another (vault, note, anchor): links never carry CR or LF, in either format."""
    return any("\n" in (f or "") or "\r" in (f or "") for f in fields)


def sign(secret, vault, note, anchor, exp, hints=None):
    mac = hmac.new(secret.encode("utf-8"), _canonical(vault, note, anchor, exp, hints).encode("utf-8"),
                   hashlib.sha256)
    return mac.hexdigest()[:40]


def build_go_link(cfg, vault, note, anchor="", hints=None):
    """Compose the /go link. Signed when a secret exists; expiry from link_ttl_s.
    `hints` (rest / obsidian_name) are for detected vaults, which require a signature."""
    if _has_line_break(vault, note, anchor):
        raise ValueError("line break in a link field")
    exp = int(time.time()) + cfg["link_ttl_s"] if cfg["link_ttl_s"] else 0
    params = [("v", vault), ("n", note)]
    if anchor:
        params.append(("h", anchor))
    if exp:
        params.append(("e", str(exp)))
    if hints:
        if hints.get("rest"):
            params.append(("r", hints["rest"]))
        if hints.get("obsidian_name"):
            params.append(("o", hints["obsidian_name"]))
        if hints.get("container"):
            params.append(("c", hints["container"]))
        if hints.get("vault_id"):
            params.append(("k", hints["vault_id"]))
    mode, secret = link_secret(cfg)
    if mode == "error":
        raise RuntimeError("link-signing secret unreadable")
    if mode == "on":
        params.append(("s", sign(secret, vault, note, anchor, exp, hints)))
    elif hints:
        raise RuntimeError("detected vaults require a link-signing secret")
    return "%s/go?%s" % (cfg["self_url"], urllib.parse.urlencode(params))


def verify_go(cfg, q):
    """Returns (ok, code, message, vault, note, anchor, hints). `hints` is None for a
    configured vault (the manual entry wins, whatever the link carries)."""
    vault = (q.get("v") or [""])[0]
    note = (q.get("n") or [""])[0]
    anchor = (q.get("h") or [""])[0]
    exp_s = (q.get("e") or ["0"])[0]
    sig = (q.get("s") or [""])[0]
    hints = {k: (q.get(p) or [""])[0] for k, p in (("rest", "r"), ("obsidian_name", "o"), ("container", "c"),
                                                   ("vault_id", "k"))}
    hints = {k: v for k, v in hints.items() if v} or None
    if not vault or not (note or hints):
        # A detection link (it carries hints) may have no note: it then only opens the GUI,
        # after the same identity check. Links of configured vaults always carry one.
        return (False, 400, "parameters v and n are required", vault, note, anchor, None)
    if _has_line_break(vault, note, anchor):
        return (False, 400, "line break in a link field", vault, note, anchor, None)
    try:
        exp = int(exp_s)
    except ValueError:
        return (False, 400, "invalid parameter e", vault, note, anchor, None)
    mode, secret = link_secret(cfg)
    if mode == "error":
        return (False, 503, "link-signing secret unreadable on the agent", vault, note, anchor, None)
    if mode == "on":
        expected = sign(secret, vault, note, anchor, exp, hints)
        if not hmac.compare_digest(sig.encode("utf-8", "replace"), expected.encode("utf-8")):
            return (False, 403, "bad signature", vault, note, anchor, None)
    elif hints:
        # Never act on unsigned hints, even on an agent that tolerates unsigned links.
        return (False, 403, "detected vaults require a signed link", vault, note, anchor, None)
    if exp and time.time() > exp:
        return (False, 410, "link expired", vault, note, anchor, None)
    if vault in cfg["vaults"]:
        if hints:
            # A detection link for a name that has since been configured: the configured entry
            # may point elsewhere, and a detection link was never checked against it. Refuse
            # rather than open whatever the configuration now says; a fresh /view mints a
            # configured link.
            return (False, 409, "this vault is now configured: ask for a new link", vault, note, anchor, None)
        return (True, 200, "", vault, note, anchor, None)
    if not hints:
        return (False, 404, "unknown vault", vault, note, anchor, None)
    return (True, 200, "", vault, note, anchor, hints)


# ----------------------------------------------------------------------------- navigation

def _safe_note(note):
    """Refuse what the bridge would refuse anyway (absolute path, `..`) so we never compose
    a dubious command line."""
    if not note or note.startswith("/") or note.startswith("\\"):
        return None
    # A drive prefix (C:\x, C:/x, C:x) is an absolute path for a Windows reader's Obsidian,
    # whatever the OS this agent runs on.
    if ntpath.splitdrive(note)[0]:
        return None
    if any(seg == ".." for seg in note.replace("\\", "/").split("/")):
        return None
    return note


# Click-to-open prefix. Local REST API 5.4.0 reserves `/open/` (with vault, active, search,
# commands, events, mcp, tags) and refuses it to the bridge's addPublicRoute(): a GET on
# `/open/<path>` then lands on Local REST API's own authenticated route and answers 401
# (errorCode 40101). Bridge 0.10.0 serves the route under `/mcp-router-bridge/open/` (and
# keeps `/open/` where Local REST API < 5.4.0 accepts it) and announces the prefix it got
# in `GET /ping`: {"pong": true, "openPrefix": "/mcp-router-bridge/open/"}. That ping is
# loopback-only on the bridge side, which is exactly where navigate() already talks from.
# The value comes off the network and goes into a URL and a command line: validated, and
# anything else falls back to the legacy prefix. Kept a minute per target, so a click costs
# one extra `docker exec` at most once a minute per vault.
LEGACY_OPEN_PREFIX = "/open/"
OPEN_PREFIX_TTL_S = 60
# fullmatch, never match: `$` also matches before a trailing newline in Python.
_OPEN_PREFIX_RE = re.compile(r"(?:/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)+/")
_open_prefix_cache = {}
_open_prefix_lock = threading.Lock()


def prefix_from_pong(body):
    """The `openPrefix` a bridge pong announces, or None (old bridge, not a bridge, or a
    value that does not pass validation)."""
    try:
        j = json.loads(body)
    except (TypeError, ValueError):
        return None
    if not isinstance(j, dict) or j.get("pong") is not True:
        return None
    p = j.get("openPrefix")
    if isinstance(p, str) and len(p) <= 128 and _OPEN_PREFIX_RE.fullmatch(p):
        return p
    return None


def resolve_open_prefix(key, fetch_pong, now=None):
    """The click-to-open prefix for one navigation target, cached OPEN_PREFIX_TTL_S.
    `fetch_pong()` returns the /ping body (or raises). Never raises: any failure is the
    legacy prefix, which is also cached so a dead ping is not retried on every click."""
    t = time.monotonic() if now is None else now
    with _open_prefix_lock:
        hit = _open_prefix_cache.get(key)
        if hit and t - hit[1] < OPEN_PREFIX_TTL_S:
            return hit[0]
    try:
        prefix = prefix_from_pong(fetch_pong()) or LEGACY_OPEN_PREFIX
    except Exception:
        prefix = LEGACY_OPEN_PREFIX
    with _open_prefix_lock:
        _open_prefix_cache[key] = (prefix, t)
    return prefix


def open_path(note, anchor, prefix=LEGACY_OPEN_PREFIX):
    if not (isinstance(prefix, str) and _OPEN_PREFIX_RE.fullmatch(prefix)):
        prefix = LEGACY_OPEN_PREFIX
    path = prefix + urllib.parse.quote(note, safe="")
    if anchor:
        path += "?h=" + urllib.parse.quote(anchor, safe="")
    return path


def obsidian_uri(vault_cfg, note=""):
    """`obsidian://open` URI for a vault opened in the reader's own desktop Obsidian.
    `open` has no heading parameter: an anchor is not carried (documented limit)."""
    uri = "obsidian://open?vault=" + urllib.parse.quote(vault_cfg["obsidian_vault"], safe="")
    if note:
        uri += "&file=" + urllib.parse.quote(note, safe="")
    return uri


def navigate(vault_cfg, note, anchor="", runner=None):
    """Navigate the vault's Obsidian onto the note. Returns (ok, detail). Never raises."""
    note = _safe_note(note)
    if not note:
        return (False, "path refused")
    mode = vault_cfg.get("open_mode", "docker-exec")
    if mode in ("none", "obsidian-uri"):
        # obsidian-uri: nothing to drive from this host, the reader's Obsidian opens it.
        return (True, "navigation disabled" if mode == "none" else "opened by the reader's Obsidian")
    try:
        if mode == "docker-exec":
            # https: the Local REST API's secure port, self-signed; -k is harmless on loopback.
            scheme = "https" if vault_cfg.get("open_scheme") == "https" else "http"
            base = "%s://127.0.0.1:%s" % (scheme, vault_cfg["open_port"])
            exec_curl = [vault_cfg.get("docker_path", "docker"), "exec", vault_cfg["container"],
                         vault_cfg.get("curl_path", "curl"), "-sS"] + (["-k"] if scheme == "https" else [])
            run = runner or (lambda c: subprocess.run(c, capture_output=True, text=True, timeout=8))

            def fetch_pong():
                r = run(exec_curl + ["--max-time", "3", base + "/ping"])
                if r.returncode != 0:
                    raise RuntimeError("ping rc=%s" % r.returncode)
                return r.stdout or ""
            prefix = resolve_open_prefix(("docker-exec", vault_cfg["container"], base), fetch_pong)
            url = base + open_path(note, anchor, prefix)
            cmd = exec_curl + ["-o", "/dev/null", "-w", "%{http_code}", "--max-time", "4", url]
            r = run(cmd)
            code = (r.stdout or "").strip()[-3:]
            if r.returncode != 0:
                return (False, "docker exec rc=%s %s" % (r.returncode, (r.stderr or "").strip()[:160]))
            return (code == "200", "bridge HTTP %s (%s)" % (code, prefix))
        if mode == "http":
            base = vault_cfg["open_url"].rstrip("/")

            def fetch_pong():
                with urllib.request.urlopen(urllib.request.Request(base + "/ping", method="GET"), timeout=3) as resp:
                    return resp.read(4096).decode("utf-8", "replace")
            prefix = resolve_open_prefix(("http", base), fetch_pong)
            url = base + open_path(note, anchor, prefix)
            req = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(req, timeout=4) as resp:
                return (resp.status == 200, "bridge HTTP %s (%s)" % (resp.status, prefix))
    except Exception as e:  # best-effort per the contract: never an exception to the client
        return (False, str(e)[:160])
    return (False, "unknown mode")


# ----------------------------------------------------------------------------- detection

class DetectError(Exception):
    """A vault that cannot be classified. `code` follows the contract: 4xx = this vault
    (does not trip the router's breaker), 5xx = the agent's own health (Docker down)."""

    def __init__(self, code, msg):
        Exception.__init__(self, msg)
        self.code = code
        self.msg = msg


class BudgetExhausted(DetectError):
    """This request ran out of its own detection deadline. Says nothing about Docker's health:
    never cached, never shared with other requests."""

    def __init__(self, msg):
        DetectError.__init__(self, 503, msg)


_CONTAINER_ID_RE = re.compile(r"^[0-9a-f]{64}$")
_CONTAINER_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
_PORT_KEY_RE = re.compile(r"^([0-9]{1,5})/tcp$")
_VAULT_ID_RE = re.compile(r"^[0-9a-f]{16}$")


def _mounts_identity(o):
    """A container's vault identity: a digest of WHAT it mounts WHERE (bind source or named
    volume, each with its destination and volume subpath). Stable across `docker compose`
    recreations and image updates (unlike the container ID); different when another folder
    is mounted, or the same folders are swapped between destinations. It proves what Docker
    mounts where, not the vault's content. None when the container mounts nothing, or when
    one bind/volume mount cannot be read (a partial digest could hide a substitution)."""
    mounts = o.get("Mounts")
    # A volume's subpath is only in the mount SPECS (HostConfig.Mounts, Compose long syntax),
    # keyed here by (type, source, destination) to join it back onto the resolved mounts.
    subpaths = {}
    host_cfg = o.get("HostConfig")
    specs = host_cfg.get("Mounts") if isinstance(host_cfg, dict) else None
    for spec in (specs if isinstance(specs, list) else ()):
        if not isinstance(spec, dict):
            continue
        vopts = spec.get("VolumeOptions")
        sub = vopts.get("Subpath") if isinstance(vopts, dict) else None
        if isinstance(sub, str) and sub:
            subpaths[(spec.get("Type"), spec.get("Source"), spec.get("Target"))] = sub
    srcs = set()
    for m in (mounts if isinstance(mounts, list) else ()):
        if not isinstance(m, dict):
            return None
        kind = m.get("Type")
        if kind not in ("bind", "volume"):
            continue  # tmpfs, npipe…: no vault data
        src = m.get("Name") if kind == "volume" else m.get("Source")
        dest = m.get("Destination")
        sub = subpaths.get((kind, src, dest), "")
        if not (isinstance(src, str) and src and isinstance(dest, str) and dest and isinstance(sub, str)):
            return None  # unreadable mount: never a partial identity
        # JSON of each triple, control characters escaped: no path is ever dropped or merged.
        srcs.add(json.dumps([kind, src, sub, dest], ensure_ascii=True))
    if not srcs:
        return None
    return hashlib.sha256("\n".join(sorted(srcs)).encode("utf-8")).hexdigest()[:16]
_WILDCARD_IPS = ("", "0.0.0.0", "::")


def _printable(s, limit):
    return isinstance(s, str) and 0 < len(s) <= limit and not any(ord(c) < 0x20 or ord(c) == 0x7f for c in s)


def parse_rest_hint(value):
    """Router's `rest` hint → (origin, host, port). Only scheme://host:port is accepted:
    no credentials, no path, no query, an explicit port, a host that is an IP or a name."""
    if not _printable(value, 300) or any(c in value for c in " \\%"):
        raise DetectError(400, "rest hint: not a plain URL")
    try:
        u = urllib.parse.urlsplit(value)
        u.hostname, u.port
    except ValueError:  # e.g. "http://[::1:80" — urlsplit raises instead of parsing
        raise DetectError(400, "rest hint: not a valid URL")
    if u.scheme.lower() not in ("http", "https"):
        raise DetectError(400, "rest hint: scheme must be http or https")
    if "@" in u.netloc:
        raise DetectError(400, "rest hint: must not carry credentials")
    if u.path not in ("", "/") or u.query or u.fragment:
        raise DetectError(400, "rest hint: must be an origin (scheme://host:port), nothing more")
    try:
        port = u.port
    except ValueError:
        port = None
    if not port:
        raise DetectError(400, "rest hint: an explicit port is required")
    host = _norm_host(u.hostname or "")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        if not _HOSTNAME_RE.match(host):
            raise DetectError(400, "rest hint: invalid host")
    shown = "[%s]" % host if ":" in host else host
    return ("%s://%s:%d" % (u.scheme.lower(), shown, port), host, port, u.scheme.lower())


def normalize_hints(raw):
    """Validated, canonical hints (only the ones present). Raises DetectError."""
    hints = {}
    if raw.get("rest"):
        hints["rest"] = parse_rest_hint(raw["rest"])[0]
    name = raw.get("obsidian_name")
    if name:
        if not _printable(name, 255) or name != name.strip():
            raise DetectError(400, "obsidian_name hint: invalid vault name")
        hints["obsidian_name"] = name
    container = raw.get("container")
    if container:
        if not (isinstance(container, str) and _CONTAINER_NAME_RE.match(container)):
            raise DetectError(400, "container hint: invalid container name")
        hints["container"] = container
    vault_id = raw.get("vault_id")
    if vault_id:
        if not (isinstance(vault_id, str) and _VAULT_ID_RE.match(vault_id)):
            raise DetectError(400, "vault_id hint: invalid")
        hints["vault_id"] = vault_id
    return hints


# One detection — waiting for the inventory lock included — fits in DETECT_BUDGET_S, under the
# router's 6 s eager budget; each Docker command gets at most DOCKER_CALL_S of what is left.
DETECT_BUDGET_S = 5.0
DOCKER_CALL_S = 2.5


def _run(cmd, timeout=DOCKER_CALL_S):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


class DockerInventory:
    """Running containers and their published TCP ports, from two fixed commands:
    `docker ps --no-trunc -q` then `docker inspect <validated ids>`. Cached `cache_s`.
    Every call runs against a deadline: the lock wait and both commands share it."""

    def __init__(self, detect_cfg, runner=None):
        self.d = detect_cfg
        self.runner = runner or _run
        self.lock = threading.Lock()
        self.at = 0.0
        self.data = None
        self.error = None

    def containers(self, fresh=False, deadline=None):
        """`fresh`: bypass the cache — a click (/go) acts on the container, so it must see
        Docker as it is now, not as it was up to `cache_s` seconds ago. `deadline`
        (time.monotonic()): default now + DETECT_BUDGET_S; concurrent callers never queue past it."""
        if deadline is None:
            deadline = time.monotonic() + DETECT_BUDGET_S
        if not self.lock.acquire(timeout=max(0.0, deadline - time.monotonic())):
            raise BudgetExhausted("docker inventory busy: time budget exhausted")
        try:
            now = time.monotonic()
            if not fresh and self.data is not None and now - self.at < self.d["cache_s"]:
                return self.data
            if not fresh and self.error is not None and now - self.at < min(self.d["cache_s"], 5):
                raise self.error  # Docker down: answer at once rather than queue on the lock
            try:
                self.data, self.error = self._probe(deadline), None
            except BudgetExhausted:
                raise  # this request's deadline, not Docker's state: the cache stays as it was
            except DetectError as e:
                self.data, self.error = None, e
            except Exception as e:  # malformed output of an unexpected shape: fail closed
                self.data, self.error = None, DetectError(503, "docker: unexpected output (%s)"
                                                          % type(e).__name__)
            self.at = now
            if self.error is not None:
                raise self.error
            return self.data
        finally:
            self.lock.release()

    def _call(self, args, deadline):
        left = deadline - time.monotonic()
        if left < 0.1:
            raise BudgetExhausted("docker: time budget exhausted")
        timeout = min(DOCKER_CALL_S, left)
        try:
            r = self.runner([self.d["docker_path"]] + args, timeout)
        except subprocess.TimeoutExpired:
            if timeout < DOCKER_CALL_S:  # cut short by this request's deadline
                raise BudgetExhausted("docker: time budget exhausted")
            raise DetectError(503, "docker unavailable: no answer within %.1f s" % timeout)
        except Exception as e:
            raise DetectError(503, "docker unavailable: %s" % str(e)[:120])
        return r

    def _probe(self, deadline):
        r = self._call(["ps", "--no-trunc", "-q"], deadline)
        if r.returncode != 0:
            raise DetectError(503, "docker ps failed: %s" % (r.stderr or "").strip()[:160])
        ids = [line.strip() for line in (r.stdout or "").splitlines() if line.strip()]
        if not all(_CONTAINER_ID_RE.match(i) for i in ids):
            raise DetectError(503, "docker ps: unexpected output")
        if not ids:
            return []
        r = self._call(["inspect", "--type", "container"] + ids, deadline)
        try:
            objs = json.loads(r.stdout or "")
        except ValueError:
            objs = None
        if not isinstance(objs, list):  # a container that vanished in between still leaves valid JSON
            raise DetectError(503, "docker inspect failed: %s" % (r.stderr or "").strip()[:160])
        out = []
        for o in objs:
            if not isinstance(o, dict):
                continue
            cid = o.get("Id")
            if not (isinstance(cid, str) and _CONTAINER_ID_RE.match(cid) and cid in ids):
                continue
            state = o.get("State")
            if not (isinstance(state, dict) and state.get("Running") is True):
                continue
            name = str(o.get("Name") or "").lstrip("/")
            if not _CONTAINER_NAME_RE.match(name):
                name = cid[:12]
            ports = []
            net = o.get("NetworkSettings")
            published = net.get("Ports") if isinstance(net, dict) else None
            for key, binds in (published.items() if isinstance(published, dict) else ()):
                m = _PORT_KEY_RE.match(str(key))
                if not m or not isinstance(binds, list):
                    continue
                cport = int(m.group(1))
                for b in binds:
                    if not isinstance(b, dict):
                        continue
                    hp = str(b.get("HostPort") or "")
                    if not (re.fullmatch(r"[0-9]{1,5}", hp) and 0 < int(hp) < 65536 and 0 < cport < 65536):
                        continue
                    hip = str(b.get("HostIp") or "")
                    ports.append((_norm_host(hip) if hip else "", int(hp), cport))
            out.append({"id": cid, "name": name, "ports": ports, "vault_id": _mounts_identity(o)})
        return out


def _reachable(bind_ip, host):
    """Does a Docker publication on `bind_ip` answer on `host`? Docker publishes IPv4 and
    IPv6 separately: 0.0.0.0 is every IPv4 address only, :: every IPv6 address only."""
    if bind_ip == "" or bind_ip == host:
        return True
    if host == "localhost":  # how a router on this host may spell loopback: either family
        return bind_ip in ("127.0.0.1", "::1", "0.0.0.0", "::")
    try:
        family = ipaddress.ip_address(host).version
    except ValueError:
        # A host name may resolve to either family: accept both wildcards. A family split
        # across two containers still ends as "several containers" (ambiguous → 400).
        return bind_ip in ("0.0.0.0", "::")
    return (bind_ip == "0.0.0.0" and family == 4) or (bind_ip == "::" and family == 6)


def _name_meets_explicit_ip(host, binds):
    """A host NAME (not an IP, not localhost) cannot be matched against a publication on an
    explicit IP: the name may resolve to that IP or not. Indeterminate → the caller refuses."""
    if host == "localhost":
        return False
    try:
        ipaddress.ip_address(host)
        return False
    except ValueError:
        return any(hip not in _WILDCARD_IPS for hip in binds)


def _detect_container(cfg, host, port, inventory, fresh=False):
    d = cfg["detect"]
    containers = inventory.containers(fresh)
    if _name_meets_explicit_ip(host, [hip for c in containers for hip, hp, _ in c["ports"] if hp == port]):
        raise DetectError(400, "port %d is published on an explicit address and the router names this "
                               "host %s: indeterminate, give the router an IP in the vault's baseUrl"
                               % (port, host))
    hits = [c for c in containers
            if any(hp == port and _reachable(hip, host) for hip, hp, _ in c["ports"])]
    if not hits:
        raise DetectError(400, "no running container publishes port %d on this host" % port)
    if len(hits) > 1:
        raise DetectError(400, "port %d is published by several containers (%s)"
                          % (port, ", ".join(sorted(c["name"] for c in hits))))
    c = hits[0]
    if not c.get("vault_id"):
        raise DetectError(400, "container %s mounts nothing readable: no vault to identify" % c["name"])
    inner = {cp for hip, hp, cp in c["ports"] if hp == port and _reachable(hip, host)}
    if len(inner) != 1:
        raise DetectError(400, "container %s maps port %d ambiguously" % (c["name"], port))
    # {host}: where the router reached the vault — unless that is loopback, which means
    # nothing to the reader's browser: then the host the reader already uses for /go.
    gui_host = host
    if host in ("127.0.0.1", "::1", "localhost"):
        gui_host = _norm_host(urllib.parse.urlsplit(cfg["self_url"]).hostname or host)
    gui = None
    for gp in d["gui_container_ports"]:
        if _name_meets_explicit_ip(gui_host, [hip for hip, hp, cp in c["ports"] if cp == gp]):
            raise DetectError(400, "container %s publishes its GUI port %d on an explicit address and "
                                   "the GUI host is the name %s: indeterminate" % (c["name"], gp, gui_host))
        published = {hp for hip, hp, cp in c["ports"] if cp == gp and _reachable(hip, gui_host)}
        if len(published) > 1:
            raise DetectError(400, "container %s publishes its GUI port %d several times" % (c["name"], gp))
        if published:
            gui = published.pop()
            break
    if gui is not None:
        # The reader's browser will open {gui_host}:{gui}: no OTHER container may answer there,
        # in either address family, or the redirect could land on another vault. A NAME facing
        # an explicit-IP publication of that port, by any container, cannot be ruled out.
        if _name_meets_explicit_ip(gui_host, [hip for o in containers for hip, hp, _ in o["ports"] if hp == gui]):
            raise DetectError(400, "GUI port %d is published on an explicit address and the GUI host is "
                                   "the name %s: indeterminate" % (gui, gui_host))
        others = sorted(o["name"] for o in containers if o["id"] != c["id"]
                        and any(hp == gui and _reachable(hip, gui_host) for hip, hp, _ in o["ports"]))
        if others:
            raise DetectError(400, "GUI port %d on %s is also published by %s: ambiguous"
                                   % (gui, gui_host, ", ".join(others)))
    if gui is None:
        raise DetectError(400, "container %s publishes no GUI port reachable on %s "
                               "(detect.gui_container_ports)" % (c["name"], gui_host))
    shown = "[%s]" % gui_host if ":" in gui_host else gui_host
    return {
        "open_mode": "docker-exec",
        "container": c["id"],             # validated hex ID, never a string from the request
        "open_port": inner.pop(),
        "public_url": d["gui_url"].replace("{host}", shown).replace("{port}", str(gui)),
        "docker_path": d["docker_path"],
        "curl_path": d["curl_path"],
        "_detected": "container %s" % c["name"],
        "_container_name": c["name"],     # the vault's identity, signed into the link:
        "_vault_id": c["vault_id"],       # name + digest of its mounts
    }


def detect_vault(cfg, hints, inventory, fresh=False):
    """Classify a vault absent from `vaults` from normalized hints → a vault config.
    Raises DetectError; never returns a guess."""
    d = cfg["detect"]
    if not d["enabled"]:
        raise DetectError(400, "unknown vault (detection disabled)")
    if not hints.get("rest"):
        raise DetectError(400, "unknown vault: not configured, and the router sent no rest hint")
    _, host, port, scheme = parse_rest_hint(hints["rest"])
    if host in d["_local"]:
        found = _detect_container(cfg, host, port, inventory, fresh)
        found["open_scheme"] = scheme
        return found
    if _host_in(host, d["_desktop"]):
        if not hints.get("obsidian_name"):
            raise DetectError(400, "desktop vault on %s: the router sent no obsidian_name hint" % host)
        return {"open_mode": "obsidian-uri", "obsidian_vault": hints["obsidian_name"],
                "_detected": "desktop %s" % host}
    raise DetectError(400, "cannot classify vault: %s is neither this agent's host nor in "
                           "detect.desktop_hosts" % host)


# ----------------------------------------------------------------------------- HTTP

_GO_HTML = (
    "<!doctype html><meta charset=utf-8><title>Obsidian</title>"
    "<p>%s</p>%s"
)
_GO_HTML_LINK = "<p><a href=\"%s\">Open the Obsidian GUI</a></p>"


def make_handler(cfg, navigate_fn=None, docker_runner=None):
    nav = navigate_fn or navigate
    inventory = DockerInventory(cfg["detect"], docker_runner)

    def resolve_view(vault, q, token_verified):
        """/view: (vault_cfg, hints) for a configured or detectable vault. Raises DetectError.
        `token_verified`: this very request presented the token and it matched (never re-read
        the file here: it may have appeared since the check)."""
        if vault in cfg["vaults"]:
            return cfg["vaults"][vault], None  # the manual entry wins, hints are ignored
        raw = {"rest": (q.get("rest") or [""])[0], "obsidian_name": (q.get("obsidian_name") or [""])[0]}
        if not (raw["rest"] or raw["obsidian_name"]):
            raise DetectError(400, "unknown vault")
        if not _printable(vault, 200):
            raise DetectError(400, "invalid vault name")
        # Detection needs both locks: only the router mints, and every link is signed.
        sign_mode = link_secret(cfg)[0]
        if sign_mode == "error":
            raise DetectError(503, "link-signing secret unreadable on the agent")
        if not token_verified or sign_mode != "on":
            raise DetectError(400, "vault detection requires token_file and a link-signing secret")
        hints = normalize_hints(raw)
        hints.pop("container", None)  # identity comes from Docker, never from the request
        hints.pop("vault_id", None)
        found = detect_vault(cfg, hints, inventory)
        if found.get("_container_name"):
            hints["container"] = found["_container_name"]
            hints["vault_id"] = found["_vault_id"]
        return found, hints

    class Handler(BaseHTTPRequestHandler):
        def _send(self, code, obj):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _html(self, code, text, href=None):
            link = _GO_HTML_LINK % html.escape(href, quote=True) if href else ""
            body = (_GO_HTML % (html.escape(text), link)).encode()
            self.send_response(code)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def send_response(self, *a, **k):
            self._started = True
            BaseHTTPRequestHandler.send_response(self, *a, **k)

        def log_message(self, *a):
            pass

        def do_GET(self):
            self._started = False
            try:
                return self._get()
            except (BrokenPipeError, ConnectionResetError):
                return  # the client left: nothing to answer
            except Exception as e:  # never a dropped connection: the router reads that as transport
                print("view-agent-direct: unexpected %s on %s" % (type(e).__name__, self.path.split("?")[0]),
                      file=sys.stderr)
                if not self._started:  # a second status line would corrupt a started response
                    return self._send(500, {"error": "internal error"})

        def _get(self):
            u = urllib.parse.urlparse(self.path)
            q = urllib.parse.parse_qs(u.query)

            if u.path == "/health":
                return self._send(200, {"ok": True, "vaults": sorted(cfg["vaults"].keys())})

            if u.path == "/view":
                mode, tok = read_secret_file(cfg, "token_file")
                if mode == "error":
                    return self._send(503, {"error": "token file unreadable on the agent"})
                if tok is not None and not hmac.compare_digest(
                    (self.headers.get("X-View-Token") or "").encode("utf-8", "replace"),
                    tok.encode("utf-8", "replace"),
                ):
                    return self._send(401, {"error": "bad token"})
                token_verified = tok is not None  # present at the check, and matched above
                vault = (q.get("vault") or [""])[0]
                note = (q.get("note") or [""])[0]
                anchor = (q.get("h") or [""])[0]
                try:
                    vault_cfg, hints = resolve_view(vault, q, token_verified)
                except DetectError as e:
                    return self._send(e.code, {"error": e.msg, "vault": vault,
                                               "vaults": sorted(cfg["vaults"].keys())})
                if not note:
                    # No note: a link to the GUI (or the desktop vault), nothing to navigate.
                    if hints is not None:
                        # A DETECTED vault (container or desktop): never an unsigned URL — the
                        # classification may change before the click. A signed /go link
                        # re-detects and checks the identity first, then redirects.
                        if _has_line_break(vault, "", anchor):
                            return self._send(400, {"error": "bad anchor"})
                        try:
                            link = build_go_link(cfg, vault, "", "", hints)
                        except RuntimeError as e:
                            return self._send(503, {"error": str(e)})
                        return self._send(200, {"url": link, "vault": vault, "kind": "direct-go",
                                                "source": vault_cfg.get("_detected", "config")})
                    if vault_cfg.get("open_mode") == "obsidian-uri":
                        return self._send(200, {"url": obsidian_uri(vault_cfg), "vault": vault, "kind": "obsidian-uri"})
                    return self._send(200, {"url": vault_cfg["public_url"], "vault": vault, "kind": "direct"})
                if _safe_note(note) is None or _has_line_break(vault, note, anchor):
                    return self._send(400, {"error": "bad note path"})
                navigated = None
                if cfg.get("navigate_on_view"):
                    navigated = nav(vault_cfg, note, anchor)[0]
                try:
                    link = build_go_link(cfg, vault, note, anchor, hints)
                except RuntimeError as e:
                    return self._send(503, {"error": str(e)})
                resp = {
                    "url": link,                      # the only field the router requires
                    "vault": vault, "note": note, "kind": "direct-go",
                    "navigated_on_view": navigated,
                    "open_mode": vault_cfg.get("open_mode", "docker-exec"),
                    "source": vault_cfg.get("_detected", "config"),
                }
                if cfg["link_ttl_s"]:
                    # Echoed by get_view_link as expiresInSeconds. Omitted for stable links:
                    # there is nothing to expire.
                    resp["idle_timeout_s"] = cfg["link_ttl_s"]
                return self._send(200, resp)

            if u.path == "/go":
                ok, code, msg, vault, note, anchor, hints = verify_go(cfg, q)
                if not ok:
                    return self._send(code, {"error": msg})
                def locate():
                    """Re-detect NOW (fresh inventory) and require the signed identity.
                    Raises DetectError (409 when another vault answers there)."""
                    found = detect_vault(cfg, normalize_hints(hints), inventory, fresh=True)
                    signed_as = hints.get("container")
                    found_as = found.get("_container_name")
                    if (signed_as, hints.get("vault_id")) != (found_as, found.get("_vault_id")):
                        # Another container now answers on that port (or the link names none):
                        # refuse rather than open a different vault with the same signed link.
                        raise DetectError(409, "the vault moved: this link was made for %s, "
                                               "now %s" % (signed_as or "no container",
                                                           found_as or "a desktop Obsidian"))
                    return found

                if hints is None:
                    vault_cfg = cfg["vaults"][vault]
                else:
                    try:
                        vault_cfg = locate()
                    except DetectError as e:
                        return self._html(e.code, "The vault “%s” could not be located (%s)." % (vault, e.msg))
                if vault_cfg.get("open_mode") == "obsidian-uri":
                    # Handed to the reader's desktop Obsidian. verify_go checks the signature,
                    # not the path: refuse absolute paths and `..` here too (unsigned setups).
                    if note and _safe_note(note) is None:
                        return self._send(400, {"error": "bad note path"})
                    self.send_response(302)
                    self.send_header("Location", obsidian_uri(vault_cfg, note))
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                if note:
                    nav_ok, detail = nav(vault_cfg, note, anchor)
                else:
                    nav_ok, detail = True, "no note: GUI only"  # detection links only (verify_go)
                if nav_ok and hints is not None:
                    # Second check, right before the redirect: the container may have been
                    # replaced while Obsidian was being navigated. This narrows the window to
                    # the time between this check and the browser loading the GUI; it cannot
                    # close it.
                    try:
                        vault_cfg = locate()
                    except DetectError as e:
                        return self._html(e.code, "The vault “%s” could not be located (%s)." % (vault, e.msg))
                target = vault_cfg["public_url"]
                if nav_ok:
                    self.send_response(302)
                    self.send_header("Location", target)
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                # Failed navigation: say so instead of redirecting silently. For a detected vault,
                # no GUI link: the container may be gone and its GUI port reused by another vault.
                return self._html(502, "Obsidian could not be navigated to “%s” (%s)."
                                  % (note, detail), None if hints is not None else target)

            return self._send(404, {"error": "not found"})

    return Handler


def main(argv):
    config_path = (argv[1] if len(argv) > 1 else os.environ.get(
        "VIEW_AGENT_CONFIG", os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")))
    try:
        cfg = load_config(config_path)
    except ValueError as e:
        print("view-agent-direct: %s" % e, file=sys.stderr)
        return 1
    srv = ThreadingHTTPServer((cfg["bind"], cfg["port"]), make_handler(cfg))
    print("view-agent-direct on http://%s:%d (self_url %s; vaults: %s)"
          % (cfg["bind"], cfg["port"], cfg["self_url"], ", ".join(sorted(cfg["vaults"]))))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
