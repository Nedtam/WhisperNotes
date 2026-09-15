#!/usr/bin/env bash
# 下载 Windows 版 ffmpeg.exe 到 native/win/bin/（用于导入 m4a/mp3 等压缩音频的解码）
#
# 为什么不在仓库里带这个文件：ffmpeg 静态构建约 83MB，接近 GitHub 单文件 100MB 硬限制，
# 放进仓库会让 clone 变慢、也容易触发推送失败。CI 与本地构建时按需下载即可。
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)/native/win/bin"
OUT="$DIR/ffmpeg.exe"
URL="${WN_FFMPEG_WIN_URL:-https://github.com/eugeneware/ffmpeg-static/releases/latest/download/ffmpeg-win32-x64}"

mkdir -p "$DIR"
if [ -f "$OUT" ] && [ "$(stat -f%z "$OUT" 2>/dev/null || stat -c%s "$OUT")" -gt 10000000 ]; then
  echo "已存在：$OUT（跳过下载）"
  exit 0
fi
echo "下载 Windows ffmpeg → $OUT"
curl -fL --retry 3 -o "$OUT" "$URL"
chmod +x "$OUT" 2>/dev/null || true
echo "完成：$(du -h "$OUT" | cut -f1)"
