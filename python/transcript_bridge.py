"""字幕生成桥接脚本。

支持 OpenAI API 和本地 Whisper 两种模式，输出 txt/srt/vtt/json 字幕文件。
"""
from __future__ import annotations

import asyncio
import json
import os
import tempfile
from pathlib import Path
from typing import Any, Optional

import aiofiles
import aiohttp

from lib.bridge import BridgeContext, BridgeOutput, safe_main
from lib.compat import ensure_backend_path

ensure_backend_path()

from core.audio_extraction import AudioExtractError, extract_audio  # noqa: E402


SRT_TIME = lambda s: _format_srt_time(s)


def _format_srt_time(seconds: float) -> str:
    h, r = divmod(seconds, 3600)
    m, r = divmod(r, 60)
    sec = int(r)
    ms = int((r - sec) * 1000)
    return f"{int(h):02d}:{int(m):02d}:{sec:02d},{ms:03d}"


def _format_vtt_time(seconds: float) -> str:
    h, r = divmod(seconds, 3600)
    m, r = divmod(r, 60)
    sec = int(r)
    ms = int((r - sec) * 1000)
    return f"{int(h):02d}:{int(m):02d}:{sec:02d}.{ms:03d}"


def _safe_stem(stem: str) -> str:
    import re

    stem = stem.replace("\n", " ").replace("\r", " ")
    stem = re.sub(r'[<>:"/\\|?*#]', "_", stem)
    stem = re.sub(r"[\s_]+", "_", stem)
    stem = stem.strip("_ ")
    if len(stem) > 150:
        stem = stem[:150]
    return stem or "video"


def _get_converter(language: str):
    if not language or not str(language).startswith("zh"):
        return None
    try:
        from opencc import OpenCC

        return OpenCC("t2s")
    except Exception:
        return None


def _convert_text(text: str, converter) -> str:
    if converter and text:
        try:
            return converter.convert(text)
        except Exception:
            pass
    return text


def _write_txt(path: Path, segments: list[dict], converter=None) -> None:
    lines = [_convert_text(seg.get("text", "").strip(), converter) for seg in segments if seg.get("text", "").strip()]
    path.write_text("\n".join(lines), encoding="utf-8")


def _write_srt(path: Path, segments: list[dict], converter=None) -> None:
    lines: list[str] = []
    for i, seg in enumerate(segments, 1):
        text = _convert_text(seg.get("text", "").strip(), converter)
        if not text:
            continue
        lines.append(f"{i}\n{_format_srt_time(seg['start'])} --> {_format_srt_time(seg['end'])}\n{text}\n")
    path.write_text("\n".join(lines), encoding="utf-8")


def _write_vtt(path: Path, segments: list[dict], converter=None) -> None:
    lines = ["WEBVTT\n"]
    for seg in segments:
        text = _convert_text(seg.get("text", "").strip(), converter)
        if not text:
            continue
        lines.append(f"{_format_vtt_time(seg['start'])} --> {_format_vtt_time(seg['end'])}\n{text}\n")
    path.write_text("\n".join(lines), encoding="utf-8")


def _write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _mask_key(text: str, key: str) -> str:
    if not key or not text:
        return text
    return text.replace(key, "***")


async def _extract_audio(
    video_path: Path, out: BridgeOutput
) -> tuple[Path, tempfile.TemporaryDirectory]:
    out.log("正在提取音频…")
    tmpdir = tempfile.TemporaryDirectory(prefix="transcript_audio_")
    try:
        audio_path = await extract_audio(video_path, Path(tmpdir.name))
        out.log(f"音频提取完成：{audio_path.name}")
        return audio_path, tmpdir
    except AudioExtractError as exc:
        tmpdir.cleanup()
        raise RuntimeError(f"音频提取失败：{exc}") from exc


async def _transcribe_api(
    audio_path: Path,
    api_key: str,
    model: str,
    language: str,
    out: BridgeOutput,
) -> dict[str, Any]:
    out.log(f"正在调用 OpenAI 转录 API（model={model}）…")
    api_url = "https://api.openai.com/v1/audio/transcriptions"

    form = aiohttp.FormData()
    form.add_field("model", model)
    form.add_field("response_format", "verbose_json")
    if language:
        form.add_field("language", language)

    timeout = aiohttp.ClientTimeout(total=600)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        with audio_path.open("rb") as f:
            form.add_field("file", f, filename=audio_path.name, content_type="audio/mpeg")
            async with session.post(
                api_url,
                data=form,
                headers={"Authorization": f"Bearer {api_key}"},
            ) as response:
                body = await response.text()
                if response.status != 200:
                    body = _mask_key(body, api_key)
                    raise RuntimeError(f"API 请求失败：status={response.status}, body={body}")
                payload = json.loads(body)
                if not isinstance(payload, dict):
                    raise RuntimeError("API 返回格式异常")
                return payload


