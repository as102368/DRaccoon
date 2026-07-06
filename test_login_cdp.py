"""Test Electron login window via Chrome DevTools Protocol."""
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
CDP_PORT = 9230


def log(msg):
    print(msg, flush=True)


def cdp_get_json(path):
    url = f"http://127.0.0.1:{CDP_PORT}{path}"
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        log(f"CDP request failed: {e}")
        return None


async def send(ws, method, params=None):
    msg = {"id": int(time.time() * 1000), "method": method, "params": params or {}}
    await ws.send(json.dumps(msg))
    while True:
        resp = json.loads(await ws.recv())
        if resp.get("id") == msg["id"]:
            return resp


async def main():
    log("Launching Electron...")
    proc = subprocess.Popen(
        [str(ELECTRON_EXE), str(APP_DIR), f"--remote-debugging-port={CDP_PORT}"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )

    async def read_stdout():
        loop = asyncio.get_event_loop()
        while True:
            try:
                line = await asyncio.wait_for(loop.run_in_executor(None, proc.stdout.readline), timeout=1.0)
            except asyncio.TimeoutError:
                continue
            if not line:
                break
            log(f"[electron] {line.rstrip()}")

    stdout_task = asyncio.create_task(read_stdout())

    try:
        log("Waiting for Electron to start...")
        await asyncio.sleep(4)

        targets = None
        for i in range(10):
            targets = cdp_get_json("/json/list")
            if targets:
                break
            log(f"Retry {i+1}/10 waiting for CDP...")
            await asyncio.sleep(1)

        if not targets:
            log("No CDP targets found")
            return 1

        log(f"Found {len(targets)} target(s)")
        for t in targets:
            log(f"  {t.get('type')}: {t.get('title')} | {t.get('url')}")

        main_target = next((t for t in targets if "index.html" in t.get("url", "")), None)
        if not main_target:
            log("Main window target not found")
            return 1

        ws_url = main_target["webSocketDebuggerUrl"]
        log(f"Connecting to main window CDP...")

        try:
            ws = await websockets.connect(ws_url, open_timeout=10, close_timeout=5)
        except Exception as e:
            log(f"Failed to connect CDP: {e}")
            return 1

        try:
            await send(ws, "Runtime.enable")
            await send(ws, "Log.enable")

            log("Triggering loginWithBrowser via renderer...")
            result = await send(ws, "Runtime.evaluate", {
                "expression": "window.electronAPI.loginWithBrowser().then(r => JSON.stringify(r)).catch(e => 'ERR:' + e.message)",
                "awaitPromise": True,
                "returnByValue": True,
            })
            value = result.get("result", {}).get("result", {}).get("value", "")
            log(f"loginWithBrowser returned: {value}")

            log("Waiting for login window...")
            await asyncio.sleep(10)

            targets = cdp_get_json("/json/list")
            log(f"\nTargets after login: {len(targets)}")
            for t in targets:
                log(f"  {t.get('type')}: {t.get('title')} | {t.get('url')}")

            # Collect any remaining logs
            start = time.time()
            while time.time() - start < 2:
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=0.5)
                    msg = json.loads(msg)
                    if msg.get("method") == "Runtime.consoleAPICalled":
                        args = msg.get("params", {}).get("args", [])
                        text = " ".join(str(a.get("value", a.get("description", ""))) for a in args)
                        log(f"[main console] {text}")
                    elif msg.get("method") == "Log.entryAdded":
                        entry = msg.get("params", {}).get("entry", {})
                        log(f"[main log] {entry.get('level')} {entry.get('text')}")
                except asyncio.TimeoutError:
                    pass

            log("\nTest completed")
            return 0
        finally:
            try:
                await ws.close()
            except Exception as e:
                log(f"WS close error: {e}")
    finally:
        stdout_task.cancel()
        try:
            await stdout_task
        except asyncio.CancelledError:
            pass
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except Exception:
                proc.kill()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
