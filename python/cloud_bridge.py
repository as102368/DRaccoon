"""云端配置同步桥接脚本。

支持 S3 兼容存储与阿里云 OSS，备份时生成随机 Fernet token 加密配置与数据库，
恢复时凭同一 token 下载解密。
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

from lib.bridge import BridgeContext, BridgeOutput, safe_main


BACKUP_KEY_PREFIX = "douzy-backup"


def _object_key(token: str) -> str:
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()[:16]
    return f"{BACKUP_KEY_PREFIX}/{token_hash}/backup.enc"


def _validate_credentials(credentials: dict[str, Any]) -> dict[str, str]:
    access_key_id = str(credentials.get("accessKeyId") or "").strip()
    access_key_secret = str(credentials.get("accessKeySecret") or "").strip()
    bucket = str(credentials.get("bucket") or "").strip()
    region = str(credentials.get("region") or "").strip()
    endpoint = str(credentials.get("endpoint") or "").strip()

    if not access_key_id or not access_key_secret:
        raise ValueError("AccessKeyId 和 AccessKeySecret 不能为空")
    if not bucket:
        raise ValueError("Bucket 不能为空")

    return {
        "access_key_id": access_key_id,
        "access_key_secret": access_key_secret,
        "bucket": bucket,
        "region": region,
        "endpoint": endpoint,
    }


def _read_file_b64(path: str) -> tuple[str, str] | None:
    p = Path(path)
    if not p.exists():
        return None
    name = p.name
    content = p.read_bytes()
    return name, base64.b64encode(content).decode("utf-8")


def _upload_s3(key: str, data: bytes, creds: dict[str, str], out: BridgeOutput) -> None:
    import boto3
    from botocore.exceptions import ClientError

    kwargs: dict[str, Any] = {
        "aws_access_key_id": creds["access_key_id"],
        "aws_secret_access_key": creds["access_key_secret"],
    }
    if creds["region"]:
        kwargs["region_name"] = creds["region"]
    if creds["endpoint"]:
        kwargs["endpoint_url"] = creds["endpoint"]

    client = boto3.client("s3", **kwargs)
    try:
        client.put_object(Bucket=creds["bucket"], Key=key, Body=data)
    except ClientError as exc:
        raise RuntimeError(f"S3 上传失败：{exc}") from exc


def _upload_oss(key: str, data: bytes, creds: dict[str, str], out: BridgeOutput) -> None:
    import oss2

    auth = oss2.Auth(creds["access_key_id"], creds["access_key_secret"])
    if not creds["endpoint"]:
        raise ValueError("OSS 必须提供 endpoint")
    bucket = oss2.Bucket(auth, creds["endpoint"], creds["bucket"])
    try:
        bucket.put_object(key, data)
    except oss2.exceptions.OssError as exc:
        raise RuntimeError(f"OSS 上传失败：{exc}") from exc


def _download_s3(key: str, creds: dict[str, str], out: BridgeOutput) -> bytes:
    import boto3
    from botocore.exceptions import ClientError

    kwargs: dict[str, Any] = {
        "aws_access_key_id": creds["access_key_id"],
        "aws_secret_access_key": creds["access_key_secret"],
    }
    if creds["region"]:
        kwargs["region_name"] = creds["region"]
    if creds["endpoint"]:
        kwargs["endpoint_url"] = creds["endpoint"]

    client = boto3.client("s3", **kwargs)
    try:
        response = client.get_object(Bucket=creds["bucket"], Key=key)
        return response["Body"].read()
    except ClientError as exc:
        raise RuntimeError(f"S3 下载失败：{exc}") from exc


def _download_oss(key: str, creds: dict[str, str], out: BridgeOutput) -> bytes:
    import oss2

    auth = oss2.Auth(creds["access_key_id"], creds["access_key_secret"])
    if not creds["endpoint"]:
        raise ValueError("OSS 必须提供 endpoint")
    bucket = oss2.Bucket(auth, creds["endpoint"], creds["bucket"])
    try:
        return bucket.get_object(key).read()
    except oss2.exceptions.OssError as exc:
        raise RuntimeError(f"OSS 下载失败：{exc}") from exc


def _upload(provider: str, key: str, data: bytes, creds: dict[str, str], out: BridgeOutput) -> None:
    out.log(f"正在上传加密备份到 {provider.upper()}…")
    if provider == "s3":
        _upload_s3(key, data, creds, out)
    elif provider == "oss":
        _upload_oss(key, data, creds, out)
    else:
        raise ValueError(f"不支持的云存储 provider：{provider}")


def _download(provider: str, key: str, creds: dict[str, str], out: BridgeOutput) -> bytes:
    out.log(f"正在从 {provider.upper()} 下载加密备份…")
    if provider == "s3":
        return _download_s3(key, creds, out)
    elif provider == "oss":
        return _download_oss(key, creds, out)
    else:
        raise ValueError(f"不支持的云存储 provider：{provider}")


def _backup(ctx: BridgeContext, job: dict[str, Any], out: BridgeOutput) -> None:
    provider = str(job.get("provider") or "").strip().lower()
    if provider not in {"s3", "oss"}:
        raise ValueError("provider 必须是 s3 或 oss")

    creds = _validate_credentials(job.get("credentials") or {})

    files_to_backup: list[tuple[str, str]] = []  # (canonical_name, path)
    config_path = str(job.get("configPath") or "").strip()
    db_path = str(job.get("dbPath") or "").strip()
    cookie_path = str(job.get("cookiePath") or "").strip()

    if config_path:
        files_to_backup.append(("settings.json", config_path))
    if db_path:
        files_to_backup.append(("dy_downloader.db", db_path))
    if cookie_path:
        files_to_backup.append(("cookies.txt", cookie_path))

    if not files_to_backup:
        raise ValueError("没有可备份的文件（configPath/dbPath 都为空）")

    manifest: list[dict[str, str]] = []
    for canonical_name, path in files_to_backup:
        result = _read_file_b64(path)
        if result is None:
            out.log(f"跳过不存在的文件：{path}", level="warning")
            continue
        filename, content_b64 = result
        manifest.append({
            "name": canonical_name,
            "filename": filename,
            "content_b64": content_b64,
        })

    if not manifest:
        raise ValueError("所有待备份文件都不存在")

    token = Fernet.generate_key().decode("utf-8")
    fernet = Fernet(token.encode("utf-8"))
    encrypted = fernet.encrypt(json.dumps(manifest).encode("utf-8"))

    key = _object_key(token)
    _upload(provider, key, encrypted, creds, out)

    out.log("备份完成，请妥善保存恢复 Token")
    # token 只在 finished 中返回一次，避免写入普通日志
    out.finished(success=True, data={"token": token})


def _restore(ctx: BridgeContext, job: dict[str, Any], out: BridgeOutput) -> None:
    provider = str(job.get("provider") or "").strip().lower()
    if provider not in {"s3", "oss"}:
        raise ValueError("provider 必须是 s3 或 oss")

    creds = _validate_credentials(job.get("credentials") or {})
    token = str(job.get("token") or "").strip()
    if not token:
        raise ValueError("恢复 Token 不能为空")

    try:
        fernet = Fernet(token.encode("utf-8"))
    except ValueError as exc:
        raise ValueError("Token 格式无效") from exc

    output_dir = str(job.get("outputDir") or "").strip()
    db_path = str(job.get("dbPath") or "").strip()
    settings_path = str(job.get("settingsPath") or "").strip()

    key = _object_key(token)
    encrypted = _download(provider, key, creds, out)

    try:
        decrypted = fernet.decrypt(encrypted)
    except InvalidToken as exc:
        raise ValueError("Token 错误 or 备份数据已损坏") from exc

    manifest = json.loads(decrypted.decode("utf-8"))
    restored: list[str] = []

    for item in manifest:
        name = item.get("name")
        content = base64.b64decode(item.get("content_b64", ""))

        if name == "settings.json":
            target = settings_path or (Path(output_dir) / "settings.json" if output_dir else "")
        elif name == "dy_downloader.db":
            target = db_path or (Path(output_dir) / "dy_downloader.db" if output_dir else "")
        elif name == "cookies.txt":
            target = str(Path(output_dir) / item.get("filename", "cookies.txt")) if output_dir else ""
        else:
            target = str(Path(output_dir) / item.get("filename", name)) if output_dir else ""

        if not target:
            out.log(f"无法确定 {name} 的恢复路径，跳过", level="warning")
            continue

        target_path = Path(target)
        target_path.parent.mkdir(parents=True, exist_ok=True)
        target_path.write_bytes(content)
        restored.append(str(target_path.resolve()))
        out.log(f"已恢复：{target_path.name}")

    out.finished(success=True, data={"restored_files": restored})


def main(ctx: BridgeContext, job: dict[str, Any], out: BridgeOutput) -> None:
    task_type = job.get("task_type")
    if task_type == "cloud_backup":
        _backup(ctx, job, out)
    elif task_type == "cloud_restore":
        _restore(ctx, job, out)
    else:
        raise ValueError(f"不支持的 cloud task_type：{task_type}")


if __name__ == "__main__":
    safe_main(main)
