#!/usr/bin/env python3
"""
view-agent — reference implementation of the obsidian-mcp-router `/view` provider contract.

What it does
------------
    GET /view?vault=<name>&note=<vault-relative-path>
      1. ensures an ephemeral Cloudflare quick tunnel to that vault's Obsidian GUI is up
         (an existing tunnel is reused within the idle window),
      2. navigates the vault's Obsidian to <note> via its Local REST API /open endpoint
         (best-effort — a navigation failure never fails the response),
      3. returns  {"url": "https://<user>:<pass>@<random>.trycloudflare.com/", ...}
         — browser-ready, credentials baked into the URL so the user types nothing.

Tunnels auto-close after `idle_timeout_s` seconds without a /view call: the GUI is only
ever exposed while someone is actually looking at it, never permanently.

This is DEPLOYMENT GLUE, not part of the obsidian-mcp-router npm package. The router only
depends on the HTTP contract documented in docs/CONTRACT.md — this file is one possible
provider of that contract (Obsidian GUIs in containers + cloudflared quick tunnels).
Anything that honours the contract can replace it.

Configuration
-------------
Everything comes from a JSON config file — nothing is hardcoded:

    python3 view-agent.py /etc/view-agent/config.json
    # or: VIEW_AGENT_CONFIG=/etc/view-agent/config.json python3 view-agent.py
    # or: ./config.json next to the script (default)

See config.example.json for the schema. Secrets (GUI passwords, REST API keys) are best
referenced as `*_file` paths so the config itself stays secret-free; secret files are
re-read on every use, so rotating a secret needs no restart.

Security posture (defence in depth)
-----------------------------------
    1. NETWORK   — bind to a private interface (default 127.0.0.1; typically a WireGuard
                   IP) and firewall the port to that network. Never expose it publicly.
    2. TOKEN     — if `token_file` exists, every /view call must carry a matching
                   X-View-Token header (the router sends OBSIDIAN_ROUTER_VIEW_AGENT_TOKEN).
    3. EPHEMERAL — tunnels are short-lived, unguessable *.trycloudflare.com hostnames
                   that close after the idle window.
    4. GUI AUTH  — the GUI's own basic-auth (user/password in the returned URL) remains
                   the last gate even while a tunnel is up.

Python 3.8+ stdlib only — no pip dependencies. `cloudflared` must be on the machine.
"""
import hmac
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_CONFIG = {
    # Bind address for THIS agent. Loopback by default (safe); set it to a private /
    # WireGuard IP so your MCP-router host can reach it. NEVER a public interface.
    "bind": "127.0.0.1",
    "port": 27200,
    # Seconds without any /view call before a vault's tunnel is closed.
    "idle_timeout_s": 1800,
    # Max seconds to wait for cloudflared to print its public URL on a cold start.
    "url_wait_s": 18,
    # Path to the cloudflared binary (absolute path or on $PATH).
    "cloudflared_path": "cloudflared",
    # Optional shared secret: when this file exists, /view requires a matching
    # X-View-Token header. A relative path is resolved against the config file's folder.
    # Absent file = no token gate (the private network is then the only lock).
    "token_file": "view-agent.token",
    # vault name -> per-vault settings; see config.example.json.
    "vaults": {},
}

# Per-vault required/optional keys (validated at load time so misconfig fails loudly).
VAULT_REQUIRED = ("gui_url",)
VAULT_OPTIONAL = (
    "gui_user",
    "gui_password",
    "gui_password_file",
    "open_url",
    "open_api_key",
    "open_api_key_file",
)

TUNNEL_URL_RX = re.compile(r"https://[a-z0-9.-]+\.trycloudflare\.com")


