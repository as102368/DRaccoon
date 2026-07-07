"""通过浏览器内的 fetch 调用 commit/follow/user 接口测试取关/关注。"""
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

    sec_uid = "MS4wLjABAAAA7LsIeUOS5ooTa0Cc3ontMSyRhl6A1BcSoyTMoveerqU"
    user_id = "101496544961"

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=False,
            args=["--disable-blink-features=AutomationControlled"],
        )
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 800},
            locale="zh-CN",
        )
        await context.add_cookies(cookies)
        page = await context.new_page()
        await page.goto(f"https://www.douyin.com/user/{sec_uid}", wait_until="domcontentloaded", timeout=60000)
        await asyncio.sleep(3)

        async def commit(action_type: int):
            body = f"type={action_type}&user_id={user_id}"
            script = """
            async ({body, sec_uid}) => {
                const url = `/aweme/v1/web/commit/follow/user/?device_platform=webapp&aid=6383&channel=channel_pc_web&pc_client_type=1&pc_libra_divert=Windows&update_version_code=170400&support_h265=1&support_dash=1&version_code=170400&version_name=17.4.0&cookie_enabled=true&screen_width=1280&screen_height=800&browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome&browser_version=126.0.0.0&browser_online=true&engine_name=Blink&engine_version=126.0.0.0&os_name=Windows&os_version=10&cpu_core_num=16&device_memory=16&platform=PC&downlink=10&effective_type=4g&round_trip_time=50`;
                try {
                    const resp = await fetch(url, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                            'Accept': 'application/json, text/plain, */*',
                            'X-Secsdk-Csrf-Token': 'DOWNGRADE',
                        },
                        body,
                        credentials: 'include',
                    });
                    const text = await resp.text();
                    return {status: resp.status, text};
                } catch (e) {
                    return {status: 0, text: e.toString()};
                }
            }
            """
            result = await page.evaluate(script, {"body": body, "sec_uid": sec_uid})
            print(f"=== type={action_type} ===")
            print(result)

        await commit(0)  # unfollow
        await asyncio.sleep(2)
        await commit(1)  # follow

        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
