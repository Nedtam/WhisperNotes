#!/usr/bin/env bash
# 公证 + staple（需要 Apple Developer 账号：Developer ID 证书 + App 专用密码）
# 所需环境变量：APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID
set -euo pipefail
APP="${1:-$(ls -d release/mac-*/WhisperNotes.app | head -1)}"
DMG="$(ls release/*.dmg | head -1 || true)"
[ -d "$APP" ] || { echo "找不到 app: $APP"; exit 1; }
: "${APPLE_ID:?需要 APPLE_ID}" ; : "${APPLE_APP_SPECIFIC_PASSWORD:?需要 APPLE_APP_SPECIFIC_PASSWORD}" ; : "${APPLE_TEAM_ID:?需要 APPLE_TEAM_ID}"

ZIP=/tmp/WhisperNotes-notarize.zip
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

echo "== 提交公证（app）=="
xcrun notarytool submit "$ZIP" --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
xcrun stapler staple "$APP"

if [ -n "${DMG:-}" ]; then
  echo "== 重新生成并公证 DMG =="
  xcrun stapler staple "$DMG" || true
fi
echo "公证完成：其他 Mac 可直接双击打开。"