def load_config(path):
    """Load + validate the JSON config. Raises ValueError with a clear message on misconfig."""
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except FileNotFoundError:
        raise ValueError(
            "config file not found: %s (copy config.example.json and edit it)" % path
        )
    except json.JSONDecodeError as e:
        raise ValueError("config file %s is not valid JSON: %s" % (path, e))

    cfg = dict(DEFAULT_CONFIG)
    cfg.update(raw or {})
    cfg["_dir"] = os.path.dirname(os.path.abspath(path))

    if not isinstance(cfg.get("vaults"), dict) or not cfg["vaults"]:
        raise ValueError('config needs a non-empty "vaults" object (vault name -> settings)')
    for name, v in cfg["vaults"].items():
        if not isinstance(v, dict):
            raise ValueError('vault "%s" must be an object' % name)
        for k in VAULT_REQUIRED:
            if not v.get(k):
                raise ValueError('vault "%s" is missing required key "%s"' % (name, k))
        # Keys starting with "_" are comments (config.example.json documents itself with
        # them) — tolerated everywhere, so `cp config.example.json config.json` just works.
        unknown = [k for k in v if not k.startswith("_") and k not in VAULT_REQUIRED + VAULT_OPTIONAL]
        if unknown:
            raise ValueError(
                'vault "%s" has unknown key(s): %s (allowed: %s)'
                % (name, ", ".join(unknown), ", ".join(VAULT_REQUIRED + VAULT_OPTIONAL))
            )
    if not isinstance(cfg.get("port"), int):
        raise ValueError('"port" must be an integer')
    return cfg


def _resolve(cfg, p):
    """Resolve a possibly-relative path against the config file's folder."""
    return p if os.path.isabs(p) else os.path.join(cfg.get("_dir", "."), p)


def read_secret(cfg, vault_cfg, inline_key, file_key):
    """Inline value wins; else read the *_file (re-read on every use → rotation without
    restart). Returns "" when neither is set — callers treat that as 'no secret'."""
    inline = vault_cfg.get(inline_key)
    if inline:
        return str(inline)
    p = vault_cfg.get(file_key)
    if not p:
        return ""
    try:
        with open(_resolve(cfg, p), encoding="utf-8") as f:
            return f.read().strip()
    except OSError as e:
        # Loud (value-free) so a mispointed/unreadable secret file is debuggable instead
        # of silently producing credential-less URLs.
        print("view-agent: cannot read %s (%s)" % (file_key, e), file=sys.stderr)
        return ""


def read_token(cfg):
    """Shared-secret gate state: ("off", None) when no token file is configured or the
    file is absent (= gate disabled), ("on", <token>) when armed, ("error", None) when
    the file EXISTS but is unreadable OR empty — the caller must FAIL CLOSED on that
    (a permissions mishap or a botched `openssl rand > file` must not silently disarm
    the gate; review pass 2)."""
    p = cfg.get("token_file")
    if not p:
        return ("off", None)
    try:
        with open(_resolve(cfg, p), encoding="utf-8") as f:
            val = f.read().strip()
    except FileNotFoundError:
        return ("off", None)
    except OSError as e:
        print("view-agent: token file unreadable (%s) — failing closed" % e, file=sys.stderr)
        return ("error", None)
    if not val:
        print("view-agent: token file is EMPTY — failing closed", file=sys.stderr)
        return ("error", None)
    return ("on", val)


