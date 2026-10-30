# 登录校验超时修复（DRaccoon 第十六次修复）

日期：2026-09-17
文件：`E:\DRaccoon\resources\app\main.js`
触发：用户点击「我已完成登录」后提示「校验未通过：校验脚本执行超时（15 秒）」。

## 根因
打包环境下 `login_service.py` 的 Python 解释器冷启动 + 网络请求耗时可能超过原 15 秒硬超时。
但用户此时已在抖音页面真实登录成功、Cookie 有效——后端校验只是慢，不代表登录失败。

## 修复方案（页面优先提取，绕过后端超时）
1. **超时延长 15s → 60s**
   - `validateCookiesWithBackend` 内 `setTimeout` 从 `15000` 改为 `60000`。
   - 文案「校验脚本执行超时（15 秒）」→「校验脚本执行超时（60 秒）」，新增 `timedOut: true`。

2. **新增 `getUserInfoFromPage(loginWin)`**（main.js:3082）
   - 通过 `loginWin.webContents.executeJavaScript` 在页面内递归搜索水合数据：
     `window._SSR_HYDRATED_DATA` / `window.__INITIAL_STATE__` / `window.__INITIAL_DATA__` /
     `window._ROUTER_DATA` / `window.render_data` / `window.__pace_data`。
   - 兜底解析 `script#RENDER_DATA`（URL 解码后 JSON）与 React props
     （`__reactProps$*` / `__reactInternalInstance$*`）。
   - 提取 `{ sec_uid, nickname, avatar, unique_id }`，`deepFind` 递归深度上限 14 层。

3. **`doCheckAndFinish` 改为页面优先**（main.js:3295）
   - 校验到登录 Cookie 后，先 `getUserInfoFromPage(loginWin)`。
   - 命中 `sec_uid` → 立即 `writeUnifiedCookies` + `finish({ success:true, ... })`，**跳过后端校验**。
   - 仅当页面提取失败时才回退 `validateCookiesWithBackend`（已 60s 超时）。
   - 函数开头加 `if (resolved) return;`，`finish` 内也有 `resolved` 守卫，防重复结算。

## 验证
- `node --check E:\DRaccoon\resources\app\main.js` 通过（Exit Code 0）。
- 已人工通读 `doCheckAndFinish` / `auth:completeLogin` / `finish` 全链路，逻辑闭合。

## 生效条件（重要）
需**彻底退出 DRaccoon 托盘常驻进程后重新打开**，否则老进程仍加载旧 `main.js`。
历史教训：多次"还是不行"源于托盘老进程未退出，新代码未加载。

## 待用户实测
重启后跑一次登录（点「我已完成登录」或导航到个人主页自动判定），
再读 `%APPDATA%/DRaccoon/logs/main.log` 确认：
- 「尝试从页面提取用户信息...」「页面提取用户信息成功: <昵称> <sec_uid>」
- 或后端回退路径「页面提取失败，正在后端校验 cookies...」
