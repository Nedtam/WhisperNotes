#!/usr/bin/env bash
# Ad-hoc 深度签名（无 Developer ID 证书时的保底方案）
# 顺序很重要：先签所有内层可执行文件/dylib，最后签外层 .app；--deep 已被 Apple 标记为不推荐，这里不用它。
set -euo pipefail
APP="${1:-$(ls -d release/mac-*/WhisperNotes.app | head -1)}"
[ -d "$APP" ] || { echo "找不到 app: $APP"; exit 1; }

echo "== 签内层二进制与 dylib =="
find "$APP/Contents/Resources/native" -type f \( -name '*.dylib' -o -perm -u+x \) -print0 2>/dev/null \
  | xargs -0 -I{} codesign --force --timestamp=none -s - {} || true

echo "== 签外层 app =="
codesign --force --timestamp=none -s - "$APP"
codesign --verify --strict "$APP" && echo "签名校验通过（ad-hoc）"
echo "注意：ad-hoc 签名不等于公证，其他 Mac 首次打开需按 README「Gatekeeper」一节操作。"
