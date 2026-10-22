"""Tests for view-agent-direct.py — stdlib unittest only, no Docker needed.

Strategy: stand up the REAL ThreadingHTTPServer on an ephemeral loopback port with a
FAKE navigator injected into make_handler, then exercise /view and /go over actual HTTP
(token gate, signed link shape, click-time navigation, signature and expiry checks,
failure page). Pure helpers (path guard, /open encoding, docker-exec command) are tested
directly.
"""
import importlib.util
import json
import os
import shutil
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))

# view-agent-direct.py has dashes in its name → import it via importlib.
spec = importlib.util.spec_from_file_location(
    "view_agent_direct", os.path.join(HERE, "..", "view-agent-direct.py")
)
va = importlib.util.module_from_spec(spec)
spec.loader.exec_module(va)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


class AgentTestBase(unittest.TestCase):
    EXTRA = {}

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        with open(os.path.join(self.dir, "view-agent.token"), "w") as f:
            f.write("tok-123\n")
        cfg = {
            "bind": "127.0.0.1", "port": 0, "self_url": "http://agent.test:27200",
            "token_file": "view-agent.token", "link_secret_file": "absent.secret",
            "vaults": {"alice": {"public_url": "https://gui.test:3001/", "open_mode": "none"}},
        }
        cfg.update(self.EXTRA)
        self.cfg_path = os.path.join(self.dir, "config.json")
        with open(self.cfg_path, "w") as f:
            json.dump(cfg, f)
        self.cfg = va.load_config(self.cfg_path)
        self.calls = []

        def fake_nav(vault_cfg, note, anchor=""):
            self.calls.append((note, anchor))
            return (not note.startswith("fail"), "test")

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), va.make_handler(self.cfg, fake_nav))
        self.base = "http://127.0.0.1:%d" % self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def get(self, path, headers=None):
        opener = urllib.request.build_opener(NoRedirect)
        req = urllib.request.Request(self.base + path, headers=headers or {})
        try:
            r = opener.open(req, timeout=5)
            return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def mint(self, query):
        """Call /view with the right token; return (response JSON, /go path on this server)."""
        code, _, body = self.get("/view?" + query, {"X-View-Token": "tok-123"})
        self.assertEqual(code, 200)
        data = json.loads(body)
        return data, data["url"].split("agent.test:27200", 1)[-1]


class TestView(AgentTestBase):
    def test_health_is_token_free(self):
        code, _, body = self.get("/health")
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body)["vaults"], ["alice"])

    def test_view_requires_token(self):
        code, _, _ = self.get("/view?vault=alice&note=a.md")
        self.assertEqual(code, 401)

    def test_view_returns_signed_go_link_without_navigating(self):
        data, _ = self.mint("vault=alice&note=wiki/a%20b.md&h=Intro")
        self.assertTrue(data["url"].startswith("http://agent.test:27200/go?"))
        q = urllib.parse.parse_qs(urllib.parse.urlparse(data["url"]).query)
        self.assertEqual(q["v"], ["alice"])
        self.assertEqual(q["n"], ["wiki/a b.md"])
        self.assertEqual(q["h"], ["Intro"])
        self.assertIn("s", q)
        self.assertNotIn("idle_timeout_s", data)  # stable link: nothing to expire
        self.assertEqual(self.calls, [])

    def test_view_unknown_vault_is_4xx(self):
        code, _, _ = self.get("/view?vault=x&note=a.md", {"X-View-Token": "tok-123"})
        self.assertEqual(code, 400)

    def test_view_without_note_links_the_gui(self):
        data, _ = self.mint("vault=alice")
        self.assertEqual(data["url"], "https://gui.test:3001/")


class TestGo(AgentTestBase):
    def test_go_navigates_then_redirects(self):
        _, path = self.mint("vault=alice&note=wiki/a.md&h=Intro")
        code, headers, _ = self.get(path)
        self.assertEqual(code, 302)
        self.assertEqual(headers["Location"], "https://gui.test:3001/")
        self.assertEqual(self.calls, [("wiki/a.md", "Intro")])

    def test_go_bad_signature(self):
        code, _, _ = self.get("/go?v=alice&n=wiki/a.md&s=deadbeef")
        self.assertEqual(code, 403)
        self.assertEqual(self.calls, [])

    def test_go_failed_navigation_explains(self):
        _, path = self.mint("vault=alice&note=fail.md")
        code, _, body = self.get(path)
        self.assertEqual(code, 502)
        self.assertIn(b"gui.test:3001", body)

    def test_go_failure_page_escapes_the_note(self):
        _, path = self.mint("vault=alice&note=" + urllib.parse.quote("fail<script>.md"))
        code, _, body = self.get(path)
        self.assertEqual(code, 502)
        self.assertNotIn(b"<script>", body)
        self.assertIn(b"&lt;script&gt;", body)

    def test_expiry_is_covered_by_the_signature(self):
        self.cfg["link_ttl_s"] = 1
        link = va.build_go_link(self.cfg, "alice", "a.md")
        q = urllib.parse.parse_qs(urllib.parse.urlparse(link).query)
        q["e"] = ["1"]  # in the past, but the signature covers e → 403 first
        ok, code, *_ = va.verify_go(self.cfg, q)
        self.assertFalse(ok)
        self.assertEqual(code, 403)


class TestTtl(AgentTestBase):
    EXTRA = {"link_ttl_s": 600}

    def test_ttl_link_reports_its_lifetime(self):
        data, _ = self.mint("vault=alice&note=a.md")
        self.assertEqual(data["idle_timeout_s"], 600)
        q = urllib.parse.parse_qs(urllib.parse.urlparse(data["url"]).query)
        self.assertIn("e", q)


class TestObsidianUri(AgentTestBase):
    """A vault opened in the reader's own desktop Obsidian: no GUI, no navigation here."""
    EXTRA = {"vaults": {
        "alice": {"public_url": "https://gui.test:3001/", "open_mode": "none"},
        "desk": {"open_mode": "obsidian-uri", "obsidian_vault": "Mon vault & co"},
    }}

    def test_go_redirects_to_the_desktop_obsidian(self):
        _, path = self.mint("vault=desk&note=" + urllib.parse.quote("wiki/a b#c.md") + "&h=Intro")
        code, headers, _ = self.get(path)
        self.assertEqual(code, 302)
        self.assertEqual(headers["Location"],
                         "obsidian://open?vault=Mon%20vault%20%26%20co&file=wiki%2Fa%20b%23c.md")
        self.assertEqual(self.calls, [])  # nothing driven from this host

    def test_go_still_requires_the_signature(self):
        code, _, _ = self.get("/go?v=desk&n=wiki/a.md&s=deadbeef")
        self.assertEqual(code, 403)

    def test_go_refuses_a_traversal_even_when_signed(self):
        # /view refuses it before minting; sign it by hand to reach /go.
        link = va.build_go_link(self.cfg, "desk", "../secret.md")
        code, _, _ = self.get(link.split("agent.test:27200", 1)[-1])
        self.assertEqual(code, 400)

    def test_go_refuses_windows_and_other_absolute_paths(self):
        # Any absolute Windows path: not a user-profile one, which the router
        # repository's release gate refuses to publish, fixture or not.
        for bad in ("C:\\Data\\secret.md", "C:/Data/secret.md", "c:secret.md",
                    "\\\\host\\share\\x.md", "/etc/x.md", "wiki/../../x.md"):
            link = va.build_go_link(self.cfg, "desk", bad)
            code, headers, _ = self.get(link.split("agent.test:27200", 1)[-1])
            self.assertEqual(code, 400, bad)
            self.assertNotIn("Location", headers)

    def test_go_encodes_hostile_values_into_one_file_parameter(self):
        note = "wiki/a&vault=other&file=x;Set-Cookie: y#é.md"
        link = va.build_go_link(self.cfg, "desk", note)
        code, headers, _ = self.get(link.split("agent.test:27200", 1)[-1])
        self.assertEqual(code, 302)
        q = urllib.parse.parse_qs(urllib.parse.urlparse(headers["Location"]).query)
        self.assertEqual(q, {"vault": ["Mon vault & co"], "file": [note]})
        self.assertNotIn("Set-Cookie", headers)

    def test_view_without_note_opens_the_vault(self):
        data, _ = self.mint("vault=desk")
        self.assertEqual(data["url"], "obsidian://open?vault=Mon%20vault%20%26%20co")

    def test_config_requires_obsidian_vault_but_not_public_url(self):
        d = tempfile.mkdtemp()
        try:
            p = os.path.join(d, "config.json")
            with open(p, "w") as f:
                json.dump({"vaults": {"desk": {"open_mode": "obsidian-uri"}}}, f)
            with self.assertRaises(ValueError):
                va.load_config(p)
            with open(p, "w") as f:
                json.dump({"vaults": {"desk": {"open_mode": "obsidian-uri", "obsidian_vault": "V"}}}, f)
            self.assertIn("desk", va.load_config(p)["vaults"])
            with open(p, "w") as f:
                json.dump({"vaults": {"desk": {"open_mode": "obsidian-uri", "obsidian_vault": "   "}}}, f)
            with self.assertRaises(ValueError):
                va.load_config(p)
            with open(p, "w") as f:  # the exemption is for obsidian-uri only
                json.dump({"vaults": {"a": {"open_mode": "none"}}}, f)
            with self.assertRaises(ValueError):
                va.load_config(p)
        finally:
            shutil.rmtree(d, ignore_errors=True)


