"""Tests for view-agent.py — stdlib unittest only, no cloudflared needed.

Strategy: stand up the REAL ThreadingHTTPServer on an ephemeral loopback port with a
FAKE tunnel starter injected into TunnelManager, then exercise the /view contract over
actual HTTP (token gate, unknown vault, success shape, auth-in-URL, navigation call,
reaper). Config validation is tested directly on load_config().
"""
import http.client
import importlib.util
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))

# view-agent.py has a dash in its name → import it via importlib.
spec = importlib.util.spec_from_file_location(
    "view_agent", os.path.join(HERE, "..", "view-agent.py")
)
va = importlib.util.module_from_spec(spec)
spec.loader.exec_module(va)


class FakeProc:
    def __init__(self):
        self.terminated = False

    def poll(self):
        return 1 if self.terminated else None

    def terminate(self):
        self.terminated = True


def fake_start_factory(url="https://random-words.trycloudflare.com", fail=False):
    calls = []

    def start(vault_name, vault_cfg):
        calls.append(vault_name)
        if fail:
            return None
        return {"proc": FakeProc(), "url": url, "last": time.time()}

    start.calls = calls
    return start


def write_config(tmpdir, extra=None, vaults=None):
    cfg = {
        "bind": "127.0.0.1",
        "port": 0,  # not used by tests (we bind the server ourselves)
        "idle_timeout_s": 1800,
        "url_wait_s": 1,
        "token_file": "view-agent.token",
        "vaults": vaults
        if vaults is not None
        else {
            "alice": {
                "gui_url": "http://127.0.0.1:3001",
                "gui_user": "obsidian",
                "gui_password": "pw",
            }
        },
    }
    cfg.update(extra or {})
    path = os.path.join(tmpdir, "config.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cfg, f)
    return path


class AgentHttp:
    """Boot the real handler + a fake TunnelManager on an ephemeral port."""

    def __init__(self, cfg, start_fn):
        self.tunnels = va.TunnelManager(cfg, start_fn=start_fn)
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), va.make_handler(cfg, self.tunnels))
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def get(self, path, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("GET", path, headers=headers or {})
        res = conn.getresponse()
        body = json.loads(res.read().decode() or "{}")
        conn.close()
        return res.status, body

    def close(self):
        self.srv.shutdown()


class TestConfig(unittest.TestCase):
    def test_valid_config_loads_with_defaults(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = va.load_config(write_config(d))
            self.assertEqual(cfg["bind"], "127.0.0.1")
            self.assertEqual(cfg["idle_timeout_s"], 1800)
            self.assertIn("alice", cfg["vaults"])

    def test_missing_file_raises_clear_error(self):
        with self.assertRaisesRegex(ValueError, "config file not found"):
            va.load_config(os.path.join(tempfile.gettempdir(), "nope-view-agent.json"))

    def test_empty_vaults_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            path = write_config(d, vaults={})
            with self.assertRaisesRegex(ValueError, "non-empty"):
                va.load_config(path)

    def test_vault_missing_gui_url_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            path = write_config(d, vaults={"x": {"gui_user": "u"}})
            with self.assertRaisesRegex(ValueError, 'missing required key "gui_url"'):
                va.load_config(path)

    def test_vault_unknown_key_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            path = write_config(d, vaults={"x": {"gui_url": "http://127.0.0.1:1", "oops": 1}})
            with self.assertRaisesRegex(ValueError, "unknown key"):
                va.load_config(path)

    def test_underscore_comment_keys_tolerated(self):
        # The example config documents itself with "_"-prefixed keys — copying it
        # verbatim must work (review finding: the documented Quickstart crashed).
        with tempfile.TemporaryDirectory() as d:
            path = write_config(
                d,
                vaults={
                    "alice": {
                        "gui_url": "http://127.0.0.1:3001",
                        "_gui_url": "comment",
                        "_open": "another comment",
                    }
                },
            )
            cfg = va.load_config(path)  # must not raise
            self.assertIn("alice", cfg["vaults"])

    def test_shipped_example_config_loads_verbatim(self):
        cfg = va.load_config(os.path.join(HERE, "..", "config.example.json"))
        self.assertEqual(sorted(cfg["vaults"].keys()), ["alice", "work"])

    def test_secret_file_resolved_relative_to_config_dir(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "secrets"))
            with open(os.path.join(d, "secrets", "alice.pw"), "w") as f:
                f.write("s3cret\n")
            path = write_config(
                d,
                vaults={
                    "alice": {
                        "gui_url": "http://127.0.0.1:3001",
                        "gui_password_file": "secrets/alice.pw",
                    }
                },
            )
            cfg = va.load_config(path)
            pw = va.read_secret(cfg, cfg["vaults"]["alice"], "gui_password", "gui_password_file")
            self.assertEqual(pw, "s3cret")


class TestAuthUrl(unittest.TestCase):
    def test_bakes_credentials(self):
        self.assertEqual(
            va.auth_url("https://x.trycloudflare.com", "user", "p@ss w"),
            "https://user:p%40ss%20w@x.trycloudflare.com/",
        )

    def test_no_credentials_returns_raw_with_slash(self):
        self.assertEqual(
            va.auth_url("https://x.trycloudflare.com", "", ""),
            "https://x.trycloudflare.com/",
        )


class TestViewEndpoint(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg = va.load_config(write_config(self.tmp.name))
        self.start = fake_start_factory()
        self.agent = AgentHttp(self.cfg, self.start)

    def tearDown(self):
        self.agent.close()
        self.tmp.cleanup()

    def test_health_lists_vaults_but_never_tunnel_urls(self):
        self.agent.get("/view?vault=alice")  # warm a tunnel first
        status, body = self.agent.get("/health")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["vaults"], ["alice"])
        # /health is token-free → it must expose a COUNT, never the live tunnel URLs
        # (review finding: leaking them defeats the unguessable-hostname layer).
        self.assertEqual(body["active_tunnels"], 1)
        self.assertNotIn("trycloudflare", json.dumps(body))

    def test_unknown_path_404(self):
        status, body = self.agent.get("/nope")
        self.assertEqual(status, 404)

    def test_unknown_vault_400_with_vault_list(self):
        status, body = self.agent.get("/view?vault=bob")
        self.assertEqual(status, 400)
        self.assertEqual(body["error"], "unknown vault")
        self.assertEqual(body["vaults"], ["alice"])

    def test_success_contract_shape(self):
        status, body = self.agent.get("/view?vault=alice&note=Notes%2Fhello.md")
        self.assertEqual(status, 200)
        # `url` is the one REQUIRED field — browser-ready with auth baked in.
        self.assertEqual(body["url"], "https://obsidian:pw@random-words.trycloudflare.com/")
        self.assertEqual(body["raw_url"], "https://random-words.trycloudflare.com")
        self.assertEqual(body["idle_timeout_s"], 1800)
        self.assertEqual(body["vault"], "alice")
        self.assertEqual(body["note"], "Notes/hello.md")

    def test_tunnel_reused_while_warm(self):
        self.agent.get("/view?vault=alice")
        self.agent.get("/view?vault=alice")
        self.assertEqual(len(self.start.calls), 1, "second call must reuse the warm tunnel")

    def test_tunnel_failure_is_502(self):
        agent = AgentHttp(self.cfg, fake_start_factory(fail=True))
        try:
            status, body = agent.get("/view?vault=alice")
            self.assertEqual(status, 502)
            self.assertIn("tunnel", body["error"])
        finally:
            agent.close()


class TestTokenGate(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        path = write_config(self.tmp.name)
        with open(os.path.join(self.tmp.name, "view-agent.token"), "w") as f:
            f.write("sekrit\n")
        self.cfg = va.load_config(path)
        self.agent = AgentHttp(self.cfg, fake_start_factory())

    def tearDown(self):
        self.agent.close()
        self.tmp.cleanup()

    def test_missing_token_401(self):
        status, body = self.agent.get("/view?vault=alice")
        self.assertEqual(status, 401)
        self.assertEqual(body["error"], "bad token")

    def test_wrong_token_401(self):
        status, _ = self.agent.get("/view?vault=alice", headers={"X-View-Token": "wrong"})
        self.assertEqual(status, 401)

    def test_non_ascii_token_is_401_not_500(self):
        # compare_digest on str raises TypeError on non-ASCII — must yield a clean 401,
        # never an unhandled 500 (review pass 4).
        status, _ = self.agent.get("/view?vault=alice", headers={"X-View-Token": "sékrit"})
        self.assertEqual(status, 401)

    def test_empty_token_file_fails_closed_503(self):
        # An existing-but-empty token file means a botched secret generation — the gate
        # must fail closed rather than silently disarm (review pass 2).
        with tempfile.TemporaryDirectory() as d:
            path = write_config(d)
            open(os.path.join(d, "view-agent.token"), "w").close()  # empty
            cfg = va.load_config(path)
            agent = AgentHttp(cfg, fake_start_factory())
            try:
                status, _ = agent.get("/view?vault=alice")
                self.assertEqual(status, 503)
            finally:
                agent.close()

    def test_good_token_200(self):
        status, body = self.agent.get("/view?vault=alice", headers={"X-View-Token": "sekrit"})
        self.assertEqual(status, 200)
        self.assertIn("url", body)

    def test_health_not_gated(self):
        status, _ = self.agent.get("/health")
        self.assertEqual(status, 200)

    def test_unreadable_token_file_fails_closed_503(self):
        # Point token_file at a DIRECTORY: open() raises an OSError that is NOT
        # FileNotFoundError on every platform → the gate must fail CLOSED (503),
        # never silently disarm (review finding).
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "tokdir"))
            cfg = va.load_config(write_config(d, extra={"token_file": "tokdir"}))
            agent = AgentHttp(cfg, fake_start_factory())
            try:
                status, body = agent.get("/view?vault=alice",
                                         headers={"X-View-Token": "whatever"})
                self.assertEqual(status, 503)
                self.assertIn("token", body["error"])
            finally:
                agent.close()


