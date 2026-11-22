#!/usr/bin/env bash
# 把刚构建好的安卓包同步到"打包时会带进 App 的那份"。
# 教训（2026-11）：只更新 release/ 里那份没用 —— 桌面 App 局域网下载的 APK 是从
# native/android/ 打进 bundle 的，漏同步就会一直发旧版本。
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="mobile/android/app/build/outputs/apk/release/app-release.apk"
DST_BUNDLE="native/android/WhisperNotes-android.apk"
DST_RELEASE="release/WhisperNotes-android.apk"

if [ ! -f "$SRC" ]; then
  echo "⚠️  没找到 $SRC（先跑：cd mobile && npm run sync && cd android && ./gradlew assembleRelease）"
  echo "   继续用现有的 $DST_BUNDLE"
  exit 0
fi

mkdir -p native/android release
cp -f "$SRC" "$DST_BUNDLE"
cp -f "$SRC" "$DST_RELEASE"

AAPT="$(ls -d "$HOME"/Library/Android/sdk/build-tools/*/aapt 2>/dev/null | tail -1 || true)"
if [ -n "$AAPT" ] && [ -x "$AAPT" ]; then
  echo "== APK 版本 =="
  "$AAPT" dump badging "$DST_BUNDLE" 2>/dev/null | head -1
fi
shasum -a 256 "$DST_BUNDLE" "$DST_RELEASE" | awk '{print "  " $1 "  " $2}'
echo "已同步到 native/android（会打进 App bundle）与 release/"
