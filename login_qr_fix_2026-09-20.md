# 登录二维码不显示修复（DRaccoon 第十七次修复）

日期：2026-09-20
文件：`E:\DRaccoon\resources\app\main.js`
触发：用户打开登录窗口，抖音登录弹窗中的二维码区域只显示抖音 logo，无法刷出二维码。

## 根因
此前为拦截 `bitbrowser://` 等外部协议弹窗/外链，登录窗口注入了过粗的拦截逻辑：

1. `setWindowOpenHandler(() => ({ action: 'deny' }))` **一律拒绝**所有 `window.open` 弹窗。
2. `BLOCK_EXTERNAL_LINKS_SCRIPT` 只放行 `https:` + 抖音域，遇到 `javascript:` / `about:` / `blob:` / `data:` / 相对链接 / 空链接也会阻止。
3. `isAllowedLoginUrl` 同样只放行 `https:` 抖音域导航，拦截 `javascript:` / `about:` 等内部协议。

抖音的登录弹窗在生成二维码、切换验证码登录/密码登录、打开用户协议/隐私条款弹窗时，会用到这些内部协议、锚点或抖音域弹窗。被误拦后，二维码初始化失败，只能看到 logo 占位图。

## 修复内容

### 1. 重写 `isAllowedLoginUrl`
```js
function isAllowedLoginUrl(url) {
  try {
    const parsed = new URL(url);
    const isDouyin = parsed.hostname === 'douyin.com' || parsed.hostname === 'www.douyin.com' || parsed.hostname.endsWith('.douyin.com');
    const isHttp = parsed.protocol === 'https:' || parsed.protocol === 'http:';
    const isInternal = ['javascript:', 'about:', 'blob:', 'data:', 'mailto:', 'tel:'].includes(parsed.protocol);
    return isInternal || (isDouyin && isHttp);
  } catch (e) {
    return true; // 空或相对路径视为内部链接
  }
}
```

### 2. `setWindowOpenHandler` 改为放行抖音域弹窗
```js
loginWin.webContents.setWindowOpenHandler(({ url }) => {
  if (isAllowedLoginUrl(url)) {
    return { action: 'allow', overrideBrowserWindowOptions: { parent: loginWin } };
  }
  console.log('登录窗口阻止外部弹窗:', url);
  return { action: 'deny' };
});
```

### 3. 页面内链接拦截改为"只拦外部"
`BLOCK_EXTERNAL_LINKS_SCRIPT` 中的 `isAllowed` 改名为 `isExternal`，
仅当链接是**非抖音的 http/https** 或**未知自定义协议**（如 `bitbrowser://`）时才拦截；
明确放行 `javascript:` / `about:` / `blob:` / `data:` / `mailto:` / `tel:` 以及空/相对链接。

### 4. 新增登录窗口诊断日志
```js
loginWin.webContents.on('console-message', (event, level, message, line, sourceId) => { ... });
loginWin.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => { ... });
loginWin.webContents.on('did-fail-provisional-load', (event, errorCode, errorDescription, validatedURL) => { ... });
```
以后登录窗口的 JS 报错、资源加载失败都会自动写入 `%APPDATA%/DRaccoon/logs/main.log`，便于远程排查。

## 验证
- `node --check E:\DRaccoon\resources\app\main.js` 通过。
- 语法闭合，事件监听器无重复。

## 生效条件
**必须彻底退出托盘常驻进程后重新打开 DRaccoon**。仅关闭窗口不会让旧进程加载新代码。

## 实测指引
重启后：
1. 点击「登录抖音」打开登录窗口。
2. 等待 3-5 秒，观察二维码是否正常刷出。
3. 若仍不显示，立即截屏并告诉我，我会读 `main.log` 中的 `[login-console]` / `[login-fail-load]` 日志进一步定位。
