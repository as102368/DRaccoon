"""Test Electron login window via raw Chrome DevTools Protocol over browser WS."""
import asyncio
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import websockets

ELECTRON_EXE = Path(__file__).resolve().parent / "electron" / "electron.exe"
APP_DIR = Path(__file__).resolve().parent / "app"
CDP_PORT = 9232
OUTPUT_FILE = Path(__file__).resolve().parent / "test_login_pw_cdp_output.txt"


class Logger:
    def __init__(self, path):
        self.f = open(path, "w", encoding="utf-8")

    def log(self, msg):
        line = f"{time.strftime('%H:%M:%S')} {msg}"
        print(line)
        self.f.write(line + "\n")
        self.f.flush()

    def close(self):
        self.f.close()


class CdpClient:
    """Minimal async CDP client that talks to the browser target WebSocket."""

    def __init__(self, ws_url, log_ref):
        self.ws_url = ws_url
        self.log = log_ref
        self.ws = None
        self._next_id = 1
        self._pending = {}
        self._recv_task = None

    async def start(self):
        self.log(f"Connecting to browser CDP: {self.ws_url}")
        self.ws = await websockets.connect(self.ws_url, open_timeout=15, close_timeout=5)
        self._recv_task = asyncio.create_task(self._recv_loop())

    async def _recv_loop(self):
        try:
            async for raw in self.ws:
                try:
                    msg = json.loads(raw)
                except Exception as e:
                    self.log(f"CDP recv parse error: {e}")
                    continue
                if msg.get("id") in self._pending:
                    fut = self._pending.pop(msg["id"])
                    if not fut.done():
                        fut.set_result(msg)
                elif "method" in msg:
                    self.log(f"CDP event [{msg.get('sessionId', '-')}] {msg['method']}")
                    if msg["method"] == "Runtime.consoleAPICalled":
                        args = msg.get("params", {}).get("args", [])
                        text = " ".join(str(a.get("value", "")) for a in args)
                        self.log(f"  console: {text}")
                    elif msg["method"] == "Log.entryAdded":
                        entry = msg.get("params", {}).get("entry", {})
                        self.log(f"  log.entry: {entry.get('text', '')}")
                    elif msg["method"] == "Runtime.exceptionThrown":
                        exc = msg.get("params", {}).get("exceptionDetails", {})
                        self.log(f"  exception: {exc.get('text', '')} {exc.get('exception', {}).get('description', '')}")
        except websockets.exceptions.ConnectionClosed as e:
            self.log(f"CDP recv loop closed: {e}")
        except Exception as e:
            self.log(f"CDP recv loop error: {e}")

    async def send(self, method, params=None, session_id=None):
        if self.ws is None:
            raise RuntimeError("CDP not connected")
        msg = {"id": self._next_id, "method": method, "params": params or {}}
        if session_id:
            msg["sessionId"] = session_id
        self._next_id += 1
        loop = asyncio.get_event_loop()
        fut = loop.create_future()
        self._pending[msg["id"]] = fut
        await self.ws.send(json.dumps(msg))
        return await asyncio.wait_for(fut, timeout=15)

    async def close(self):
        if self._recv_task:
            self._recv_task.cancel()
            try:
                await self._recv_task
            except asyncio.CancelledError:
                pass
        if self.ws:
            await self.ws.close()