ID_A = "a" * 64
ID_B = "b" * 64


def container(cid, name, ports, running=True, mounts=None):
    """A `docker inspect` object; ports = {"<inner>/tcp": [(host_ip, host_port), ...]}.
    By default the container mounts its own vault folder, /srv/vaults/<name>."""
    if mounts is None:
        mounts = [{"Type": "bind", "Source": "/srv/vaults/" + name, "Destination": "/vaults/x"}]
    return {"Id": cid, "Name": "/" + name, "State": {"Running": running}, "Mounts": mounts,
            "NetworkSettings": {"Ports": {k: [{"HostIp": ip, "HostPort": str(p)} for ip, p in v]
                                          for k, v in ports.items()}}}


VAULTS_HOST = [
    container(ID_A, "obsidian-notes", {"27180/tcp": [("0.0.0.0", 27180), ("::", 27180)],
                                        "3001/tcp": [("0.0.0.0", 3001), ("::", 3001)]}),
    container(ID_B, "obsidian-bob", {"27180/tcp": [("0.0.0.0", 27181)],
                                           "3001/tcp": [("0.0.0.0", 3002)]}),
]


class FakeDocker:
    """Records every argv and answers `docker ps` / `docker inspect` from `self.containers`."""

    def __init__(self, containers):
        self.containers = containers
        self.cmds = []
        self.ps_stdout = None       # override `docker ps` output
        self.inspect_stdout = None  # override `docker inspect` output
        self.raises = None          # exception raised by every call (docker missing)
        self.timeouts = []          # timeout handed to every call
        self.delay = 0              # seconds each call takes (slow Docker)

    def __call__(self, cmd, timeout=None):
        self.cmds.append(list(cmd))
        self.timeouts.append(timeout)
        if self.delay:
            time.sleep(self.delay)
        if self.raises:
            raise self.raises

        class R:
            returncode, stderr = 0, ""
        r = R()
        if cmd[1] == "ps":
            r.stdout = self.ps_stdout if self.ps_stdout is not None else \
                "".join(c["Id"] + "\n" for c in self.containers)
        elif cmd[1] == "inspect":
            r.stdout = self.inspect_stdout if self.inspect_stdout is not None else \
                json.dumps([c for c in self.containers if c["Id"] in cmd[4:]])
        else:
            raise AssertionError("unexpected docker command %r" % cmd)
        return r


class DetectBase(AgentTestBase):
    """Agent on 192.0.2.1 (the server), reader's desktop on 192.0.2.10. `alice` stays
    configured; everything else is detected from the router's hints."""
    EXTRA = {"bind": "192.0.2.1", "detect": {"desktop_hosts": ["192.0.2.10"], "cache_s": 0}}
    CONTAINERS = VAULTS_HOST

    def setUp(self):
        self.docker = FakeDocker([dict(c) for c in self.CONTAINERS])
        super().setUp()


def _serve_with_docker(self):
    """AgentTestBase.setUp builds the server without a docker runner: rebuild it with one."""
    self.srv.shutdown()
    self.srv.server_close()

    def fake_nav(vault_cfg, note, anchor=""):
        self.calls.append((note, anchor))
        self.nav_cfgs.append(vault_cfg)
        if getattr(self, "on_nav", None):
            self.on_nav()                       # e.g. Docker changes while Obsidian navigates
        return (not note.startswith("fail"), "test")

    self.nav_cfgs = []
    self.srv = ThreadingHTTPServer(("127.0.0.1", 0), va.make_handler(self.cfg, fake_nav, self.docker))
    self.base = "http://127.0.0.1:%d" % self.srv.server_address[1]
    threading.Thread(target=self.srv.serve_forever, daemon=True).start()


