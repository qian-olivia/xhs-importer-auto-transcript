#!/usr/bin/env python3
"""Write a Xiaohongshu video's transcript into its xhs-importer Markdown note."""

from __future__ import annotations

import argparse
import json
import os
import re
import tempfile
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

START = "<!-- xhs-video-transcript:start -->"
END = "<!-- xhs-video-transcript:end -->"
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36"
MODEL = "mlx-community/whisper-large-v3-turbo"


def allowed_url(value: str) -> str:
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password or parsed.port:
        raise ValueError("媒体地址必须是 HTTP(S) 小红书地址")
    if not any(host == domain or host.endswith("." + domain)
               for domain in ("xiaohongshu.com", "xhscdn.com")):
        raise ValueError("媒体地址不是小红书域名")
    return parsed._replace(scheme="https").geturl()


def inputs_from_note(text: str) -> tuple[list[str], str | None]:
    match = re.search(r"<!-- xhs-transcript-data (\{[^\n]*\}) -->", text)
    subtitles: list[str] = []
    video_url = None
    if match:
        data = json.loads(match.group(1))
        subtitles = [item["url"] for item in data.get("subtitleUrls", [])
                     if isinstance(item, dict) and isinstance(item.get("url"), str)]
        video_url = data.get("videoUrl")
    if not video_url:
        link = re.search(r"\[Video Link\]\((https?://[^)]+)\)", text)
        video_url = link.group(1) if link else None
    return subtitles, video_url


def fetch_bytes(url: str, limit: int) -> bytes:
    url = allowed_url(url)
    request = urllib.request.Request(
        url, headers={"User-Agent": USER_AGENT, "Referer": "https://www.xiaohongshu.com/"}
    )
    with urllib.request.urlopen(request, timeout=40) as response:
        allowed_url(response.geturl())
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError("媒体文件超过大小上限")
    return data


def download_video(url: str, destination: Path, limit: int = 1024 * 1024 * 1024) -> None:
    url = allowed_url(url)
    request = urllib.request.Request(
        url, headers={"User-Agent": USER_AGENT, "Referer": "https://www.xiaohongshu.com/"}
    )
    written = 0
    with urllib.request.urlopen(request, timeout=40) as response:
        allowed_url(response.geturl())
        with destination.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                written += len(chunk)
                if written > limit:
                    raise ValueError("视频超过 1 GB 大小上限")
                output.write(chunk)
    if written == 0:
        raise ValueError("下载到的视频为空")


def parse_subtitles(raw: bytes) -> str:
    text = raw.decode("utf-8-sig", errors="replace").replace("\r\n", "\n")
    if not re.search(r"\d\d:\d\d:\d\d[,.]\d+\s*-->", text):
        return ""
    text = re.sub(r"<[^>]+>", "", text)
    lines: list[str] = []
    for line in text.splitlines():
        value = line.strip()
        if not value or value == "WEBVTT" or value.isdigit() or "-->" in value:
            continue
        if value != (lines[-1] if lines else None):
            lines.append(value)
    return "\n".join(lines).strip()


def transcribe_video(url: str) -> str:
    try:
        import imageio_ffmpeg
        import mlx_whisper
    except ImportError as exc:
        raise RuntimeError("缺少本地转录依赖：mlx-whisper 和 imageio-ffmpeg") from exc
    with tempfile.TemporaryDirectory(prefix="xhs-video-") as temp:
        temporary = Path(temp)
        bindir = temporary / "bin"
        bindir.mkdir()
        (bindir / "ffmpeg").symlink_to(imageio_ffmpeg.get_ffmpeg_exe())
        os.environ["PATH"] = str(bindir) + os.pathsep + os.environ.get("PATH", "")
        video = temporary / "source.mp4"
        download_video(url, video)
        result = mlx_whisper.transcribe(str(video), path_or_hf_repo=MODEL, language="zh")
        transcript = str(result.get("text") or "").strip()
        if not transcript:
            raise RuntimeError("语音识别返回空文稿")
        return transcript


def update_note(text: str, transcript: str, method: str) -> str:
    block = f"{START}\n## 视频文稿\n\n来源：{method}\n\n{transcript.strip()}\n{END}"
    if START in text or END in text:
        if text.count(START) != 1 or text.count(END) != 1:
            raise ValueError("原笔记的视频文稿边界不完整，未覆盖")
        return re.sub(re.escape(START) + r".*?" + re.escape(END),
                      lambda _match: block, text, count=1, flags=re.S)
    return text.rstrip() + "\n\n" + block + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--vault", required=True, type=Path)
    parser.add_argument("--note", required=True, type=Path)
    parser.add_argument("--stdout", action="store_true")
    args = parser.parse_args()
    vault = args.vault.expanduser().resolve()
    note = args.note.expanduser().resolve()
    settings = json.loads((vault / ".obsidian/plugins/xhs-importer/data.json").read_text())
    folder = (vault / settings["noteFolder"]).resolve()
    if note.parent != folder or not note.is_file():
        raise SystemExit("笔记不在 xhs-importer 当前设置的默认笔记文件夹中")
    before = note.read_text(encoding="utf-8")
    subtitles, video_url = inputs_from_note(before)
    if not subtitles and not video_url:
        raise SystemExit("这篇笔记没有视频链接或字幕信息")
    transcript = ""
    method = ""
    for subtitle_url in subtitles:
        try:
            transcript = parse_subtitles(fetch_bytes(subtitle_url, 20 * 1024 * 1024))
            if transcript:
                method = "小红书平台字幕"
                break
        except (OSError, ValueError):
            continue
    if not transcript:
        if not video_url:
            raise SystemExit("平台字幕不可用，且笔记没有可下载的视频链接")
        try:
            transcript = transcribe_video(video_url)
            method = "本地语音转录"
        except (OSError, ValueError, RuntimeError) as exc:
            raise SystemExit("无法生成视频文稿：" + str(exc)) from exc
    if args.stdout:
        print("XHS_TRANSCRIPT_JSON:" + json.dumps(
            {"method": method, "transcript": transcript}, ensure_ascii=False))
        return 0
    if note.read_text(encoding="utf-8") != before:
        raise SystemExit("处理期间笔记发生变化，未覆盖")
    after = update_note(before, transcript, method)
    temporary = note.with_name(note.name + ".transcript-tmp")
    try:
        temporary.write_text(after, encoding="utf-8")
        os.replace(temporary, note)
    finally:
        temporary.unlink(missing_ok=True)
    print(json.dumps({"note": str(note), "method": method, "characters": len(transcript)},
                     ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