def get_browser_ws_url(port):
    try:
        url = f"http://127.0.0.1:{port}/json/version"
        with urllib.request.urlopen(url, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("webSocketDebuggerUrl")
    except Exception as e:
        return None


def list_cdp_targets(port):
    try:
        url = f"http://127.0.0.1:{port}/json/list"
        with urllib.request.urlopen(url, timeout=5) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        return [{"error": str(e)}]


async def async_main(log):
    import tempfile
    import shutil

    default_user_data_dir = Path.home() / "AppData" / "Roaming" / "douzy-electron"
    user_data_dir = Path(tempfile.mkdtemp(prefix="douzy-test-user-data-"))
    settings_path = user_data_dir / "settings.json"

    # Copy existing user data so that real Douyin cookies/session are available,
    # but write to an isolated temp directory to avoid test sandbox permission issues.
    if default_user_data_dir.exists():
        log.log(f"Copying user data from {default_user_data_dir} to {user_data_dir}...")
        try:
            shutil.copytree(default_user_data_dir, user_data_dir, dirs_exist_ok=True)
            log.log("User data copy complete")
        except Exception as e:
            log.log(f"Warning: failed to copy user data: {e}")
    else:
        log.log(f"Default user data dir not found: {default_user_data_dir}")

    log.log("Launching Electron...")
    proc = subprocess.Popen(
        [
            str(ELECTRON_EXE),
            str(APP_DIR),
            f"--remote-debugging-port={CDP_PORT}",
            f"--user-data-dir={user_data_dir}",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )

    def read_stdout():
        while True:
            line = proc.stdout.readline()
            if not line:
                break
            log.log(f"[electron] {line.rstrip()}")

    import threading
    stdout_thread = threading.Thread(target=read_stdout, daemon=True)
    stdout_thread.start()

    try:
        # Wait for DevTools server
        browser_ws = None
        for _ in range(30):
            browser_ws = get_browser_ws_url(CDP_PORT)
            if browser_ws:
                break
            await asyncio.sleep(0.5)
        if not browser_ws:
            log.log("Failed to discover browser CDP endpoint")
            return 1

        log.log(f"Browser CDP endpoint: {browser_ws}")
        cdp = CdpClient(browser_ws, log.log)
        await cdp.start()

        # Enable target discovery
        await cdp.send("Target.setDiscoverTargets", {"discover": True})

        # Get current targets and locate main page
        targets_resp = await cdp.send("Target.getTargets")
        targets = targets_resp.get("result", {}).get("targetInfos", [])
        log.log(f"Initial targets: {len(targets)}")
        main_target = None
        for t in targets:
            log.log(f"  {t.get('type')}: {t.get('title')} | {t.get('url')}")
            if "index.html" in t.get("url", ""):
                main_target = t

        if not main_target:
            log.log("Main page target not found")
            return 1

        # Attach to main page to trigger login
        main_attach = await cdp.send("Target.attachToTarget", {"targetId": main_target["targetId"], "flatten": True})
        main_session = main_attach["result"]["sessionId"]
        log.log(f"Main page session: {main_session}")
        await cdp.send("Runtime.enable", session_id=main_session)

        log.log("Waiting for sidebar login button to render...")
        click_result = None
        for _ in range(30):
            click_result = await cdp.send(
                "Runtime.evaluate",
                {
                    "expression": """
                        (() => {
                            const btn = document.querySelector('.btn-login-sidebar');
                            if (!btn) return {found: false};
                            btn.click();
                            return {found: true, text: btn.textContent.trim()};
                        })()
                    """,
                    "returnByValue": True,
                },
                session_id=main_session,
            )
            value = click_result.get('result', {}).get('result', {}).get('value', {})
            if value and value.get('found'):
                break
            await asyncio.sleep(0.5)
        log.log(f"Sidebar button click: {click_result.get('result', {}).get('result', {}).get('value', {})}")

        # Wait for login window target
        log.log("Waiting for login window target...")
        login_target = None
        for _ in range(40):
            targets_resp = await cdp.send("Target.getTargets")
            for t in targets_resp.get("result", {}).get("targetInfos", []):
                if t.get("type") == "page" and "douyin.com" in t.get("url", ""):
                    login_target = t
                    break
            if login_target:
                break
            await asyncio.sleep(0.5)

        if not login_target:
            log.log("Login window target not found")
            # Dump all targets for debugging
            targets_resp = await cdp.send("Target.getTargets")
            for t in targets_resp.get("result", {}).get("targetInfos", []):
                log.log(f"  still: {t.get('type')}: {t.get('url')}")
            return 1

        log.log(f"Login window target: {login_target['targetId']} {login_target['url']}")

        # Attach to login window
        login_attach = await cdp.send("Target.attachToTarget", {"targetId": login_target["targetId"], "flatten": True})
        login_session = login_attach["result"]["sessionId"]
        log.log(f"Login window session: {login_session}")

        await cdp.send("Runtime.enable", session_id=login_session)
        await cdp.send("Page.enable", session_id=login_session)
        await cdp.send("Performance.enable", session_id=login_session)
        await cdp.send("Log.enable", session_id=login_session)

        # Wait for page load and button injection (poll up to 20s)
        log.log("Waiting for injected login button...")
        button_exists = False
        for _ in range(40):
            btn_resp = await cdp.send("Runtime.evaluate", {
                "expression": "!!document.getElementById('douzy-login-complete-btn')",
                "returnByValue": True,
            }, session_id=login_session)
            value = btn_resp.get("result", {}).get("result", {}).get("value", False)
            if value:
                button_exists = True
                break
            await asyncio.sleep(0.5)

        # Metrics
        metrics_resp = await cdp.send("Runtime.evaluate", {
            "expression": """(() => {
                const nav = performance.getEntriesByType('navigation')[0];
                return {
                    url: location.href,
                    title: document.title,
                    domInteractive: nav ? nav.domInteractive : null,
                    domComplete: nav ? nav.domComplete : null,
                    loadEventEnd: nav ? nav.loadEventEnd : null,
                    memory: performance.memory ? {
                        usedJSHeapSize: performance.memory.usedJSHeapSize,
                        totalJSHeapSize: performance.memory.totalJSHeapSize,
                    } : null,
                    buttonExists: !!document.getElementById('douzy-login-complete-btn'),
                };
            })()""",
            "returnByValue": True,
        }, session_id=login_session)
        metrics = metrics_resp.get("result", {}).get("result", {}).get("value", {})
        log.log(f"Login window metrics: {metrics}")

        perf_resp = await cdp.send("Performance.getMetrics", session_id=login_session)
        perf_metrics = perf_resp.get("result", {}).get("metrics", [])
        perf_dict = {m["name"]: m["value"] for m in perf_metrics}
        log.log(f"Performance metrics: {perf_dict}")

        # Screenshot
        screenshot_resp = await cdp.send("Page.captureScreenshot", {"format": "png"}, session_id=login_session)
        data = screenshot_resp.get("result", {}).get("data", "")
        if data:
            import base64
            with open("test_login_window.png", "wb") as f:
                f.write(base64.b64decode(data))
            log.log("Saved test_login_window.png")

        # Click the injected "complete login" button to verify IPC path
        if button_exists:
            log.log("Clicking injected '我已完成登录' button...")
            await cdp.send("Runtime.evaluate", {
                "expression": "document.getElementById('douzy-login-complete-btn').click(); void 0;",
                "returnByValue": True,
            }, session_id=login_session)
            # Wait for main process cookie detection / validation logs
            await asyncio.sleep(5)
        else:
            log.log("Injected button not found after waiting")
            return 1

        # Give renderer time to save settings after login window closes
        await asyncio.sleep(3)

        await cdp.close()

        # Verify settings were persisted
        if settings_path.exists():
            try:
                settings = json.loads(settings_path.read_text(encoding="utf-8").lstrip("\ufeff"))
                cookie = settings.get("cookieString", "")
                log.log(f"settings.json exists, cookieString length: {len(cookie)}")
                if cookie:
                    log.log(f"settings.json cookie begins with: {cookie[:80]}...")
                else:
                    log.log("WARNING: settings.json cookieString is empty")
            except Exception as e:
                log.log(f"Failed to read settings.json: {e}")
        else:
            log.log(f"WARNING: settings.json not found at {settings_path}")

        log.log("\nTest completed")
        return 0
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except Exception:
                proc.kill()
        # Clean up isolated user data directory
        try:
            import shutil
            shutil.rmtree(user_data_dir, ignore_errors=True)
            log.log(f"Cleaned up user data dir: {user_data_dir}")
        except Exception as e:
            log.log(f"Failed to clean up user data dir: {e}")


def main():
    log = Logger(OUTPUT_FILE)
    try:
        return asyncio.run(async_main(log))
    except Exception as e:
        log.log(f"Unexpected error: {e}")
        import traceback
        log.log(traceback.format_exc())
        return 1
    finally:
        log.close()


if __name__ == "__main__":
    sys.exit(main())