class TestDetectContainer(DetectBase):
    def setUp(self):
        super().setUp()
        _serve_with_docker(self)

    def view(self, query):
        return self.get("/view?" + query, {"X-View-Token": "tok-123"})

    def test_container_vault_is_detected_and_navigated_by_id(self):
        data, path = self.mint("vault=notes&note=wiki/a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
        self.assertEqual(data["open_mode"], "docker-exec")
        self.assertEqual(data["source"], "container obsidian-notes")
        q = urllib.parse.parse_qs(urllib.parse.urlparse(data["url"]).query)
        self.assertEqual(q["r"], ["http://192.0.2.1:27180"])
        code, headers, _ = self.get(path)
        self.assertEqual(code, 302)
        self.assertEqual(headers["Location"], "https://192.0.2.1:3001/")
        self.assertEqual(self.nav_cfgs[-1]["container"], ID_A)       # the hex ID, not a name
        self.assertEqual(self.nav_cfgs[-1]["open_port"], 27180)

    def test_published_port_maps_to_the_inner_port_and_its_gui(self):
        data, path = self.mint("vault=bob&note=a.md&rest=" + urllib.parse.quote("https://192.0.2.1:27181"))
        code, headers, _ = self.get(path)
        self.assertEqual(headers["Location"], "https://192.0.2.1:3002/")
        self.assertEqual(self.nav_cfgs[-1]["container"], ID_B)
        self.assertEqual(self.nav_cfgs[-1]["open_port"], 27180)       # inside the container

    def test_docker_is_only_called_with_fixed_argv(self):
        self.mint("vault=notes&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
        self.assertEqual(self.docker.cmds, [
            ["docker", "ps", "--no-trunc", "-q"],
            ["docker", "inspect", "--type", "container", ID_A, ID_B],
        ])

    def test_manual_config_wins_over_detection(self):
        data, path = self.mint("vault=alice&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
        self.assertEqual(data["source"], "config")
        self.assertNotIn("r=", data["url"])
        code, headers, _ = self.get(path)
        self.assertEqual(headers["Location"], "https://gui.test:3001/")
        self.assertEqual(self.docker.cmds, [])

    def test_unknown_vault_without_hints_is_still_400(self):
        code, _, body = self.view("vault=x&note=a.md")
        self.assertEqual(code, 400)
        self.assertEqual(json.loads(body)["error"], "unknown vault")

    def test_no_container_on_that_port_is_an_explicit_400(self):
        code, _, body = self.view("vault=x&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27999"))
        self.assertEqual(code, 400)
        self.assertIn("27999", json.loads(body)["error"])

    def test_port_published_on_another_ip_does_not_match(self):
        self.docker.containers = [container(ID_A, "obs", {"27180/tcp": [("127.0.0.1", 27180)],
                                                          "3001/tcp": [("0.0.0.0", 3001)]})]
        code, _, _ = self.view("vault=x&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
        self.assertEqual(code, 400)

    def test_two_containers_on_one_port_is_ambiguous(self):
        self.docker.containers = [
            container(ID_A, "one", {"27180/tcp": [("0.0.0.0", 27180)], "3001/tcp": [("0.0.0.0", 3001)]}),
            container(ID_B, "two", {"27180/tcp": [("192.0.2.1", 27180)], "3001/tcp": [("0.0.0.0", 3002)]}),
        ]
        code, _, body = self.view("vault=x&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
        self.assertEqual(code, 400)
        self.assertIn("one, two", json.loads(body)["error"])

    def test_container_without_gui_port_is_an_explicit_400(self):
        self.docker.containers = [container(ID_A, "obs", {"27180/tcp": [("0.0.0.0", 27180)]})]
        code, _, body = self.view("vault=x&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
        self.assertEqual(code, 400)
        self.assertIn("GUI", json.loads(body)["error"])

    def test_stopped_container_is_ignored(self):
        self.docker.containers = [dict(VAULTS_HOST[0], State={"Running": False})]
        code, _, _ = self.view("vault=x&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
        self.assertEqual(code, 400)

    def test_unexpected_docker_ps_output_fails_closed_before_inspect(self):
        self.docker.ps_stdout = ID_A + "\n--format={{.Name}};id\n"
        code, _, _ = self.view("vault=x&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
        self.assertEqual(code, 503)
        self.assertEqual([c[1] for c in self.docker.cmds], ["ps"])

    def test_inspect_object_with_a_forged_id_is_ignored(self):
        forged = container("c" * 64, "evil", {"27180/tcp": [("0.0.0.0", 27180)], "3001/tcp": [("0.0.0.0", 3001)]})
        self.docker.ps_stdout = ID_A + "\n"             # ps never listed c…c
        self.docker.inspect_stdout = json.dumps([forged])
        code, _, _ = self.view("vault=x&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
        self.assertEqual(code, 400)

    def test_docker_unavailable_is_503(self):
        self.docker.raises = FileNotFoundError("docker")
        code, _, _ = self.view("vault=x&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
        self.assertEqual(code, 503)

    def test_go_redetects_and_explains_when_the_container_is_gone(self):
        _, path = self.mint("vault=notes&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
        self.docker.containers = []
        code, headers, body = self.get(path)
        self.assertEqual(code, 400)             # the classification error's own code, not 502
        self.assertNotIn("Location", headers)
        self.assertIn(b"27180", body)
        self.assertEqual(self.calls, [])

    def test_hint_is_covered_by_the_signature(self):
        _, path = self.mint("vault=notes&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
        tampered = path.replace("27180", "27181")
        self.assertEqual(self.get(tampered)[0], 403)
        stripped = "&".join(p for p in path.split("&") if not p.startswith("r="))
        self.assertEqual(self.get(stripped)[0], 403)
        self.assertEqual(self.calls, [])

    def test_hint_cannot_be_added_to_a_legacy_link(self):
        link = va.build_go_link(self.cfg, "ghost", "a.md")    # legacy format, unknown vault
        path = link.split("agent.test:27200", 1)[-1] + "&r=" + urllib.parse.quote("http://192.0.2.1:27180")
        self.assertEqual(self.get(path)[0], 403)

    def test_loopback_hint_uses_the_readers_host_for_the_gui(self):
        _, path = self.mint("vault=x&note=a.md&rest=" + urllib.parse.quote("http://127.0.0.1:27180"))
        self.assertEqual(self.get(path)[1]["Location"], "https://agent.test:3001/")

    def test_malformed_rest_hint_is_a_400_not_a_dropped_connection(self):
        code, _, body = self.view("vault=x&note=a.md&rest=" + urllib.parse.quote("http://[::1:80"))
        self.assertEqual(code, 400)
        self.assertIn("rest hint", json.loads(body)["error"])

    def test_https_hint_navigates_over_https_on_loopback(self):
        _, path = self.mint("vault=bob&note=a.md&rest=" + urllib.parse.quote("https://192.0.2.1:27181"))
        self.get(path)
        self.assertEqual(self.nav_cfgs[-1]["open_scheme"], "https")
        _, path = self.mint("vault=v&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
        self.get(path)
        self.assertEqual(self.nav_cfgs[-1]["open_scheme"], "http")

    def test_gui_bound_to_loopback_is_not_offered_to_the_reader(self):
        self.docker.containers = [container(ID_A, "obs", {"27180/tcp": [("127.0.0.1", 27180)],
                                                          "3001/tcp": [("127.0.0.1", 3001)]})]
        code, _, body = self.view("vault=x&note=a.md&rest=" + urllib.parse.quote("http://127.0.0.1:27180"))
        self.assertEqual(code, 400)
        self.assertIn("GUI", json.loads(body)["error"])

    def test_malformed_docker_inspect_shapes_never_crash(self):
        weird = [{"Id": ID_A, "State": "running", "NetworkSettings": {"Ports": {}}},
                 {"Id": ID_B, "State": {"Running": True}, "NetworkSettings": {"Ports": [1, 2]}}]
        for objs in (weird, [dict(container(ID_A, "o", {"27180/tcp": [("0.0.0.0", 27180)]}),
                                  NetworkSettings={"Ports": {"27180/tcp": ["x", {"HostPort": "\u00b2"}]}})],
                     [{"Id": ID_A, "State": {"Running": True}, "NetworkSettings": 5}], "nope"):
            self.docker.ps_stdout = ID_A + "\n" + ID_B + "\n"
            self.docker.inspect_stdout = json.dumps(objs)
            code, _, _ = self.view("vault=x&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
            self.assertIn(code, (400, 503), repr(objs))

    def test_one_malformed_bind_does_not_hide_the_container(self):
        c = container(ID_A, "obs", {"27180/tcp": [("0.0.0.0", 27180)], "3001/tcp": [("0.0.0.0", 3001)]})
        c["NetworkSettings"]["Ports"]["27180/tcp"].insert(0, "x")
        c["NetworkSettings"]["Ports"]["9/tcp"] = [{"HostPort": "\u00b2"}]
        self.docker.containers = [c]
        data, _ = self.mint("vault=x&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
        self.assertEqual(data["source"], "container obs")

    def test_localhost_hint_matches_a_loopback_binding(self):
        self.docker.containers = [container(ID_A, "obs", {"27180/tcp": [("127.0.0.1", 27180)],
                                                          "3001/tcp": [("0.0.0.0", 3001)]})]
        data, _ = self.mint("vault=x&note=a.md&rest=" + urllib.parse.quote("http://localhost:27180"))
        self.assertEqual(data["source"], "container obs")

    def test_detection_link_for_a_since_configured_vault_is_refused(self):
        # Minted by detection, then the same name was configured (maybe pointing elsewhere):
        # the old link must not follow the configuration unchecked.
        hints = {"rest": "http://192.0.2.1:27180", "container": "obsidian-notes", "vault_id": "0" * 16}
        link = va.build_go_link(self.cfg, "alice", "a.md", "", hints)
        code, headers, _ = self.get(link.split("agent.test:27200", 1)[-1])
        self.assertEqual(code, 409)
        self.assertNotIn("Location", headers)
        self.assertEqual(self.calls, [])

    def test_ipv4_mapped_local_address_is_local(self):
        data, _ = self.mint("vault=x&note=a.md&rest=" + urllib.parse.quote("http://[::ffff:192.0.2.1]:27180"))
        self.assertEqual(data["source"], "container obsidian-notes")

    def test_docker_down_is_remembered_briefly(self):
        self.cfg["detect"]["cache_s"] = 60
        self.docker.raises = FileNotFoundError("docker")
        for _ in range(3):
            self.assertEqual(self.view("vault=x&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))[0], 503)
        self.assertEqual(len(self.docker.cmds), 1)

    def test_unreadable_secret_is_503_on_the_detection_path(self):
        os.mkdir(os.path.join(self.dir, "absent.secret"))          # a directory: unreadable
        code, _, _ = self.view("vault=x&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
        self.assertEqual(code, 503)

    def test_unexpected_exception_is_a_json_500(self):
        self.srv.shutdown()
        self.srv.server_close()

        def boom(*a, **k):
            raise KeyError("x")
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), va.make_handler(self.cfg, boom, self.docker))
        self.base = "http://127.0.0.1:%d" % self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        _, path = self.mint("vault=alice&note=a.md")
        code, _, body = self.get(path)
        self.assertEqual(code, 500)
        self.assertEqual(json.loads(body), {"error": "internal error"})

    # --- the vault's identity is signed: a port taken over by another vault is refused
    def test_port_taken_over_by_another_container_is_refused_at_go(self):
        _, path = self.mint("vault=notes&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
        self.docker.containers = [container("e" * 64, "obsidian-eve", {
            "27180/tcp": [("0.0.0.0", 27180)], "3001/tcp": [("0.0.0.0", 3001)]})]
        code, headers, body = self.get(path)
        self.assertEqual(code, 409)
        self.assertNotIn("Location", headers)
        self.assertIn(b"obsidian-eve", body)
        self.assertEqual(self.calls, [])

    def test_same_name_mounting_another_vault_is_refused_at_go(self):
        _, path = self.mint("vault=notes&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
        other = container("e" * 64, "obsidian-notes", {                # same name, another vault
            "27180/tcp": [("0.0.0.0", 27180)], "3001/tcp": [("0.0.0.0", 3001)]},
            mounts=[{"Type": "bind", "Source": "/srv/vaults/eve", "Destination": "/vaults/x"}])
        self.docker.containers = [other]
        code, headers, _ = self.get(path)
        self.assertEqual(code, 409)
        self.assertNotIn("Location", headers)
        self.assertEqual(self.calls, [])

    def _takeover(self, mounts):
        _, path = self.mint("vault=notes&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
        self.docker.containers = [container("e" * 64, "obsidian-notes", {
            "27180/tcp": [("0.0.0.0", 27180)], "3001/tcp": [("0.0.0.0", 3001)]}, mounts=mounts)]
        return self.get(path)

    def test_swapped_destinations_are_another_vault(self):
        a = {"Type": "bind", "Source": "/srv/a", "Destination": "/vault"}
        b = {"Type": "bind", "Source": "/srv/b", "Destination": "/backup"}
        self.docker.containers = [container(ID_A, "obsidian-notes", {
            "27180/tcp": [("0.0.0.0", 27180)], "3001/tcp": [("0.0.0.0", 3001)]}, mounts=[a, b])]
        code, headers, _ = self._takeover([dict(a, Destination="/backup"), dict(b, Destination="/vault")])
        self.assertEqual(code, 409)
        self.assertNotIn("Location", headers)
        self.assertEqual(self.calls, [])

    def test_mount_order_does_not_change_the_identity(self):
        a = {"Type": "bind", "Source": "/srv/a", "Destination": "/vault"}
        b = {"Type": "volume", "Name": "notes-config", "Destination": "/config"}
        self.docker.containers = [container(ID_A, "obsidian-notes", {
            "27180/tcp": [("0.0.0.0", 27180)], "3001/tcp": [("0.0.0.0", 3001)]}, mounts=[a, b])]
        code, _, _ = self._takeover([b, a])                             # recreated, order shuffled
        self.assertEqual(code, 302)

    def test_another_named_volume_is_another_vault(self):
        v = {"Type": "volume", "Name": "notes-data", "Destination": "/vault"}
        self.docker.containers = [container(ID_A, "obsidian-notes", {
            "27180/tcp": [("0.0.0.0", 27180)], "3001/tcp": [("0.0.0.0", 3001)]}, mounts=[v])]
        self.assertEqual(self._takeover([dict(v, Name="eve-data")])[0], 409)

    def test_another_volume_subpath_is_another_vault(self):
        # Real `docker inspect` shape: the resolved mount has no subpath, the spec in
        # HostConfig.Mounts carries it (Compose long syntax `volume: {subpath: ...}`).
        def vault_on(sub):
            c = container(ID_A, "obsidian-notes", {"27180/tcp": [("0.0.0.0", 27180)],
                                                   "3001/tcp": [("0.0.0.0", 3001)]},
                          mounts=[{"Type": "volume", "Name": "vaults", "Destination": "/vault"}])
            c["HostConfig"] = {"Mounts": [{"Type": "volume", "Source": "vaults", "Target": "/vault",
                                           "VolumeOptions": {"Subpath": sub}}]}
            return c
        self.docker.containers = [vault_on("alice")]
        _, path = self.mint("vault=notes&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
        self.docker.containers = [vault_on("bob")]
        code, headers, _ = self.get(path)
        self.assertEqual(code, 409)
        self.assertNotIn("Location", headers)
        self.docker.containers = [vault_on("alice")]                   # back: same identity
        self.assertEqual(self.get(path)[0], 302)

    def test_control_characters_in_mount_paths_still_count(self):
        conf = {"Type": "bind", "Source": "/srv/conf", "Destination": "/config"}
        def on(src):
            return container(ID_A, "obsidian-notes", {"27180/tcp": [("0.0.0.0", 27180)],
                                                      "3001/tcp": [("0.0.0.0", 3001)]},
                             mounts=[conf, {"Type": "bind", "Source": src, "Destination": "/vault"}])
        self.docker.containers = [on("/srv/alice\n")]
        _, path = self.mint("vault=notes&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
        self.docker.containers = [on("/srv/bob\n")]
        self.assertEqual(self.get(path)[0], 409)

    def test_unreadable_mount_makes_the_container_unidentifiable(self):
        self.docker.containers = [container(ID_A, "obs", {"27180/tcp": [("0.0.0.0", 27180)],
                                                          "3001/tcp": [("0.0.0.0", 3001)]},
                                            mounts=[{"Type": "bind", "Source": "/srv/conf", "Destination": "/config"},
                                                    {"Type": "bind", "Source": None, "Destination": "/vault"}])]
        code, _, body = self.view("vault=x&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
        self.assertEqual(code, 400)
        self.assertIn("no vault to identify", json.loads(body)["error"])

    def test_host_name_next_to_an_explicit_ip_publication_is_indeterminate(self):
        self.cfg["detect"]["_local"].add("vaults.example")
        self.docker.containers = [
            container(ID_A, "one", {"27180/tcp": [("0.0.0.0", 27180)], "3001/tcp": [("0.0.0.0", 3001)]}),
            container(ID_B, "two", {"27180/tcp": [("2001:db8::1", 27180)], "3001/tcp": [("0.0.0.0", 3002)]}),
        ]
        code, _, body = self.view("vault=x&note=a.md&rest=" + urllib.parse.quote("http://vaults.example:27180"))
        self.assertEqual(code, 400)
        self.assertIn("indeterminate", json.loads(body)["error"])

    def test_host_name_with_wildcard_publications_only_is_detected(self):
        self.cfg["detect"]["_local"].add("vaults.example")
        data, _ = self.mint("vault=x&note=a.md&rest=" + urllib.parse.quote("http://vaults.example:27180"))
        self.assertEqual(data["source"], "container obsidian-notes")

    def test_gui_on_an_explicit_ip_for_a_named_gui_host_is_indeterminate(self):
        # loopback hint → GUI host = the self_url host, a NAME (agent.test)
        self.docker.containers = [container(ID_A, "obs", {"27180/tcp": [("127.0.0.1", 27180)],
                                                          "3001/tcp": [("192.0.2.1", 3001)]})]
        code, _, body = self.view("vault=x&note=a.md&rest=" + urllib.parse.quote("http://127.0.0.1:27180"))
        self.assertEqual(code, 400)
        self.assertIn("indeterminate", json.loads(body)["error"])

    def test_token_appearing_after_the_check_does_not_authorize_detection(self):
        real = va.read_secret_file
        seen = {"n": 0}

        def racy(cfg, key):
            if key == "token_file":
                seen["n"] += 1
                if seen["n"] == 1:
                    return ("off", None)          # absent at the /view check…
            return real(cfg, key)                 # …present afterwards
        va.read_secret_file = racy
        try:
            code, _, _ = self.get("/view?vault=x&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
        finally:
            va.read_secret_file = real
        self.assertEqual(code, 400)

    def test_failed_navigation_of_a_detected_vault_offers_no_gui_link(self):
        _, path = self.mint("vault=notes&note=fail.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
        code, _, body = self.get(path)
        self.assertEqual(code, 502)
        self.assertNotIn(b"href", body)

    def test_gui_port_answered_by_another_container_is_ambiguous(self):
        # REST of A on loopback; A's GUI on 0.0.0.0:3001, B's GUI on [::]:3001; the GUI host is
        # the self_url NAME: the browser could reach either one.
        self.docker.containers = [
            container(ID_A, "a", {"27180/tcp": [("127.0.0.1", 27180)], "3001/tcp": [("0.0.0.0", 3001)]}),
            container(ID_B, "b", {"3001/tcp": [("::", 3001)]}),
        ]
        code, _, body = self.view("vault=x&note=a.md&rest=" + urllib.parse.quote("http://127.0.0.1:27180"))
        self.assertEqual(code, 400)
        self.assertIn("also published by b", json.loads(body)["error"])

    def test_gui_port_on_another_containers_explicit_ip_is_indeterminate(self):
        # A's GUI on 0.0.0.0:3001, B's on [2001:db8::2]:3001; the GUI host is a NAME that may
        # resolve to B's address: cannot be ruled out.
        self.docker.containers = [
            container(ID_A, "a", {"27180/tcp": [("127.0.0.1", 27180)], "3001/tcp": [("0.0.0.0", 3001)]}),
            container(ID_B, "b", {"3001/tcp": [("2001:db8::2", 3001)]}),
        ]
        code, _, body = self.view("vault=x&note=a.md&rest=" + urllib.parse.quote("http://127.0.0.1:27180"))
        self.assertEqual(code, 400)
        self.assertIn("indeterminate", json.loads(body)["error"])

    def test_each_docker_call_gets_the_remaining_budget(self):
        self.view("vault=x&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
        self.assertEqual(len(self.docker.timeouts), 2)
        self.assertTrue(all(t is not None and 0 < t <= va.DOCKER_CALL_S for t in self.docker.timeouts))

    def test_concurrent_views_never_wait_past_the_budget(self):
        old = va.DETECT_BUDGET_S
        va.DETECT_BUDGET_S = 0.6
        self.docker.delay = 0.4                   # one probe = 0.8 s > the budget
        results = []

        def one():
            t0 = time.monotonic()
            code = self.view("vault=x&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))[0]
            results.append((code, time.monotonic() - t0))
        try:
            ts = [threading.Thread(target=one) for _ in range(3)]
            for t in ts:
                t.start()
            for t in ts:
                t.join()
        finally:
            va.DETECT_BUDGET_S = old
        self.assertEqual(len(results), 3)
        self.assertTrue(all(elapsed < 1.5 for _, elapsed in results), results)
        self.assertTrue(all(code in (200, 503) for code, _ in results), results)
        self.assertIn(503, [code for code, _ in results])      # the budget did cut in

    def test_a_held_inventory_lock_is_not_waited_on_past_the_deadline(self):
        inv = va.DockerInventory(self.cfg["detect"], self.docker)
        inv.lock.acquire()                        # another request is probing a slow Docker
        releaser = threading.Timer(2.0, inv.lock.release)
        releaser.start()
        try:
            t0 = time.monotonic()
            with self.assertRaises(va.DetectError) as ctx:
                inv.containers(deadline=time.monotonic() + 0.3)
            self.assertEqual(ctx.exception.code, 503)
            self.assertLess(time.monotonic() - t0, 1.0)
        finally:
            releaser.join()

    def test_a_request_out_of_budget_does_not_poison_the_cache(self):
        detect = dict(self.cfg["detect"], cache_s=10)
        inv = va.DockerInventory(detect, self.docker)
        inv.lock.acquire()                        # another request holds the lock…
        releaser = threading.Timer(0.3, inv.lock.release)
        releaser.start()
        try:
            with self.assertRaises(va.BudgetExhausted):
                inv.containers(deadline=time.monotonic() + 0.35)   # …acquired too late
        finally:
            releaser.join()
        self.assertEqual(self.docker.cmds, [])
        self.assertTrue(inv.containers())         # a full-budget request still asks Docker
        self.assertEqual(len(self.docker.cmds), 2)

    def test_a_docker_call_cut_short_by_the_deadline_is_not_cached(self):
        detect = dict(self.cfg["detect"], cache_s=10)
        state = {"slow": True}

        def runner(cmd, timeout=None):
            if state["slow"] and timeout < va.DOCKER_CALL_S:
                raise va.subprocess.TimeoutExpired(cmd, timeout)
            return self.docker(cmd, timeout)
        inv = va.DockerInventory(detect, runner)
        with self.assertRaises(va.BudgetExhausted):
            inv.containers(deadline=time.monotonic() + 1.0)
        state["slow"] = False
        self.assertTrue(inv.containers())

    def test_budget_exhaustion_keeps_a_cached_success_and_a_cached_failure(self):
        detect = dict(self.cfg["detect"], cache_s=10)
        inv = va.DockerInventory(detect, self.docker)
        inv.containers()                                     # cached success
        before = (inv.data, inv.error, inv.at)
        with self.assertRaises(va.BudgetExhausted):
            inv.containers(fresh=True, deadline=time.monotonic())
        self.assertEqual((inv.data, inv.error, inv.at), before)
        self.docker.raises = OSError("docker gone")
        with self.assertRaises(va.DetectError):
            inv.containers(fresh=True)                       # cached failure
        before = (inv.data, inv.error, inv.at)
        self.assertIsNotNone(inv.error)
        with self.assertRaises(va.BudgetExhausted):
            inv.containers(fresh=True, deadline=time.monotonic())
        self.assertEqual((inv.data, inv.error, inv.at), before)

    def test_a_full_length_docker_timeout_is_a_cached_docker_failure(self):
        detect = dict(self.cfg["detect"], cache_s=10)
        calls = []

        def runner(cmd, timeout=None):
            calls.append(timeout)
            raise va.subprocess.TimeoutExpired(cmd, timeout)
        inv = va.DockerInventory(detect, runner)
        with self.assertRaises(va.DetectError) as ctx:
            inv.containers()                                 # full budget: 2.5 s allotted
        self.assertNotIsInstance(ctx.exception, va.BudgetExhausted)
        self.assertEqual(calls, [va.DOCKER_CALL_S])
        self.assertIs(inv.error, ctx.exception)              # a real Docker failure is cached…
        with self.assertRaises(va.DetectError):
            inv.containers()
        self.assertEqual(len(calls), 1)                      # …and answered without Docker

    def test_detected_vault_without_note_gets_a_signed_checked_link(self):
        data, path = self.mint("vault=notes&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
        self.assertEqual(data["kind"], "direct-go")                 # never the raw GUI URL
        q = urllib.parse.parse_qs(urllib.parse.urlparse(data["url"]).query)
        self.assertIn("k", q)
        code, headers, _ = self.get(path)
        self.assertEqual((code, headers.get("Location")), (302, "https://192.0.2.1:3001/"))
        self.assertEqual(self.calls, [])                            # nothing to navigate
        self.docker.containers = [container("e" * 64, "obsidian-eve", {
            "27180/tcp": [("0.0.0.0", 27180)], "3001/tcp": [("0.0.0.0", 3001)]})]
        code, headers, _ = self.get(path)
        self.assertEqual(code, 409)
        self.assertNotIn("Location", headers)

    def test_container_replaced_during_navigation_is_refused_before_the_redirect(self):
        _, path = self.mint("vault=notes&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))

        def swap():
            self.docker.containers = [container("e" * 64, "obsidian-eve", {
                "27180/tcp": [("0.0.0.0", 27180)], "3001/tcp": [("0.0.0.0", 3001)]})]
        self.on_nav = swap
        code, headers, _ = self.get(path)
        self.assertEqual(code, 409)
        self.assertNotIn("Location", headers)

    def test_legacy_link_without_note_is_still_refused(self):
        self.assertEqual(self.get("/go?v=alice&n=&s=x")[0], 400)

    def test_identity_fields_sent_to_view_are_ignored(self):
        data, _ = self.mint("vault=notes&note=a.md&container=evil&vault_id=" + "0" * 16
                            + "&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
        q = urllib.parse.parse_qs(urllib.parse.urlparse(data["url"]).query)
        self.assertEqual(q["c"], ["obsidian-notes"])
        self.assertNotEqual(q["k"], ["0" * 16])

    def test_container_mounting_nothing_is_not_a_vault(self):
        self.docker.containers = [container(ID_A, "obs", {"27180/tcp": [("0.0.0.0", 27180)],
                                                          "3001/tcp": [("0.0.0.0", 3001)]}, mounts=[])]
        code, _, body = self.view("vault=x&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
        self.assertEqual(code, 400)
        self.assertIn("mounts nothing", json.loads(body)["error"])

    def test_vault_identity_is_signed(self):
        data, path = self.mint("vault=notes&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
        k = urllib.parse.parse_qs(urllib.parse.urlparse(data["url"]).query)["k"][0]
        self.assertRegex(k, r"^[0-9a-f]{16}$")
        self.assertEqual(self.get(path.replace("k=" + k, "k=" + "0" * 16))[0], 403)

    def test_recreated_container_keeps_its_name_and_is_found_again(self):
        _, path = self.mint("vault=notes&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
        self.docker.containers = [dict(VAULTS_HOST[0], Id="f" * 64)]   # same name, new ID
        code, headers, _ = self.get(path)
        self.assertEqual(code, 302)
        self.assertEqual(self.nav_cfgs[-1]["container"], "f" * 64)

    def test_container_identity_is_signed_and_never_taken_from_view(self):
        data, path = self.mint("vault=notes&note=a.md&container=obsidian-bob&rest="
                               + urllib.parse.quote("http://192.0.2.1:27180"))
        q = urllib.parse.parse_qs(urllib.parse.urlparse(data["url"]).query)
        self.assertEqual(q["c"], ["obsidian-notes"])                  # from Docker, not the request
        self.assertEqual(self.get(path.replace("c=obsidian-notes", "c=obsidian-bob"))[0], 403)

    def test_hint_link_without_container_identity_is_refused(self):
        link = va.build_go_link(self.cfg, "notes", "a.md", "", {"rest": "http://192.0.2.1:27180"})
        code, _, _ = self.get(link.split("agent.test:27200", 1)[-1])
        self.assertEqual(code, 409)
        self.assertEqual(self.calls, [])

    # --- a click sees Docker as it is now, whatever the cache
    def test_go_bypasses_the_inventory_cache(self):
        self.cfg["detect"]["cache_s"] = 60
        _, path = self.mint("vault=notes&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
        self.docker.containers = [container("e" * 64, "obsidian-eve", {
            "27180/tcp": [("0.0.0.0", 27180)], "3001/tcp": [("0.0.0.0", 3001)]})]
        self.assertEqual(self.get(path)[0], 409)       # cached inventory would still say notes
        self.docker.containers = [dict(VAULTS_HOST[0], Id="f" * 64)]
        self.assertEqual(self.get(path)[0], 302)
        self.assertEqual(self.nav_cfgs[-1]["container"], "f" * 64)

    def test_docker_down_at_click_is_503(self):
        _, path = self.mint("vault=notes&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
        self.docker.raises = FileNotFoundError("docker")
        self.assertEqual(self.get(path)[0], 503)

    # --- address families
    def test_ipv4_only_publication_does_not_answer_an_ipv6_hint(self):
        self.docker.containers = [container(ID_A, "obs", {"27180/tcp": [("0.0.0.0", 27180)],
                                                          "3001/tcp": [("0.0.0.0", 3001), ("::", 3001)]})]
        code, _, _ = self.view("vault=x&note=a.md&rest=" + urllib.parse.quote("http://[::1]:27180"))
        self.assertEqual(code, 400)

    def test_ipv6_only_publication_does_not_answer_an_ipv4_hint(self):
        self.docker.containers = [container(ID_A, "obs", {"27180/tcp": [("::", 27180)],
                                                          "3001/tcp": [("0.0.0.0", 3001), ("::", 3001)]})]
        code, _, _ = self.view("vault=x&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
        self.assertEqual(code, 400)

    def test_ipv6_hint_matches_an_ipv6_publication(self):
        data, _ = self.mint("vault=x&note=a.md&rest=" + urllib.parse.quote("http://[::1]:27180"))
        self.assertEqual(data["source"], "container obsidian-notes")    # published on :: too

    def test_docker_inventory_is_cached(self):
        self.cfg["detect"]["cache_s"] = 60
        for _ in range(3):
            self.mint("vault=notes&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
        self.assertEqual([c[1] for c in self.docker.cmds], ["ps", "inspect"])


class TestDetectDesktop(DetectBase):
    def setUp(self):
        super().setUp()
        _serve_with_docker(self)

    def test_desktop_vault_redirects_to_obsidian_without_docker(self):
        data, path = self.mint("vault=carol&note=wiki/a.md&rest=" + urllib.parse.quote("http://192.0.2.10:27190")
                               + "&obsidian_name=" + urllib.parse.quote("Carol notes et co"))
        self.assertEqual(data["open_mode"], "obsidian-uri")
        code, headers, _ = self.get(path)
        self.assertEqual(code, 302)
        self.assertEqual(headers["Location"],
                         "obsidian://open?vault=Carol%20notes%20et%20co&file=wiki%2Fa.md")
        self.assertEqual(self.docker.cmds, [])
        self.assertEqual(self.calls, [])

    def test_obsidian_name_is_covered_by_the_signature(self):
        _, path = self.mint("vault=carol&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.10:27190")
                            + "&obsidian_name=Real")
        self.assertEqual(self.get(path.replace("o=Real", "o=Other"))[0], 403)

    def test_desktop_vault_without_obsidian_name_is_an_explicit_400(self):
        code, _, body = self.get("/view?vault=carol&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.10:27190"),
                                 {"X-View-Token": "tok-123"})
        self.assertEqual(code, 400)
        self.assertIn("obsidian_name", json.loads(body)["error"])

    def test_unlisted_remote_host_is_never_guessed(self):
        code, _, body = self.get("/view?vault=r&note=a.md&obsidian_name=X&rest="
                                 + urllib.parse.quote("http://192.0.2.11:27190"), {"X-View-Token": "tok-123"})
        self.assertEqual(code, 400)
        self.assertIn("cannot classify", json.loads(body)["error"])

    def test_desktop_link_without_note_is_signed_and_rechecked(self):
        data, path = self.mint("vault=carol&rest=" + urllib.parse.quote("http://192.0.2.10:27190")
                               + "&obsidian_name=V")
        self.assertEqual(data["kind"], "direct-go")               # never a raw obsidian:// URI
        code, headers, _ = self.get(path)
        self.assertEqual(code, 302)
        self.assertEqual(headers["Location"], "obsidian://open?vault=V")
        self.assertEqual(self.get(path.replace("o=V", "o=W"))[0], 403)

    def test_configured_desktop_vault_without_note_keeps_its_direct_uri(self):
        self.cfg["vaults"]["desk"] = {"open_mode": "obsidian-uri", "obsidian_vault": "D", "public_url": ""}
        code, _, body = self.get("/view?vault=desk", {"X-View-Token": "tok-123"})
        self.assertEqual((code, json.loads(body)["url"]), (200, "obsidian://open?vault=D"))

    def test_desktop_go_still_refuses_traversal(self):
        hints = {"rest": "http://192.0.2.10:27190", "obsidian_name": "V"}
        link = va.build_go_link(self.cfg, "router", "../x.md", "", hints)
        self.assertEqual(self.get(link.split("agent.test:27200", 1)[-1])[0], 400)

    def test_invalid_obsidian_name_is_refused(self):
        for bad in ("a\nb", " lead", "x" * 256):
            code, _, _ = self.get("/view?vault=r&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.10:1")
                                  + "&obsidian_name=" + urllib.parse.quote(bad), {"X-View-Token": "tok-123"})
            self.assertEqual(code, 400, repr(bad))


class TestDetectNeedsLocks(DetectBase):
    """Without a token AND a signing secret, detection is refused (links always signed)."""

    def setUp(self):
        super().setUp()
        os.remove(os.path.join(self.dir, "view-agent.token"))     # no token, no secret at all
        _serve_with_docker(self)

    def test_detection_refused_without_secrets(self):
        code, _, body = self.get("/view?vault=x&note=a.md&rest=" + urllib.parse.quote("http://192.0.2.1:27180"))
        self.assertEqual(code, 400)
        self.assertIn("requires", json.loads(body)["error"])
        self.assertEqual(self.docker.cmds, [])

    def test_unsigned_hint_link_is_refused_at_go(self):
        path = "/go?v=x&n=a.md&r=" + urllib.parse.quote("http://192.0.2.1:27180")
        self.assertEqual(self.get(path)[0], 403)
        self.assertEqual(self.docker.cmds, [])

    def test_configured_vault_keeps_working_unsigned(self):
        self.assertEqual(self.get("/go?v=alice&n=a.md")[0], 302)


class TestDetectPure(unittest.TestCase):
    def test_rest_hint_refusals(self):
        for bad in ("ftp://192.0.2.1:21", "http://u:p@192.0.2.1:27180", "http://192.0.2.1@evil:27180",
                    "http://192.0.2.1", "http://192.0.2.1:27180/x", "http://192.0.2.1:27180?a=1",
                    "http://192.0.2.1:27180#f", "http://192.0.2.1:99999", "http://bad_host:1",
                    "http://192.0.2.1:27180\\@x", "http://a b:1", "http://x:1\n", "", "192.0.2.1:27180",
                    "http://$(id):1", "http://-x:1", "http://[::1:80", "http://[::1]x:80",
                    "http://[fe80::1%25eth0]:27124"):
            with self.assertRaises(va.DetectError, msg=bad):
                va.parse_rest_hint(bad)

    def test_rest_hint_normalization(self):
        self.assertEqual(va.parse_rest_hint("HTTP://LocalHost:27180/"),
                         ("http://localhost:27180", "localhost", 27180, "http"))
        self.assertEqual(va.parse_rest_hint("http://[::ffff:192.0.2.1]:1")[1], "192.0.2.1")  # one spelling
        self.assertEqual(va.parse_rest_hint("https://[::1]:27124")[0], "https://[::1]:27124")

    def test_desktop_hosts_accept_cidr_and_names(self):
        nets = va._load_detect({"desktop_hosts": ["192.0.2.0/28", "pc.wg"]})["_desktop"]
        self.assertTrue(va._host_in("192.0.2.10", nets))
        self.assertFalse(va._host_in("192.0.2.17", nets))
        self.assertTrue(va._host_in("pc.wg", nets))
        self.assertFalse(va._host_in("::1", nets))

    def test_ipv4_mapped_desktop_host_matches_the_normalized_hint(self):
        nets = va._load_detect({"desktop_hosts": ["::ffff:10.0.0.5"]})["_desktop"]
        self.assertTrue(va._host_in(va.parse_rest_hint("http://10.0.0.5:1")[1], nets))
        with self.assertRaises(ValueError):
            va._load_detect({"desktop_hosts": ["::ffff:10.0.0.0/120"]})

    def test_detect_config_validation(self):
        for bad in ({"desktop_hosts": ["not a host!"]}, {"gui_url": "https://{host.__class__}:{port}/"},
                    {"gui_url": "https://x/"}, {"gui_url": "file:///{port}"}, {"bogus": 1},
                    {"gui_container_ports": []}, {"gui_container_ports": [True]}, {"enabled": "yes"},
                    {"cache_s": -1}, {"local_hosts": "192.0.2.1"},
                    # the redirect must land on the host:port the identity check covered
                    {"gui_url": "https://192.0.2.2:{port}/"}, {"gui_url": "https://proxy.test/{host}/{port}"},
                    {"gui_url": "https://{host}:{port}@192.0.2.2/"}, {"gui_url": "https://{host}:{port}/?x={host}"}):
            with self.assertRaises(ValueError, msg=repr(bad)):
                va._load_detect(bad)
        for good in ("https://{host}:{port}/", "http://{host}:{port}", "https://{host}:{port}/vnc/index.html"):
            self.assertEqual(va._load_detect({"gui_url": good})["gui_url"], good)

    def test_a_host_cannot_be_both_local_and_desktop(self):
        d = tempfile.mkdtemp()
        try:
            p = os.path.join(d, "config.json")
            with open(p, "w") as f:
                json.dump({"bind": "192.0.2.1", "vaults": {}, "detect": {"desktop_hosts": ["192.0.2.0/24"]}}, f)
            with self.assertRaises(ValueError):
                va.load_config(p)
            with open(p, "w") as f:
                json.dump({"vaults": {"a": {"public_url": "u", "container": "c", "open_port": 1,
                                            "open_scheme": "ftp"}}}, f)
            with self.assertRaises(ValueError):
                va.load_config(p)
            with open(p, "w") as f:  # detection lets "vaults" be empty; disabling it does not
                json.dump({"vaults": {}, "detect": {"enabled": False}}, f)
            with self.assertRaises(ValueError):
                va.load_config(p)
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_detected_container_navigates_by_id_with_fixed_argv(self):
        seen = {}

        class R:
            returncode, stdout, stderr = 0, "200", ""

        def runner(cmd):
            seen["cmd"] = cmd
            return R()
        ok, _ = va.navigate({"open_mode": "docker-exec", "container": ID_A, "open_port": 27180,
                             "docker_path": "docker", "curl_path": "curl"}, "wiki/a b.md", "", runner)
        self.assertTrue(ok)
        self.assertEqual(seen["cmd"], ["docker", "exec", ID_A, "curl", "-sS", "-o", "/dev/null", "-w",
                                       "%{http_code}", "--max-time", "4",
                                       "http://127.0.0.1:27180/open/wiki%2Fa%20b.md"])

    def test_navigate_https_adds_k_only_for_https(self):
        seen = []

        class R:
            returncode, stdout, stderr = 0, "200", ""
        base = {"open_mode": "docker-exec", "container": ID_A, "open_port": 27124}
        va._open_prefix_cache.clear()
        va.navigate(dict(base, open_scheme="https"), "a.md", "", lambda c: seen.append(c) or R())
        va.navigate(base, "a.md", "", lambda c: seen.append(c) or R())
        # Each navigation first asks the bridge's /ping for its open prefix, same transport.
        pings = [c for c in seen if c[-1].endswith("/ping")]
        opens = [c for c in seen if not c[-1].endswith("/ping")]
        self.assertIn("-k", pings[0])
        self.assertNotIn("-k", pings[1])
        self.assertIn("-k", opens[0])
        self.assertEqual(opens[0][-1], "https://127.0.0.1:27124/open/a.md")
        self.assertNotIn("-k", opens[1])
        self.assertEqual(opens[1][-1], "http://127.0.0.1:27124/open/a.md")

    def test_line_breaks_never_reach_a_signature(self):
        with self.assertRaises(ValueError):
            va.build_go_link({"link_ttl_s": 0, "self_url": "http://a", "_dir": "/nonexistent",
                              "link_secret_file": "x", "token_file": "y"}, "v", "a\nb")
        for q in ({"v": ["v"], "n": ["a\nb"], "s": ["x"]}, {"v": ["v\r"], "n": ["a"], "s": ["x"]},
                  {"v": ["v"], "n": ["a"], "h": ["b\n"], "s": ["x"]}):
            ok, code, *_ = va.verify_go({"link_ttl_s": 0, "_dir": "/nonexistent", "vaults": {},
                                         "link_secret_file": "x", "token_file": "y"}, q)
            self.assertEqual((ok, code), (False, 400))

    def test_legacy_links_keep_their_signature(self):
        # Links already in chat histories must stay valid: the legacy format is unchanged.
        self.assertEqual(va._canonical("v", "wiki/a.md", "Intro", 0), "v\nwiki/a.md\nIntro\n0")

    def test_canonical_v2_is_unambiguous_and_separate_from_legacy(self):
        h = {"rest": "http://192.0.2.1:27180"}
        # The legacy newline join collides here: note "a\nb" vs note "a" + anchor "b\n".
        self.assertEqual(va._canonical("v", "a\nb", "", 0), va._canonical("v", "a", "b\n", 0))
        self.assertNotEqual(va._canonical("v", "a\nb", "", 0, h), va._canonical("v", "a", "b\n", 0, h))
        self.assertNotEqual(va._canonical("v", "a", "", 0, h), va._canonical("v", "a", "", 0))


class TestPure(unittest.TestCase):
    def test_refused_paths(self):
        self.assertIsNone(va._safe_note("../x.md"))
        self.assertIsNone(va._safe_note("/etc/passwd"))
        self.assertEqual(va._safe_note("wiki/x.md"), "wiki/x.md")

    def test_open_path_encoding(self):
        self.assertEqual(va.open_path("wiki/a b.md", "Intro §1"),
                         "/open/wiki%2Fa%20b.md?h=Intro%20%C2%A71")

    def test_navigate_docker_exec_builds_the_command(self):
        seen = {}

        class R:
            returncode, stdout, stderr = 0, "200", ""

        def runner(cmd):
            seen["cmd"] = cmd
            return R()
        ok, _ = va.navigate({"open_mode": "docker-exec", "container": "obs", "open_port": 27180},
                            "wiki/a.md", "", runner)
        self.assertTrue(ok)
        self.assertEqual(seen["cmd"][:3], ["docker", "exec", "obs"])
        self.assertEqual(seen["cmd"][-1], "http://127.0.0.1:27180/open/wiki%2Fa.md")

    def test_config_rejects_docker_exec_without_container(self):
        d = tempfile.mkdtemp()
        try:
            p = os.path.join(d, "config.json")
            with open(p, "w") as f:
                json.dump({"vaults": {"alice": {"public_url": "https://gui.test/"}}}, f)
            with self.assertRaises(ValueError):
                va.load_config(p)
        finally:
            shutil.rmtree(d, ignore_errors=True)


class TestOpenPrefix(unittest.TestCase):
    """The click-to-open prefix the bridge announces in /ping (bridge 0.10.0).

    Local REST API 5.4.0 reserves `/open/`: a GET there is its own authenticated route and
    answers 401 (errorCode 40101). Bridge 0.10.0 serves `/mcp-router-bridge/open/` and
    says so in its pong; an older bridge says nothing and keeps `/open/`."""

    NEW = "/mcp-router-bridge/open/"

    def setUp(self):
        va._open_prefix_cache.clear()

    def docker_runner(self, pong_stdout, open_code="200", ping_rc=0):
        calls = []

        class R:
            def __init__(self, rc, out):
                self.returncode, self.stdout, self.stderr = rc, out, ""

        def runner(cmd):
            calls.append(cmd)
            if cmd[-1].endswith("/ping"):
                return R(ping_rc, pong_stdout)
            return R(0, open_code)
        return runner, calls

    def test_prefix_from_pong(self):
        self.assertEqual(va.prefix_from_pong('{"pong":true,"openPrefix":"/mcp-router-bridge/open/"}'), self.NEW)
        self.assertIsNone(va.prefix_from_pong('{"pong":true}'))                              # bridge < 0.10.0
        self.assertIsNone(va.prefix_from_pong('{"openPrefix":"/mcp-router-bridge/open/"}'))  # not a pong
        self.assertIsNone(va.prefix_from_pong("not json"))
        self.assertIsNone(va.prefix_from_pong(None))
        for bad in ["@evil.example/", "//evil.example/", "/a?b/", "/a#b/", "/../", "/.x/", "/a%2F/",
                    "/a b/", "open/", "/open", "", 42, None, "/" + "a" * 130 + "/", "/a/\n"]:
            self.assertIsNone(va.prefix_from_pong(json.dumps({"pong": True, "openPrefix": bad})), repr(bad))

    def test_docker_exec_asks_ping_then_opens_under_the_announced_prefix(self):
        runner, calls = self.docker_runner('{"pong":true,"openPrefix":"/mcp-router-bridge/open/"}')
        ok, detail = va.navigate({"open_mode": "docker-exec", "container": ID_A, "open_port": 27153,
                                  "docker_path": "docker", "curl_path": "curl"}, "wiki/a b.md", "Intro", runner)
        self.assertTrue(ok)
        self.assertIn(self.NEW, detail)
        # Fixed argument lists, the container addressed as given, nothing from the request.
        self.assertEqual(calls[0], ["docker", "exec", ID_A, "curl", "-sS", "--max-time", "3",
                                    "http://127.0.0.1:27153/ping"])
        self.assertEqual(calls[1][-1], "http://127.0.0.1:27153/mcp-router-bridge/open/wiki%2Fa%20b.md?h=Intro")

    def test_old_bridge_or_dead_ping_falls_back_to_open(self):
        for pong, rc in (('{"pong":true}', 0), ("", 7), ('{"pong":true,"openPrefix":"//evil.example/"}', 0)):
            va._open_prefix_cache.clear()
            runner, calls = self.docker_runner(pong, ping_rc=rc)
            ok, _ = va.navigate({"open_mode": "docker-exec", "container": ID_A, "open_port": 27180},
                                "a.md", "", runner)
            self.assertTrue(ok, repr(pong))
            self.assertEqual(calls[-1][-1], "http://127.0.0.1:27180/open/a.md", repr(pong))

    def test_prefix_is_cached_per_target(self):
        runner, calls = self.docker_runner('{"pong":true,"openPrefix":"/mcp-router-bridge/open/"}')
        cfg = {"open_mode": "docker-exec", "container": ID_A, "open_port": 27153}
        va.navigate(cfg, "a.md", "", runner)
        va.navigate(cfg, "b.md", "", runner)
        self.assertEqual(sum(1 for c in calls if c[-1].endswith("/ping")), 1)   # one ping, two opens
        va.navigate(dict(cfg, container=ID_B), "c.md", "", runner)               # another target asks
        self.assertEqual(sum(1 for c in calls if c[-1].endswith("/ping")), 2)

    def test_cache_expires(self):
        answers = iter(['{"pong":true}', '{"pong":true,"openPrefix":"/mcp-router-bridge/open/"}'])
        key = ("test", "expiry")
        ttl = va.OPEN_PREFIX_TTL_S
        self.assertEqual(va.resolve_open_prefix(key, lambda: next(answers), now=100.0), "/open/")
        self.assertEqual(va.resolve_open_prefix(key, lambda: next(answers), now=100.0 + ttl - 1), "/open/")
        self.assertEqual(va.resolve_open_prefix(key, lambda: next(answers), now=100.0 + ttl + 1), self.NEW)

    def test_open_path_never_takes_an_invalid_prefix(self):
        self.assertEqual(va.open_path("a.md", "", "@evil.example/"), "/open/a.md")
        self.assertEqual(va.open_path("a.md", "", self.NEW), "/mcp-router-bridge/open/a.md")

    def test_http_mode_against_a_fake_bridge_on_local_rest_api_5_4(self):
        """A fake bridge 0.10.0 on Local REST API 5.4.0: /open/ answers 401, the plugin-id
        route answers 200 — over real HTTP."""
        from http.server import BaseHTTPRequestHandler
        seen = []

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                seen.append(self.path)
                if self.path == "/ping":
                    body, code = b'{"pong":true,"openPrefix":"/mcp-router-bridge/open/"}', 200
                elif self.path.startswith("/mcp-router-bridge/open/"):
                    body, code = b"<p>Opened in Obsidian.</p>", 200
                else:
                    body, code = b'{"errorCode":40101}', 401
                self.send_response(code)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            url = "http://127.0.0.1:%d" % srv.server_address[1]
            ok, detail = va.navigate({"open_mode": "http", "open_url": url + "/"}, "wiki/x.md", "", None)
            self.assertTrue(ok, detail)
            self.assertEqual(seen, ["/ping", "/mcp-router-bridge/open/wiki%2Fx.md"])
        finally:
            srv.shutdown()
            srv.server_close()


class TestOpenPrefixReview(unittest.TestCase):
    """Codex review, 2026-10-11: discovery must not erase or overwrite a known prefix,
    must not follow redirects, and must share one time budget with the open call."""

    NEW = "/mcp-router-bridge/open/"
    PONG_NEW = '{"pong":true,"openPrefix":"/mcp-router-bridge/open/"}'

    def setUp(self):
        va._open_prefix_cache.clear()

    def test_failed_discovery_keeps_the_known_prefix(self):
        key = ("t", "keep")
        ttl = va.OPEN_PREFIX_TTL_S
        self.assertEqual(va.resolve_open_prefix(key, lambda: self.PONG_NEW, now=100.0), self.NEW)

        def boom():
            raise RuntimeError("timeout")
        self.assertEqual(va.resolve_open_prefix(key, boom, now=100.0 + ttl + 1), self.NEW)
        self.assertEqual(va.resolve_open_prefix(key, lambda: "garbage", now=100.0 + 2 * ttl + 2), self.NEW)
        # A bridge that actually answers without a prefix (downgraded) does replace it.
        self.assertEqual(va.resolve_open_prefix(key, lambda: '{"pong":true}', now=100.0 + 3 * ttl + 3), "/open/")

    def test_an_older_failed_discovery_never_overwrites_a_newer_success(self):
        key = ("t", "race")

        def slow_failure():
            # While this click's discovery is stuck, another click discovers the prefix.
            self.assertEqual(va.resolve_open_prefix(key, lambda: self.PONG_NEW, now=101.0), self.NEW)
            raise RuntimeError("timeout")
        self.assertEqual(va.resolve_open_prefix(key, slow_failure, now=100.0), self.NEW)
        self.assertEqual(va._open_prefix_cache[key][0], self.NEW)

    def test_ping_redirect_is_never_followed(self):
        from http.server import BaseHTTPRequestHandler
        elsewhere_hits = []

        class Elsewhere(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                elsewhere_hits.append(self.path)
                body = self.server_pong
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        Elsewhere.server_pong = self.PONG_NEW.encode()
        other = ThreadingHTTPServer(("127.0.0.1", 0), Elsewhere)
        threading.Thread(target=other.serve_forever, daemon=True).start()
        other_url = "http://127.0.0.1:%d" % other.server_address[1]
        opened = []

        class Redirecting(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                if self.path == "/ping":
                    self.send_response(302)
                    self.send_header("Location", other_url + "/ping")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                opened.append(self.path)
                self.send_response(200)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"ok")
        srv = ThreadingHTTPServer(("127.0.0.1", 0), Redirecting)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            ok, _ = va.navigate({"open_mode": "http", "open_url": "http://127.0.0.1:%d" % srv.server_address[1]},
                                "a.md", "", None)
            self.assertTrue(ok)
            self.assertEqual(elsewhere_hits, [])                 # the redirect target was never contacted
            self.assertEqual(opened, ["/open/a.md"])             # no announced prefix taken from it
        finally:
            for x in (srv, other):
                x.shutdown()
                x.server_close()

    def test_discovery_and_open_share_one_budget(self):
        from unittest import mock
        clock = [1000.0]
        timeouts = []

        def fake_run(cmd, capture_output=True, text=True, timeout=None):
            timeouts.append(timeout)
            if cmd[-1].endswith("/ping"):
                clock[0] += timeout                              # the ping eats its whole slice
                raise va.subprocess.TimeoutExpired(cmd, timeout)

            class R:
                returncode, stdout, stderr = 0, "200", ""
            return R()
        with mock.patch.object(va.subprocess, "run", side_effect=fake_run), \
                mock.patch.object(va.time, "monotonic", side_effect=lambda: clock[0]):
            ok, _ = va.navigate({"open_mode": "docker-exec", "container": ID_A, "open_port": 27153}, "a.md", "")
        self.assertTrue(ok)
        self.assertEqual(timeouts[0], va.PING_BUDGET_S)
        self.assertLessEqual(timeouts[1], va.NAVIGATE_BUDGET_S - va.PING_BUDGET_S)   # what is left, not a fresh 8 s
        self.assertLessEqual(sum(timeouts), va.NAVIGATE_BUDGET_S)


if __name__ == "__main__":
    unittest.main()
