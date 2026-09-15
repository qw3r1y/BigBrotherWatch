#!/usr/bin/env python3
"""
OpSec Dashboard — local web server.

Stdlib-only HTTP server bound to 127.0.0.1. Serves the dashboard UI and a
small JSON/SSE API that shells out to core/opsec_core.sh for every actual
install/configure/scan/panic action, so behaviour matches the CLI exactly.

Security notes:
  * Binds to 127.0.0.1 only — never exposed on the network.
  * A random session token is minted at startup and handed to the browser
    as an HttpOnly cookie on first load. Every /api/* request is checked
    against it, but you never see it or paste it anywhere — it just rides
    along automatically like any other cookie, scoped to this one server.
"""
import json
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB_DIR = os.path.join(ROOT, "web")
CORE_SH = os.path.join(ROOT, "core", "opsec_core.sh")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import registry  # noqa: E402

PORT = int(os.environ.get("OPSEC_PORT", "8765"))
TOKEN = secrets.token_hex(16)
COOKIE_NAME = "opsec_session"
COOKIE_RE = re.compile(r"(?:^|;\s*)" + COOKIE_NAME + r"=([0-9a-f]+)")

STATIC_FILES = {
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "application/javascript; charset=utf-8"),
}


# The one action/install/scan process currently streaming to a console, if
# any, so a separate "send input" request can find it and write to its
# stdin. This dashboard is single-operator/single-session by design (one
# person, one box), so a single slot is enough; a new run simply replaces
# whatever was there before it.
_active_proc = None
_active_proc_lock = threading.Lock()

# Rolling network/CPU counters for /api/status's rate fields, shared across
# every poller (the main dashboard tab, the widget popup, ...). A browser
# caps concurrent connections per origin at 6 over HTTP/1.1; the main tab
# alone already holds 5 open (one SSE stream each for Monitor and every log
# source), so this data rides the same short-lived /api/status poll every
# caller already makes instead of each needing its own permanent EventSource
# for it — that's what /api/stream/monitor is for, and opening a second one
# for the widget was enough to exhaust the connection cap and hang both.
_rate_lock = threading.Lock()
_prev_rx, _prev_tx = registry.read_net_bytes()
_prev_idle, _prev_total = registry.read_cpu_times()
_prev_rate_t = time.time()


def _current_rates():
    global _prev_rx, _prev_tx, _prev_idle, _prev_total, _prev_rate_t
    with _rate_lock:
        rx, tx = registry.read_net_bytes()
        idle, total = registry.read_cpu_times()
        now = time.time()
        dt = max(now - _prev_rate_t, 0.001)
        rx_rate = max(0.0, (rx - _prev_rx) / dt)
        tx_rate = max(0.0, (tx - _prev_tx) / dt)
        d_idle, d_total = idle - _prev_idle, total - _prev_total
        cpu_pct = round((1 - d_idle / d_total) * 100, 1) if d_total > 0 else 0.0
        _prev_rx, _prev_tx, _prev_idle, _prev_total, _prev_rate_t = rx, tx, idle, total, now
    return {"rx": rx_rate, "tx": tx_rate, "cpu": cpu_pct,
            "mem": registry.read_mem_percent(), "disk": registry.read_disk_percent()}


