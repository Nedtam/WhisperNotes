#!/usr/bin/env bash
# WhisperNotes 转写引擎准备脚本（macOS）
# 1) 确保 whisper-server 可用  2) 可选：直接下载模型到应用模型目录
set -euo pipefail

BIN="${WHISPER_SERVER:-}"

find_bin() {
  if [[ -n "$BIN" && -x "$BIN" ]]; then echo "$BIN"; return 0; fi
  for c in \
    /opt/homebrew/opt/whisper-cpp/bin/whisper-server \
    /opt/homebrew/bin/whisper-server \
    /usr/local/bin/whisper-server; do
    if [[ -x "$c" ]]; then echo "$c"; return 0; fi
  done
  local w
  w="$(command -v whisper-server 2>/dev/null || true)"
  if [[ -n "$w" ]]; then echo "$w"; return 0; fi
  return 1
}

echo "==> 查找 whisper-server"
if W="$(find_bin)"; then
  echo "    找到: $W"
else
  echo "    未找到。尝试 brew 安装 whisper-cpp ..."
  brew install whisper-cpp
  W="$(find_bin)"
  echo "    已安装: $W"
fi

# 模型下载（可选）
URL_MODEL="${1:-}"
if [[ -n "$URL_MODEL" ]]; then
  MODELS_DIR="${MODELS_DIR:-$HOME/Library/Application Support/WhisperNotes/models}"
  FILE="$(basename "$URL_MODEL")"
  mkdir -p "$MODELS_DIR"
  if [[ -f "$MODELS_DIR/$FILE" && $(stat -f%z "$MODELS_DIR/$FILE") -gt 1000000 ]]; then
    echo "==> 模型已存在: $MODELS_DIR/$FILE"
  else
    echo "==> 下载模型 -> $MODELS_DIR/$FILE"
    curl -fL --progress-bar -o "$MODELS_DIR/$FILE.part" "$URL_MODEL"
    mv "$MODELS_DIR/$FILE.part" "$MODELS_DIR/$FILE"
  fi
else
  cat <<'EOF'
==> 未指定模型 URL。可在应用内「设置 → 转写模型」下载，或手动执行：
    npm run setup:whisper -- \
      https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
EOF
fi
echo "==> 完成"
