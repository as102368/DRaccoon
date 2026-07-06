"""通过浏览器观察抖音网页版真实的取消关注请求。"""
from __future__ import annotations

import asyncio
import json

from playwright.async_api import async_playwright


async def main():
    with open(r"D:\DOU\douzy-electron\python\.cookies.json", "r", encoding="utf-8") as f:
        cookies_raw = json.load(f)

    cookies = [
        {"name": k, "value": v, "domain": ".douyin.com", "path": "/"}
        for k, v in cookies_raw.items()
    ]

    target_sec_uid = "MS4wLjABAAAA7LsIeUOS5ooTa0Cc3ontMSyRhl6A1BcSoyTMoveerqU"
    target_url = f"https://www.douyin.com/user/{target_sec_uid}"

    captured = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False, args=["--disable-blink-features=AutomationControlled"])
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 800},
            locale="zh-CN",
        )
        await context.add_cookies(cookies)
        page = await context.new_page()

        async def handle_route(route, request):
            url = request.url
            if "unfollow" in url or "follow" in url:
                captured.append({
                    "url": url,
                    "method": request.method,
                    "headers": dict(request.headers),
                    "post_data": request.post_data,
                })
                print("CAPTURED:", request.method, url)
                print("POST_DATA:", request.post_data)
            await route.continue_()

        await page.route("**/*", handle_route)

        await page.goto(target_url, wait_until="domcontentloaded", timeout=60000)
        print("page loaded:", page.url)

        # 等待页面稳定
        await asyncio.sleep(5)

        # 打印页面源码片段
        html = await page.content()
        print("HTML snippet (search follow button):")
        for marker in ["已关注", "关注"]:
            idx = html.find(marker)
            if idx != -1:
                print(f"--- {marker} at {idx} ---")
                print(html[max(0, idx-200):idx+200])

        # 尝试自动点击包含"已关注"文本的按钮
        try:
            btn = page.locator("button:has-text('已关注')").first
            if await btn.count() > 0:
                print("found 已关注 button, clicking...")
                await btn.click()
                await asyncio.sleep(2)
                confirm_btn = page.locator("button:has-text('取消关注')").first
                if await confirm_btn.count() > 0:
                    print("found 取消关注 confirm, clicking...")
                    await confirm_btn.click()
                    await asyncio.sleep(5)
        except Exception as e:
            print("auto click failed:", e)

        print("等待 10 秒收集请求...")
        await asyncio.sleep(10)

        with open(r"D:\DOU\douzy-electron\python\test_browser_unfollow_captured.json", "w", encoding="utf-8") as f:
            json.dump(captured, f, ensure_ascii=False, indent=2)

        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
