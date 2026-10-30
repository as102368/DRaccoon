"""Contract test: mimic api_client._fetch_via_page_bridge + _request_json_gated
against the mock /v1/browser-fetch server. Validates the JSON contract only
(real Chromium GUI cannot run in this sandbox).
"""
import json
import os
import sys
import urllib.request

PORT = os.environ.get("MOCK_PORT") or "39517"
TOKEN = "test-token"


def fetch_via_page_bridge(path, params, signed_url):
    url = f"http://127.0.0.1:{PORT}/v1/browser-fetch"
    payload = {"token": TOKEN, "url": signed_url}
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    status = int((data or {}).get("status") or 0)
    text = (data or {}).get("text") or ""
    return status, text


def request_json_gated(path, params, signed_url):
    status, text = fetch_via_page_bridge(path, params, signed_url)
    if status == 200:
        parsed = json.loads(text) if isinstance(text, str) and text else {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def main():
    signed_url = "https://www.douyin.com/aweme/v1/web/mix/detail/?mix_id=999"
    result = request_json_gated("/aweme/v1/web/mix/detail/", {}, signed_url)
    assert isinstance(result, dict), "result must be a dict"
    ok = result.get("status_code") == 0 and result.get("aweme_detail", {}).get("aweme_id") == "123"
    print("CONTRACT_OK" if ok else "CONTRACT_FAIL", json.dumps(result, ensure_ascii=False))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