class TestPerVaultLocking(unittest.TestCase):
    def test_cold_start_of_one_vault_does_not_block_another(self):
        # Review finding: a single global lock serialized every request behind one
        # vault's cold start (up to url_wait_s). With per-vault locks, a warm/fast
        # vault must answer while another vault's tunnel is still starting.
        with tempfile.TemporaryDirectory() as d:
            cfg = va.load_config(
                write_config(
                    d,
                    vaults={
                        "slow": {"gui_url": "http://127.0.0.1:3001"},
                        "fast": {"gui_url": "http://127.0.0.1:3002"},
                    },
                )
            )

            def start(vault_name, vault_cfg):
                if vault_name == "slow":
                    time.sleep(1.5)
                return {"proc": FakeProc(),
                        "url": "https://%s.trycloudflare.com" % vault_name,
                        "last": time.time()}

            tm = va.TunnelManager(cfg, start_fn=start)
            threading.Thread(
                target=tm.ensure, args=("slow", cfg["vaults"]["slow"]), daemon=True
            ).start()
            time.sleep(0.2)  # let the slow cold start grab its vault lock
            t0 = time.time()
            url = tm.ensure("fast", cfg["vaults"]["fast"])
            elapsed = time.time() - t0
            self.assertEqual(url, "https://fast.trycloudflare.com")
            self.assertLess(elapsed, 1.0, "fast vault must not wait behind slow's cold start")


