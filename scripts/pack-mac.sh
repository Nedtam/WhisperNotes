#!/usr/bin/env bash
# 本地打 macOS 包（Apple Silicon）：build → electron-builder → ad-hoc 深签名 → DMG + zip
# 用法：bash scripts/pack-mac.sh   （产物在 release/）
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 0/5 同步安卓包（桌面 App 局域网直传的那份）=="
bash scripts/sync-apk.sh

echo "== 1/5 构建 =="
npm run build

echo "== 2/5 electron-builder（不签名，稍后统一 ad-hoc 签）=="
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64

APP="$(ls -d release/mac-*/WhisperNotes.app | head -1)"
[ -d "$APP" ] || { echo "找不到 app: $APP"; exit 1; }

echo "== 3/5 ad-hoc 深签名（先内层再外层；不带 hardened runtime，否则 Electron 框架会因 Team ID 不同而加载失败）=="
find "$APP/Contents/Resources/native" -type f \( -name '*.dylib' -o -perm -u+x \) -print0 2>/dev/null \
  | xargs -0 -I{} codesign --force --timestamp=none -s - {} 2>/dev/null || true
codesign --force --timestamp=none -s - "$APP"
codesign --verify --strict "$APP" && echo "   签名校验通过"

echo "== 4/5 生成 DMG（含 Applications 拖拽链接）=="
VER="$(node -p "require('./package.json').version")"
rm -rf release/dmgst && mkdir -p release/dmgst
cp -R "$APP" release/dmgst/
ln -sf /Applications release/dmgst/Applications
rm -f "release/WhisperNotes-$VER-arm64.dmg"
hdiutil create -volname WhisperNotes -srcfolder release/dmgst -ov -format UDZO "release/WhisperNotes-$VER-arm64.dmg" >/dev/null

echo "== 5/5 生成 zip =="
rm -f "release/WhisperNotes-$VER-arm64-mac.zip"
ditto -c -k --sequesterRsrc --keepParent "$APP" "release/WhisperNotes-$VER-arm64-mac.zip"

ls -lh "release/WhisperNotes-$VER-arm64.dmg" "release/WhisperNotes-$VER-arm64-mac.zip"
echo "完成。"
