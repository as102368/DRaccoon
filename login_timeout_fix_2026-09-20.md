# 登录校验超时修复（2026-09-20）

## 问题
点击「我已完成登录」后提示：
> 校验未通过：校验脚本执行超时（15 秒）

## 根因
打包环境下 Python 登录校验脚本（`login_service.py`）启动 + 发网络请求耗时可能超过 15 秒；但用户其实已在抖音页面成功登录，Cookie 是有效的。

## 修复（resources/app/main.js）

1. **超时延长**：`validateCookiesWithBackend` 从 15 秒延长到 60 秒。
2. **页面优先提取用户信息**：新增 `getUserInfoFromPage()`，从抖音页面水合数据 / React props 直接读取 `sec_uid` / `nickname` / `avatar` / `unique_id`。
3. **登录流程改为**：
   - 先尝试页面提取用户信息；成功则直接保存 Cookie 并结束登录。
   - 页面提取失败再回退到 Python 后端校验。
4. **防重复执行**：`doCheckAndFinish` 开头加 `if (resolved) return;`。

## 生效
- 修改的是 `resources/app/main.js`。
- `node --check resources/app/main.js` 已通过。
- **需要重启 DRaccoon 生效**（托盘→退出，确认任务管理器无 DRaccoon.exe 后再打开）。