def run_core(function_name, args=None, cwd=ROOT, use_sudo=True):
    """Yield stdout/stderr lines from `bash -c 'source core/opsec_core.sh; fn args'`.

    The child is fully detached from whatever terminal launched this server
    (start_new_session=True -> setsid) and given its own stdin pipe. Some
    package post-install scripts (locale/tzdata/keyboard-configuration and
    similar debconf prompts) try to open /dev/tty directly rather than using
    stdout/stdin — without this, such a prompt silently appears on the
    terminal that ran `opsec.sh`, invisible to and unanswerable from the web
    UI, and the install just hangs forever. Detaching removes that terminal
    entirely, and core/opsec_core.sh also forces apt to run non-interactive.
    If something still reads plain stdin, it now reads OUR pipe, which the
    console's input box can write to (see _send_console_input).

    `use_sudo` controls whether core/opsec_core.sh prefixes its privileged
    commands with `sudo` (see the OPSEC_USE_SUDO check near the top of that
    file) — off by default in the web UI only where the user's "Use sudo"
    toggle is switched off, e.g. on a minimal box where sudo isn't installed.
    The server itself already requires root to start at all, so this rarely
    changes actual behavior; it's an escape hatch, not the main privilege gate.
    """
    global _active_proc
    args = args or []
    quoted = " ".join(["'" + a.replace("'", "'\\''") + "'" for a in args])
    cmd = f"source {CORE_SH!r}; {function_name} {quoted}"
    env = dict(os.environ)
    env["OPSEC_USE_SUDO"] = "1" if use_sudo else "0"
    proc = subprocess.Popen(
        ["bash", "-c", cmd],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1, cwd=cwd, start_new_session=True, env=env,
    )
    with _active_proc_lock:
        _active_proc = proc
    try:
        for line in proc.stdout:
            yield line.rstrip("\n")
    finally:
        proc.wait()
        with _active_proc_lock:
            if _active_proc is proc:
                _active_proc = None
        yield f"__EXIT__{proc.returncode}"


def security_score(tools):
    """`tools` is the already-computed {tool_id: status} map from _api_status,
    so scoring doesn't trigger a second, unbatched round of tool_status()
    calls (each of which could re-spawn a systemctl per service-backed tool)."""
    total = len(tools)
    active = sum(1 for s in tools.values() if s in ("active", "installed"))
    return round((active / total) * 100) if total else 0


def system_info():
    pkg = registry.detect_pkg_manager()
    try:
        hostname = socket.gethostname()
    except Exception:
        hostname = "unknown"
    distro = "unknown"
    try:
        with open("/etc/os-release") as f:
            for line in f:
                if line.startswith("PRETTY_NAME="):
                    distro = line.split("=", 1)[1].strip().strip('"')
                    break
    except Exception:
        pass
    panic = os.path.exists("/run/opsec-panic-active")
    return {"hostname": hostname, "distro": distro, "pkg_manager": pkg, "panic_active": panic}


