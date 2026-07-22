import os
import shutil
import time
import urllib.request
import zipfile
from pathlib import Path

root = Path(r'D:\DOU\douzy-electron')
final_dist = root / 'dist' / 'DRaccoon-release'
zip_path = root / 'electron-v31.0.2-win32-x64.zip'
url = 'https://github.com/electron/electron/releases/download/v31.0.2/electron-v31.0.2-win32-x64.zip'


def safe_remove(path: Path, retries: int = 3, delay: float = 2.0) -> bool:
    """尝试删除目录；若被占用则先重试，仍失败则重命名并返回 False。"""
    if not path.exists():
        return True
    for i in range(retries):
        try:
            shutil.rmtree(path)
            return True
        except PermissionError:
            print(f'目录被占用，{delay}s 后重试删除 ({i + 1}/{retries}) ...')
            time.sleep(delay)
    # 删除失败时重命名为旧版本备份，避免阻塞本次构建
    backup = path.parent / f'{path.name}-old-{int(time.time())}'
    try:
        path.rename(backup)
        print(f'无法删除旧目录，已重命名为: {backup}')
        return False
    except Exception as exc:
        print(f'无法重命名旧目录 {path}: {exc}')
        return False


def atomic_publish(build_dir: Path, final_dir: Path) -> Path:
    """将构建目录发布为 final_dir；若 final_dir 被占用则保留 build_dir。"""
    if not final_dir.exists():
        try:
            build_dir.rename(final_dir)
            return final_dir
        except Exception as exc:
            print(f'无法重命名为 {final_dir}: {exc}')
            return build_dir
    if safe_remove(final_dir):
        try:
            build_dir.rename(final_dir)
            return final_dir
        except Exception as exc:
            print(f'无法重命名为 {final_dir}: {exc}')
            return build_dir
    # 旧目录无法清理，保留本次构建目录
    print(f'旧目录 {final_dir} 被占用，本次构建保留在: {build_dir}')
    return build_dir

def download_with_progress(url, path):
    print(f'开始下载: {url}')
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=60) as resp:
        total = int(resp.headers.get('content-length', 0))
        print(f'文件大小: {total / 1024 / 1024:.1f} MB')
        downloaded = 0
        chunk_size = 1024 * 1024
        with open(path, 'wb') as f:
            while True:
                chunk = resp.read(chunk_size)
                if not chunk:
                    break
                f.write(chunk)
                downloaded += len(chunk)
                if total > 0:
                    pct = downloaded * 100 // total
                    print(f'下载进度: {downloaded / 1024 / 1024:.1f} MB / {total / 1024 / 1024:.1f} MB ({pct}%)')
    print(f'下载完成: {path}')

# 若已有完整 zip 则复用，避免重复下载
if zip_path.exists() and zip_path.stat().st_size > 0:
    print(f'复用已下载的 zip: {zip_path}')
else:
    if zip_path.exists():
        zip_path.unlink()
    download_with_progress(url, zip_path)

print('验证 zip 文件 ...')
if not zip_path.exists() or zip_path.stat().st_size == 0:
    raise RuntimeError('下载失败，zip 文件不存在或为空')

build_dist = root / 'dist' / f'DRaccoon-release-build-{int(time.time())}'
print(f'本次构建目录: {build_dist}')

print('清理并解压 ...')
if build_dist.exists():
    safe_remove(build_dist)
build_dist.mkdir(parents=True)

with zipfile.ZipFile(zip_path, 'r') as z:
    z.extractall(build_dist)

print('重命名 electron.exe -> DRaccoon.exe ...')
(build_dist / 'electron.exe').rename(build_dist / 'DRaccoon.exe')

print('复制 app/ 到 resources/app/ ...')
res_app = build_dist / 'resources' / 'app'
if res_app.exists():
    safe_remove(res_app)
shutil.copytree(root / 'app', res_app)

print('复制 dispatcher 到打包目录 ...')
dispatcher_src = root / 'scripts' / 'assets' / 'dist' / 'dispatcher'
dispatcher_dst = build_dist / 'dispatcher'
if dispatcher_dst.exists():
    safe_remove(dispatcher_dst)
if dispatcher_src.exists():
    shutil.copytree(dispatcher_src, dispatcher_dst)
    print(f'已复制 dispatcher: {dispatcher_dst}')
else:
    print(f'警告: 未找到 dispatcher 构建目录，跳过复制: {dispatcher_src}')

print('删除临时 zip ...')
zip_path.unlink()

# 原子发布到最终目录；若最终目录被占用则保留构建目录
dist = atomic_publish(build_dist, final_dist)
print(f'构建完成: {dist}')
print(f'exe 大小: {(dist / "DRaccoon.exe").stat().st_size / 1024 / 1024:.1f} MB')
