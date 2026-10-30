# DRaccoon 更新日志（CHANGELOG）

> 抖音视频批量下载桌面工具（Electron + Python dispatcher）。
> 本文档记录 2026-10 风控升级后的完整修复链路。**所有修复生效前提：彻底退出托盘并重开 DRaccoon 桌面端。**

---

## 一、背景：为什么"全都不返回、下载也用不了"

抖音 2026-10 风控全面升级后，DRaccoon 的所有功能同时失效，根因是**一条故障链**：

1. **抖音网页改版滚动方式**：用户主页从 window 滚动改为内部容器滚动（`.route-scroll-container`），`documentElement.scrollHeight` 恒等于视口高（实测 840），`window.scrollTo` 完全无效；
2. 采集窗口的滚动代码因此**从未滚动成功**，且高度监测恒为 840 → 8 轮后误判"页面稳定"提前退出 → **浏览器采集永远只拿到首屏 8 条**（日志里 `ids` 恒为 8 即此因）;
3. 唯一不被风控的通道（真实浏览器 CDP 拦截）形同虚设 → 全部流量退到"页内注入式 XHR"→ 被 Argus 全面 403（喜欢/作品/收藏夹/合集/音乐全被拒）→ **同步、下载、收藏、解析关注博主全部 -403/-502**。

---

## 二、修复内容（按模块）

### 1. `resources/app/main.js`（Electron 主进程）

| 修复 | 说明 |
|---|---|
| **滚动根因修复**（核心） | 滚动目标改为 `.route-scroll-container` 优先 + window 兜底；高度监测同步改取容器 `scrollHeight`；每 10 轮输出滚动日志 `[bridge] collect 滚动 step=N {via,sh,st}` |
| **首页预热**（参考 parse-video-py） | 打开目标页前先访问 `douyin.com` 首页 1.2s 刷新风控 Cookie（ttwid/UIFID），降低列表/详情接口被静默拦截概率；collect 与 detail 两个采集函数均已接入 |
| 静默窗口定位 | 滚动采集前将离屏窗口移回屏幕内（opacity 0 + ignoreMouseEvents 不挡用户），保证渲染 |

### 2. `dispatcher/_internal/backend/core/api_client.py`

| 修复 | 说明 |
|---|---|
| **无签名 HTML 解析通道：实测证伪后撤回** | 曾参考 parse-video-py 实现 iesdouyin 分享页解析，三轮实测（JS VM 外壳 / iteminfo 空 body / 带 Cookie 无 SSR 数据）证明该路径已死，完整撤回，避免每条详情白白多耗一次请求 |
| **桥接不可用明确报错** | `_collect_via_electron_bridge` 从静默 `return None` 改为明确 warning（提示打开桌面端并登录）；新增 `is_bridge_available()` 供上层判断 |
| 详情页内 XHR 优先、CDP 窗口兜底 | 该优先级由 `tests/test_detail_page_channel.py` 锁定（5 例），保持不变 |

### 3. `dispatcher/_internal/backend/sync_service.py`

| 修复 | 说明 |
|---|---|
| **收藏浏览器兜底**（新增 `_recover_favorites_via_browser`） | 页内 XHR 全被拦截时，自动改用桌面端真实浏览器窗口依次采集 kind=collect（默认收藏视频）/ collectmix（收藏合集）/ music（收藏音乐），合并回数据 |
| **喜欢同步兜底修复** | 页内 XHR 返回 -502 且桥可用时走 `_recover_likes_via_browser`；桥不可用时给出可操作中文报错（不再显示晦涩 -502） |
| **Argus 拦截不再空转/提前退出** | 收藏夹列表、合集列表、`_sync_paged_awemes`、默认收藏视频在 -403/-502 时：跳出子流程（不提前 return cache、不再每页 ~1.5s 空转重试几十次），最后统一走浏览器兜底；登录失效仍立即报错返回 |

### 4. `dispatcher/_internal/backend/core/user_downloader.py`

| 修复 | 说明 |
|---|---|
| **下载前桥接检查** | 下载开始前检查 `is_bridge_available()`，桥不可用直接抛出可操作中文报错，避免任务跑半天 0 项 |

### 5. `dispatcher/_internal/python/new_releases_bridge.py`（解析关注博主）

| 修复 | 说明 |
|---|---|
| **浏览器兜底**（新增 `_recover_author_posts_via_browser`） | 博主作品接口被风控（-403/-502）时，改用浏览器窗口采集该博主主页（kind=post），按 `cutoff_time` 过滤出新作品 |

---

## 三、验证结果

- `node --check main.js` ✓
- `py_compile`（api_client / sync_service / new_releases_bridge / user_downloader）✓
- `pytest tests/` **14 passed**（含锁定详情页内 XHR 优先级的 `test_detail_page_channel.py`）

## 四、已知限制

1. **收藏的浏览器兜底只覆盖「默认收藏夹」视频**（+合集+音乐）；其余收藏夹需手动点击才加载 `collects/video/list`，静默滚动拿不到，folder 分组在兜底模式下归并到单一「浏览器采集」分组；
2. **解析关注博主兜底逐博主开一个浏览器窗口**，关注人数很多时较慢——产品层应限制单次检查的博主范围；
3. 所有浏览器兜底依赖 **DRaccoon 桌面端正在运行且已登录抖音**（提供真实浏览器 + DOUZY_BRIDGE_PORT）。

## 五、排查指引

- 日志位置：`C:\Users\USER-PC\AppData\Roaming\DRaccoon\logs\main.log`
- 采集是否成功：看 `browser-collect ... ids=` 是否**明显大于 8**（喜欢 2600+ 会滚较久，属正常）；
- 滚动是否生效：看 `[bridge] collect 滚动 step=N {"via":"container",...}`；
- 页内接口被拒：`页面通道三级尝试均被 Argus 拒绝 status=403`（属预期，会自动走浏览器兜底）。