async def _transcribe_local(audio_path: Path, model_name: str, language: str, out: BridgeOutput) -> dict[str, Any]:
    try:
        import whisper
    except ImportError as exc:
        raise RuntimeError("本地模式需要 openai-whisper，请执行 pip install openai-whisper") from exc

    valid_models = {"tiny", "base", "small", "medium", "large"}
    if model_name not in valid_models:
        out.log(f"模型名 '{model_name}' 不是标准 Whisper 模型，回退到 base", level="warning")
        model_name = "base"

    out.log(f"正在加载 Whisper 模型：{model_name}（首次加载可能较慢）…")
    model = await asyncio.to_thread(whisper.load_model, model_name)
    out.log("模型加载完成，开始识别…")
    result = await asyncio.to_thread(
        model.transcribe, str(audio_path), language=language or None, verbose=False
    )
    return result


def _write_outputs(
    video_path: Path,
    payload: dict[str, Any],
    formats: list[str],
    converter,
    out: BridgeOutput,
) -> list[Path]:
    output_dir = video_path.parent
    stem = _safe_stem(video_path.stem)
    segments = payload.get("segments") or []

    outputs: list[Path] = []
    for fmt in formats:
        fmt = str(fmt).strip().lower()
        if fmt == "txt":
            path = output_dir / f"{stem}.transcript.txt"
            _write_txt(path, segments, converter)
            outputs.append(path)
        elif fmt == "srt":
            path = output_dir / f"{stem}.transcript.srt"
            _write_srt(path, segments, converter)
            outputs.append(path)
        elif fmt == "vtt":
            path = output_dir / f"{stem}.transcript.vtt"
            _write_vtt(path, segments, converter)
            outputs.append(path)
        elif fmt == "json":
            path = output_dir / f"{stem}.transcript.json"
            _write_json(path, payload)
            outputs.append(path)
        else:
            out.log(f"忽略未知输出格式：{fmt}", level="warning")

    return outputs


async def _run(ctx: BridgeContext, job: dict[str, Any], out: BridgeOutput) -> None:
    video_path_str = job.get("videoPath")
    if not video_path_str:
        raise ValueError("videoPath 为空")
    video_path = Path(video_path_str)
    if not video_path.exists():
        raise ValueError(f"视频不存在：{video_path}")

    mode = str(job.get("mode") or "api").strip().lower()
    api_key = str(job.get("apiKey") or "").strip()
    model = str(job.get("model") or "gpt-4o-mini-transcribe").strip()
    formats = job.get("formats") or ["txt"]
    language = str(job.get("language") or "").strip()

    converter = _get_converter(language)

    out.log(f"开始生成字幕：{video_path.name}，模式={mode}")
    audio_tmpdir: Optional[tempfile.TemporaryDirectory] = None
    tmpdir: Optional[tempfile.TemporaryDirectory] = None
    try:
        audio_path, audio_tmpdir = await _extract_audio(video_path, out)
        tmpdir = tempfile.TemporaryDirectory(prefix="transcript_")
        # 将音频复制到临时目录，避免路径含特殊字符导致上传/识别失败
        tmp_audio = Path(tmpdir.name) / audio_path.name
        tmp_audio.write_bytes(audio_path.read_bytes())

        if mode == "api":
            if not api_key:
                raise ValueError("API 模式需要填写 apiKey")
            payload = await _transcribe_api(tmp_audio, api_key, model, language, out)
        elif mode == "local":
            payload = await _transcribe_local(tmp_audio, model, language, out)
        else:
            raise ValueError(f"不支持的转录模式：{mode}")

        out.log("识别完成，正在写入字幕文件…")
        outputs = _write_outputs(video_path, payload, formats, converter, out)
        out.finished(success=True, data={"outputs": [str(p) for p in outputs]})
    finally:
        if tmpdir is not None:
            tmpdir.cleanup()
        if audio_tmpdir is not None:
            audio_tmpdir.cleanup()


def main(ctx: BridgeContext, job: dict[str, Any], out: BridgeOutput) -> None:
    try:
        asyncio.run(_run(ctx, job, out))
    except Exception as exc:
        # 避免 API key 出现在错误信息中
        msg = _mask_key(str(exc), str(job.get("apiKey") or ""))
        out.error(msg)


if __name__ == "__main__":
    safe_main(main)