class Handler(BaseHTTPRequestHandler):
    server_version = "OpSecDashboard/1.0"
    # BaseHTTPRequestHandler defaults to HTTP/1.0 (a new TCP connection per
    # request) unless told otherwise. The dashboard polls /api/status every
    # 6s for as long as it's open, on top of autostart checks and whatever
    # else — HTTP/1.1 lets those reuse one connection instead of paying a
    # fresh TCP handshake every time. Every response here already sends
    # Content-Length (required for keep-alive to work), including the SSE
    # streams, which just hold the one connection open until they're done.
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[server] " + (fmt % args) + "\n")

    # ---- helpers ---------------------------------------------------
    def _authed(self):
        m = COOKIE_RE.search(self.headers.get("Cookie", ""))
        return bool(m) and secrets.compare_digest(m.group(1), TOKEN)

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_text(self, text, status=200, ctype="text/plain; charset=utf-8"):
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _sse_headers(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

    def _sse_send(self, data):
        try:
            self.wfile.write(f"data: {data}\n\n".encode("utf-8"))
            self.wfile.flush()
            return True
        except (BrokenPipeError, ConnectionResetError):
            return False

    # ---- routing -----------------------------------------------------
    def do_GET(self):
        parsed = urlparse(self.path)
        path, qs = parsed.path, parse_qs(parsed.query)

        if path == "/":
            return self._serve_index()
        if path == "/widget":
            return self._serve_widget()
        if path in STATIC_FILES:
            return self._serve_static(path)

        if not self._authed():
            return self._send_json({"error": "unauthorized"}, 401)

        if path == "/api/status":
            return self._api_status()
        if path == "/api/interfaces":
            return self._send_json({"interfaces": list(run_core_sync("list_interfaces"))})
        if path == "/api/autostart":
            status = run_core_sync("autostart_status")
            enabled = bool(status) and status[0].strip() == "enabled"
            return self._send_json({"enabled": enabled})
        if path == "/api/stream/install":
            return self._stream_install(qs)
        if path == "/api/stream/uninstall":
            return self._stream_uninstall(qs)
        if path == "/api/stream/action":
            return self._stream_action(qs)
        if path == "/api/stream/scan":
            return self._stream_scan(qs)
        if path == "/api/stream/logs":
            return self._stream_logs(qs)
        if path == "/api/stream/monitor":
            return self._stream_monitor()
        self._send_text("not found", 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            payload = {}

        if not self._authed():
            return self._send_json({"error": "unauthorized"}, 401)

        if path == "/api/panic":
            enable = bool(payload.get("enable"))
            fn = "panic_on" if enable else "panic_off"
            lines = list(run_core_sync(fn))
            return self._send_json({"ok": True, "output": lines, "panic_active": enable})

        if path == "/api/autostart":
            enable = bool(payload.get("enable"))
            fn = "enable_autostart" if enable else "disable_autostart"
            lines = list(run_core_sync(fn))
            status = run_core_sync("autostart_status")
            enabled = bool(status) and status[0].strip() == "enabled"
            return self._send_json({"ok": True, "output": lines, "enabled": enabled})

        if path == "/api/console/input":
            return self._send_console_input(str(payload.get("text", "")))

        if path == "/api/console/cancel":
            return self._cancel_console()

        self._send_json({"error": "not found"}, 404)

    def _send_console_input(self, text):
        """Write one line to the stdin of whatever install/action/scan is
        currently streaming, so the console's input box can answer a prompt
        that still slips through despite the noninteractive apt flags."""
        with _active_proc_lock:
            proc = _active_proc
        if proc is None or proc.poll() is not None or proc.stdin is None:
            return self._send_json({"ok": False, "error": "Nothing is currently running."}, 409)
        try:
            proc.stdin.write(text + "\n")
            proc.stdin.flush()
        except (BrokenPipeError, OSError) as e:
            return self._send_json({"ok": False, "error": str(e)}, 409)
        return self._send_json({"ok": True})

    def _cancel_console(self):
        """Stop whatever install/action/scan is currently streaming. Sends
        SIGTERM to the whole process group (run_core launches it with
        start_new_session=True, so its pid IS the group id) rather than just
        the top-level bash, so apt/dpkg itself gets signaled too, not just
        the shell wrapping it.

        Interrupting a package manager mid-install can leave a package half
        configured; that's a real, known risk of cancelling, not hidden."""
        with _active_proc_lock:
            proc = _active_proc
        if proc is None or proc.poll() is not None:
            return self._send_json({"ok": False, "error": "Nothing is currently running."}, 409)
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError) as e:
            return self._send_json({"ok": False, "error": str(e)}, 500)
        return self._send_json({"ok": True})

    # ---- concrete handlers --------------------------------------------
    def _serve_index(self):
        try:
            with open(os.path.join(WEB_DIR, "index.html"), "r", encoding="utf-8") as f:
                html = f.read()
        except FileNotFoundError:
            return self._send_text("index.html missing", 500)
        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Set-Cookie", f"{COOKIE_NAME}={TOKEN}; Path=/; HttpOnly; SameSite=Strict")
        self.end_headers()
        self.wfile.write(body)

    def _serve_widget(self):
        """The pop-out desktop widget page — a small, chrome-less window the
        main dashboard opens via window.open(). Served the same way as "/"
        (cookie set here too, not just there) so it also works if someone
        opens this URL directly/bookmarked, without visiting "/" first."""
        try:
            with open(os.path.join(WEB_DIR, "widget.html"), "r", encoding="utf-8") as f:
                html = f.read()
        except FileNotFoundError:
            return self._send_text("widget.html missing", 500)
        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Set-Cookie", f"{COOKIE_NAME}={TOKEN}; Path=/; HttpOnly; SameSite=Strict")
        self.end_headers()
        self.wfile.write(body)

    def _serve_static(self, path):
        fname, ctype = STATIC_FILES[path]
        full = os.path.join(WEB_DIR, fname)
        if not os.path.isfile(full):
            return self._send_text("not found", 404)
        with open(full, "r", encoding="utf-8") as f:
            self._send_text(f.read(), ctype=ctype)

    def _api_status(self):
        # One batched `systemctl is-active` call covers every service-backed
        # tool instead of spawning a subprocess per tool on every poll.
        active_map = registry.batch_systemctl_active(registry.service_names_needing_check())
        tools = {tid: registry.tool_status(tid, active_map) for tid in registry.TOOLS}
        self._send_json({
            "system": system_info(),
            "tools": tools,
            "score": security_score(tools),
            "categories": registry.CATEGORIES,
            "tool_meta": {tid: {k: v for k, v in m.items() if k != "check"} for tid, m in registry.TOOLS.items()},
            "actions": registry.ACTIONS,
            "scans": registry.SCANS,
            "scenarios": registry.SCENARIOS,
            "log_sources": list(registry.LOG_SOURCES.keys()),
            "firewall": registry.firewall_summary(),
            "threats": {
                "banned_ips": registry.fail2ban_banned_count(),
                "suricata_alerts": registry.suricata_alert_count(),
            },
            "network": _current_rates(),
        })

    def _stream_monitor(self):
        self._sse_headers()
        prev_rx, prev_tx = registry.read_net_bytes()
        prev_idle, prev_total = registry.read_cpu_times()
        prev_t = time.time()
        while True:
            time.sleep(1)
            rx, tx = registry.read_net_bytes()
            idle, total = registry.read_cpu_times()
            now = time.time()
            dt = max(now - prev_t, 0.001)
            rx_rate = max(0.0, (rx - prev_rx) / dt)
            tx_rate = max(0.0, (tx - prev_tx) / dt)
            d_idle, d_total = idle - prev_idle, total - prev_total
            cpu_pct = round((1 - d_idle / d_total) * 100, 1) if d_total > 0 else 0.0
            prev_rx, prev_tx, prev_idle, prev_total, prev_t = rx, tx, idle, total, now
            payload = {
                "rx": rx_rate, "tx": tx_rate,
                "cpu": cpu_pct,
                "mem": registry.read_mem_percent(),
                "disk": registry.read_disk_percent(),
                "uptime": registry.read_uptime(),
            }
            if not self._sse_send(json.dumps(payload)):
                return

    def _stream_install(self, qs):
        tool = qs.get("tool", [None])[0]
        if tool not in registry.TOOLS:
            self._sse_headers()
            self._sse_send("[-] Unknown tool.")
            return
        fn = registry.TOOLS[tool]["install_fn"]
        use_sudo = qs.get("sudo", ["1"])[0] != "0"
        self._sse_headers()
        for line in run_core(fn, use_sudo=use_sudo):
            if line.startswith("__EXIT__"):
                self._sse_send(f"__DONE__{line[8:]}")
                break
            if not self._sse_send(line):
                break

    def _stream_uninstall(self, qs):
        tool = qs.get("tool", [None])[0]
        if tool not in registry.TOOLS:
            self._sse_headers()
            self._sse_send("[-] Unknown tool.")
            return
        use_sudo = qs.get("sudo", ["1"])[0] != "0"
        self._sse_headers()
        for line in run_core("uninstall_tool", [tool], use_sudo=use_sudo):
            if line.startswith("__EXIT__"):
                self._sse_send(f"__DONE__{line[8:]}")
                break
            if not self._sse_send(line):
                break

    def _stream_action(self, qs):
        name = qs.get("name", [None])[0]
        if name not in registry.ACTIONS:
            self._sse_headers()
            self._sse_send("[-] Unknown action.")
            return
        # Build the shell function's positional args straight from each
        # action's declared `params`, in order, instead of a hardcoded
        # if/elif per action name here. That special-casing was a real
        # trap: adding a new action with a param in registry.py silently
        # did nothing unless someone remembered to also add a branch here.
        args = [qs.get(p["name"], [p.get("default", "")])[0] for p in registry.ACTIONS[name]["params"]]
        use_sudo = qs.get("sudo", ["1"])[0] != "0"
        self._sse_headers()
        for line in run_core(name, args, use_sudo=use_sudo):
            if line.startswith("__EXIT__"):
                self._sse_send(f"__DONE__{line[8:]}")
                break
            if not self._sse_send(line):
                break

    def _stream_scan(self, qs):
        name = qs.get("name", [None])[0]
        if name not in registry.SCANS:
            self._sse_headers()
            self._sse_send("[-] Unknown scan.")
            return
        use_sudo = qs.get("sudo", ["1"])[0] != "0"
        self._sse_headers()
        for line in run_core(name, use_sudo=use_sudo):
            if line.startswith("__EXIT__"):
                self._sse_send(f"__DONE__{line[8:]}")
                break
            if not self._sse_send(line):
                break

    def _stream_logs(self, qs):
        source = qs.get("source", [None])[0]
        path = registry.LOG_SOURCES.get(source)
        self._sse_headers()
        if not path:
            self._sse_send("[-] Unknown log source.")
            return
        if not os.path.isfile(path):
            self._sse_send(f"[!] {path} does not exist yet. Install/start the related tool first.")
            return
        try:
            # Binary mode for the seek: Python only guarantees a text-mode
            # seek() for offsets that came from that same file's tell(), not
            # an arbitrary computed one like "end minus 4000 bytes" — with a
            # multi-byte encoding that can land mid-character and decode
            # wrong. Seeking on the raw bytes and decoding after is exact.
            with open(path, "rb") as f:
                f.seek(0, os.SEEK_END)
                size = f.tell()
                f.seek(max(0, size - 4000))
                tail = f.read().decode("utf-8", errors="replace")
                for line in tail.splitlines()[-40:]:
                    if not self._sse_send(line):
                        return
                while True:
                    line = f.readline()
                    if line:
                        if not self._sse_send(line.decode("utf-8", errors="replace").rstrip("\n")):
                            return
                    else:
                        time.sleep(1)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as e:
            self._sse_send(f"[-] Log stream error: {e}")


def run_core_sync(fn, args=None):
    return [l for l in run_core(fn, args) if not l.startswith("__EXIT__")]


def main():
    if os.name == "nt":
        print("This dashboard manages Linux security tools and must run on a Linux host.")
        sys.exit(1)
    if os.geteuid() != 0:
        print("[!] Run this as root (sudo) so install/service actions can succeed.")
        sys.exit(1)
    if not shutil.which("bash"):
        print("[!] bash is required.")
        sys.exit(1)

    try:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError as e:
        print(f"[-] Could not bind to 127.0.0.1:{PORT} ({e}).")
        print(f"    Is OpSec Dashboard already running? Set OPSEC_PORT to use a different port.")
        sys.exit(1)
    # Long-lived per-connection threads (Monitor's live stream, log tailing)
    # never return on their own. Without daemon_threads, those threads keep
    # the process alive forever after Ctrl+C, since ThreadingHTTPServer
    # doesn't force them to exit; the terminal just hangs. Daemon threads
    # are killed automatically when the main thread exits instead.
    server.daemon_threads = True
    url = f"http://127.0.0.1:{PORT}/"
    print("=" * 60)
    print(" OpSec Dashboard is running (localhost only)")
    print(f" Open: {url}")
    print("=" * 60)

    def _open_browser():
        time.sleep(0.6)
        try:
            webbrowser.open(url)
        except Exception:
            pass

    threading.Thread(target=_open_browser, daemon=True).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[+] Shutting down OpSec Dashboard.")
        server.shutdown()


if __name__ == "__main__":
    main()
