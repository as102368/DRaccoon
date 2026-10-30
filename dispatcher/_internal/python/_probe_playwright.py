import sys

try:
    from playwright.async_api import async_playwright
except Exception as exc:
    print("PLAYWRIGHT_FAIL", repr(exc))
    raise SystemExit(1)

print("PLAYWRIGHT_OK", sys.version.split()[0])
