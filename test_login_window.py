"""Test Electron login window with Playwright."""
import json
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

APP_DIR = Path(__file__).resolve().parent / "app"
ELECTRON_EXE = Path(__file__).resolve().parent / "electron" / "electron.exe"


def main():
    with sync_playwright() as p:
        electron = p.electron.launch(
            executable_path=str(ELECTRON_EXE),
            args=[str(APP_DIR)],
            env={**dict(__import__("os").environ), "NODE_ENV": "development"},
        )
        try:
            # Wait for main window
            time.sleep(2)
            windows = electron.windows()
            print(f"Windows count: {len(windows)}")
            for i, w in enumerate(windows):
                print(f"  Window {i}: title={w.title()!r}, url={w.url()!r}")

            if not windows:
                print("No window found")
                return 1

            main_win = windows[0]
            main_win.set_viewport_size({"width": 1280, "height": 840})

            # Capture main window console logs
            logs = []
            def on_console(msg):
                logs.append(f"[main][{msg.type}] {msg.text}")
            main_win.on("console", on_console)

            # Take screenshot of main window
            main_win.screenshot(path="test_main_window.png")
            print("Saved test_main_window.png")

            # Look for login button and click it
            login_btn = main_win.locator("button:has-text('登录抖音')").first
            if login_btn.count() == 0:
                print("Login button not found")
                main_win.screenshot(path="test_main_window_no_btn.png")
                return 1

            print("Clicking login button...")
            login_btn.click()

            # Wait for login window to appear
            time.sleep(3)
            windows = electron.windows()
            print(f"Windows count after click: {len(windows)}")
            for i, w in enumerate(windows):
                print(f"  Window {i}: title={w.title()!r}, url={w.url()!r}")

            # Find login window (not main)
            login_win = None
            for w in windows:
                if w != main_win and "登录抖音" in w.title():
                    login_win = w
                    break

            if not login_win:
                print("Login window not found")
                main_win.screenshot(path="test_after_click.png")
                return 1

            # Capture login window logs
            login_logs = []
            def on_login_console(msg):
                login_logs.append(f"[login][{msg.type}] {msg.text}")
            login_win.on("console", on_login_console)

            login_win.on("dialog", lambda dialog: print(f"DIALOG: {dialog.type} {dialog.message}"))

            # Wait for Douyin page to load
            print("Waiting for Douyin page...")
            try:
                login_win.wait_for_load_state("networkidle", timeout=30000)
            except Exception as e:
                print(f"Wait for networkidle timed out: {e}")

            time.sleep(5)

            login_win.screenshot(path="test_login_window.png")
            print("Saved test_login_window.png")

            # Check for our injected button
            btn = login_win.locator("#douzy-login-complete-btn").first
            print(f"Injected login button visible: {btn.is_visible() if btn.count() else False}")

            # Print logs
            print("\n--- Main window console logs ---")
            for line in logs[-50:]:
                print(line)
            print("\n--- Login window console logs ---")
            for line in login_logs[-100:]:
                print(line)

            # Try to gather performance metrics
            metrics = login_win.evaluate("() => JSON.stringify(window.performance.getEntriesByType('navigation'))")
            print(f"\nNavigation entries: {metrics}")

            return 0
        finally:
            electron.close()


if __name__ == "__main__":
    sys.exit(main())