class TestReaper(unittest.TestCase):
    def test_reaps_idle_and_dead_tunnels(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = va.load_config(write_config(d, extra={"idle_timeout_s": 100}))
            tm = va.TunnelManager(cfg, start_fn=fake_start_factory())
            tm.ensure("alice", cfg["vaults"]["alice"])
            self.assertEqual(tm.reap_once(now=time.time() + 50), [], "warm → kept")
            self.assertEqual(tm.reap_once(now=time.time() + 200), ["alice"], "idle → reaped")
            # dead proc → reaped regardless of idle time
            tm.ensure("alice", cfg["vaults"]["alice"])
            tm.tunnels["alice"]["proc"].terminate()
            self.assertEqual(tm.reap_once(), ["alice"])


class _FakeProc:
    """poll() returns None (alive) or a code (dead)."""
    def __init__(self, alive=True):
        self._alive = alive
    def poll(self):
        return None if self._alive else 0


class TestWaitRegistered(unittest.TestCase):
    """cloudflared prints the tunnel URL on ALLOCATION, seconds before the edge can
    actually route it (Cloudflare error 1033 in that window — field bug 2026-06-10).
    _wait_registered() watches the LOCAL log for "Registered tunnel connection"
    instead of probing the public URL (a host egress quirk — e.g. broken IPv6 —
    would make a remote probe a false judge that kills healthy tunnels)."""

    def _tm(self, d, register_wait_s=2, register_grace_s=0):
        cfg = va.load_config(write_config(d, extra={
            "register_wait_s": register_wait_s, "register_grace_s": register_grace_s,
        }))
        return va.TunnelManager(cfg, start_fn=fake_start_factory())

    def test_registered_line_means_ready(self):
        with tempfile.TemporaryDirectory() as d:
            log = os.path.join(d, "cf.log")
            with open(log, "w", encoding="utf-8") as f:
                f.write("INF Registered tunnel connection connIndex=0\n")
            self.assertTrue(self._tm(d)._wait_registered(log, _FakeProc(alive=True)))

    def test_unregistered_times_out_false(self):
        with tempfile.TemporaryDirectory() as d:
            log = os.path.join(d, "cf.log")
            with open(log, "w", encoding="utf-8") as f:
                f.write("INF tunnel URL allocated, still connecting...\n")
            self.assertFalse(
                self._tm(d, register_wait_s=1)._wait_registered(log, _FakeProc(alive=True))
            )

    def test_dead_proc_short_circuits_false(self):
        with tempfile.TemporaryDirectory() as d:
            log = os.path.join(d, "cf.log")
            open(log, "w").close()
            t0 = time.time()
            ok = self._tm(d, register_wait_s=30)._wait_registered(log, _FakeProc(alive=False))
            self.assertFalse(ok)
            self.assertLess(time.time() - t0, 5, "died -> returns fast, not after the full wait")


class TestNavigate(unittest.TestCase):
    def test_navigate_posts_open_with_bearer(self):
        seen = {}

        class OpenStub(BaseHTTPRequestHandler):
            def do_POST(self):
                seen["path"] = self.path
                seen["auth"] = self.headers.get("Authorization")
                self.send_response(200)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *a):
                pass

        srv = ThreadingHTTPServer(("127.0.0.1", 0), OpenStub)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            with tempfile.TemporaryDirectory() as d:
                path = write_config(
                    d,
                    vaults={
                        "alice": {
                            "gui_url": "http://127.0.0.1:3001",
                            "open_url": "http://127.0.0.1:%d" % srv.server_address[1],
                            "open_api_key": "k3y",
                        }
                    },
                )
                cfg = va.load_config(path)
                va.navigate(cfg, cfg["vaults"]["alice"], "Notes/héllo file.md")
                self.assertEqual(seen["path"], "/open/Notes%2Fh%C3%A9llo%20file.md")
                self.assertEqual(seen["auth"], "Bearer k3y")
        finally:
            srv.shutdown()

    def test_navigate_failure_is_swallowed(self):
        with tempfile.TemporaryDirectory() as d:
            path = write_config(
                d,
                vaults={
                    "alice": {
                        "gui_url": "http://127.0.0.1:3001",
                        "open_url": "http://127.0.0.1:1",  # refused port
                    }
                },
            )
            cfg = va.load_config(path)
            va.navigate(cfg, cfg["vaults"]["alice"], "x.md")  # must not raise


if __name__ == "__main__":
    unittest.main()