class TunnelManager:
    """One ephemeral cloudflared quick tunnel per vault, reused while warm, reaped when idle.

    `start_fn(vault_name, vault_cfg)` is injectable for tests; it must return
    {"proc": <Popen-like>, "url": "<public https url>", "last": <ts>} or None on failure.
    """

    def __init__(self, cfg, start_fn=None):
        self.cfg = cfg
        self.start_fn = start_fn or self._start_cloudflared
        self.tunnels = {}
        # Two-level locking: `lock` only guards the dicts (always held briefly);
        # `vault_locks[name]` serializes ensure() PER VAULT, so one vault's cold start
        # (up to url_wait_s) never blocks /health or warm /view calls on other vaults.
        self.lock = threading.Lock()
        self.vault_locks = {}

    def _vault_lock(self, vault_name):
        with self.lock:
            if vault_name not in self.vault_locks:
                self.vault_locks[vault_name] = threading.Lock()
            return self.vault_locks[vault_name]

    def _start_cloudflared(self, vault_name, vault_cfg):
        # UNIQUE log file per start (mkstemp), not per vault name: starts are only
        # serialized per vault, and two distinct names can sanitize to the same file
        # ("work notes" / "work_notes") — sharing it could hand one vault the OTHER
        # vault's tunnel URL (review pass 4). Files are kept for debugging; PrivateTmp
        # (systemd) reaps them on restart.
        fd, log_path = tempfile.mkstemp(
            prefix="view-agent-cf-%s-" % re.sub(r"[^\w.-]", "_", vault_name), suffix=".log"
        )
        log = os.fdopen(fd, "w")
        proc = subprocess.Popen(
            [self.cfg["cloudflared_path"], "tunnel", "--no-autoupdate",
             "--url", vault_cfg["gui_url"]],
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        deadline = time.time() + self.cfg["url_wait_s"]
        url = None
        while time.time() < deadline:
            try:
                with open(log_path, encoding="utf-8", errors="replace") as f:
                    m = TUNNEL_URL_RX.search(f.read())
                if m:
                    url = m.group(0)
                    break
            except OSError:
                pass
            if proc.poll() is not None:
                break  # cloudflared died — no point waiting out the deadline
            time.sleep(0.5)
        # cloudflared prints the URL on ALLOCATION, then takes seconds more to actually
        # REGISTER the connection on the edge — clicking the URL in that window serves
        # Cloudflare error 1033 (field bug, 2026-06-10; widened further on hosts with
        # broken IPv6 egress, where the first connection attempt fails before the IPv4
        # retry). "Registered tunnel connection" in the LOCAL log is the reliable
        # readiness signal — never probe the public URL from this host (an egress quirk
        # would turn the probe into a false judge that kills healthy tunnels).
        if url is not None and self._wait_registered(log_path, proc):
            return {"proc": proc, "url": url, "last": time.time()}
        try:
            proc.terminate()
        except Exception:
            pass
        return None

    def _wait_registered(self, log_path, proc):
        """Wait for cloudflared's edge registration, plus a short propagation grace."""
        deadline = time.time() + self.cfg.get("register_wait_s", 30)
        while time.time() < deadline:
            try:
                with open(log_path, encoding="utf-8", errors="replace") as f:
                    if "Registered tunnel connection" in f.read():
                        time.sleep(self.cfg.get("register_grace_s", 1.5))
                        return True
            except OSError:
                pass
            if proc.poll() is not None:
                return False  # died before registering
            time.sleep(0.5)
        return False

    def ensure(self, vault_name, vault_cfg):
        """Return the public URL for this vault's tunnel, starting one if needed.
        Serialized per vault; the (slow) cold start runs OUTSIDE the global lock."""
        with self._vault_lock(vault_name):
            # Warm path + dead-leftover cleanup run UNDER the global lock (poll/terminate
            # are instant) so the reaper can never interleave between the alive-check and
            # the `last` refresh and kill a tunnel whose URL we are about to return
            # (review pass 2). Only the SLOW cold start below runs outside it.
            with self.lock:
                t = self.tunnels.get(vault_name)
                if t and t["proc"].poll() is None and t.get("url"):
                    t["last"] = time.time()
                    return t["url"]
                if t:  # dead leftover — clean it before starting fresh
                    try:
                        t["proc"].terminate()
                    except Exception:
                        pass
                    self.tunnels.pop(vault_name, None)
            nt = self.start_fn(vault_name, vault_cfg)
            if nt:
                with self.lock:
                    self.tunnels[vault_name] = nt
                return nt["url"]
            return None

    def reap_once(self, now=None):
        """Close tunnels that died or sat idle past the window. Returns reaped names."""
        now = time.time() if now is None else now
        reaped = []
        with self.lock:
            for name in list(self.tunnels.keys()):
                t = self.tunnels[name]
                if t["proc"].poll() is not None or now - t["last"] > self.cfg["idle_timeout_s"]:
                    try:
                        t["proc"].terminate()
                    except Exception:
                        pass
                    del self.tunnels[name]
                    reaped.append(name)
        return reaped

    def reap_loop(self):
        while True:
            time.sleep(60)
            self.reap_once()

    def snapshot(self):
        with self.lock:
            return {name: t["url"] for name, t in self.tunnels.items()}


def navigate(cfg, vault_cfg, note):
    """Best-effort: open <note> in the vault's Obsidian via its Local REST API /open route
    (served by the mcp-router-bridge plugin). Failures are swallowed on purpose — the user
    still gets a working GUI link, just not pre-navigated."""
    open_base = (vault_cfg.get("open_url") or "").rstrip("/")
    if not note or not open_base:
        return
    url = "%s/open/%s" % (open_base, urllib.parse.quote(note, safe=""))
    headers = {}
    api_key = read_secret(cfg, vault_cfg, "open_api_key", "open_api_key_file")
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    req = urllib.request.Request(url, method="POST", headers=headers)
    try:
        # Short on purpose: a black-holed REST endpoint must not eat the router's 6s
        # eager budget — a warm /view should still answer well under that.
        urllib.request.urlopen(req, timeout=3)
    except Exception:
        pass


def auth_url(public_url, user, password):
    """Bake basic-auth credentials into the tunnel URL (browser-ready, nothing to type).
    Without credentials the raw tunnel URL is returned as-is."""
    if not user and not password:
        return public_url if public_url.endswith("/") else public_url + "/"
    scheme, host = public_url.split("://", 1)
    host = host.rstrip("/")
    return "%s://%s:%s@%s/" % (
        scheme,
        urllib.parse.quote(user or "", safe=""),
        urllib.parse.quote(password or "", safe=""),
        host,
    )


def make_handler(cfg, tunnels):
    """HTTP handler factory — closes over the config + tunnel manager (testable)."""

    class Handler(BaseHTTPRequestHandler):
        def _send(self, code, obj):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):  # quiet — we serve machine callers, not humans
            pass

        def do_GET(self):
            u = urllib.parse.urlparse(self.path)

            if u.path == "/health":
                # Token-free on purpose (cron probes it) — so it must leak nothing
                # actionable: vault names + a COUNT, never the live tunnel URLs (those
                # are exactly the unguessable hostnames the token gate protects).
                return self._send(
                    200,
                    {"ok": True, "active_tunnels": len(tunnels.snapshot()),
                     "vaults": sorted(cfg["vaults"].keys())},
                )

            if u.path != "/view":
                return self._send(404, {"error": "not found"})

            # Gate 2 (token): enforced when the token file exists; FAILS CLOSED if the
            # file exists but can't be read. Constant-time compare. See CONTRACT.md.
            mode, tok = read_token(cfg)
            if mode == "error":
                return self._send(503, {"error": "token file unreadable on the agent"})
            # Compare as BYTES: compare_digest on str raises TypeError on any non-ASCII
            # input (e.g. a pasted token with a BOM / non-breaking space), which would
            # 500 instead of the contract's 401 (review pass 4).
            if tok is not None and not hmac.compare_digest(
                (self.headers.get("X-View-Token") or "").encode("utf-8", "replace"),
                tok.encode("utf-8", "replace"),
            ):
                return self._send(401, {"error": "bad token"})

            q = urllib.parse.parse_qs(u.query)
            vault_name = (q.get("vault") or [""])[0]
            note = (q.get("note") or [""])[0]

            vault_cfg = cfg["vaults"].get(vault_name)
            if vault_cfg is None:
                # 4xx = per-vault, permanent condition (the router will NOT trip its
                # circuit-breaker on it). Echo the served vaults to ease config debugging.
                return self._send(
                    400, {"error": "unknown vault", "vaults": sorted(cfg["vaults"].keys())}
                )

            public_url = tunnels.ensure(vault_name, vault_cfg)
            if not public_url:
                # 5xx = agent-side failure (transient from the router's point of view).
                return self._send(502, {"error": "tunnel failed to start"})

            navigate(cfg, vault_cfg, note)

            user = vault_cfg.get("gui_user") or ""
            password = read_secret(cfg, vault_cfg, "gui_password", "gui_password_file")
            return self._send(
                200,
                {
                    # `url` is the ONE field the router requires (browser-ready).
                    "url": auth_url(public_url, user, password),
                    # Everything below is informative — ignored by the router.
                    "raw_url": public_url,
                    "vault": vault_name,
                    "note": note,
                    "idle_timeout_s": cfg["idle_timeout_s"],
                },
            )

    return Handler


def main(argv):
    config_path = (
        argv[1]
        if len(argv) > 1
        else os.environ.get("VIEW_AGENT_CONFIG", os.path.join(os.path.dirname(
            os.path.abspath(__file__)), "config.json"))
    )
    try:
        cfg = load_config(config_path)
    except ValueError as e:
        print("view-agent: %s" % e, file=sys.stderr)
        return 1

    tunnels = TunnelManager(cfg)
    threading.Thread(target=tunnels.reap_loop, daemon=True).start()
    srv = ThreadingHTTPServer((cfg["bind"], cfg["port"]), make_handler(cfg, tunnels))
    print(
        "view-agent listening on http://%s:%d (vaults: %s)"
        % (cfg["bind"], cfg["port"], ", ".join(sorted(cfg["vaults"].keys())))
    )
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
