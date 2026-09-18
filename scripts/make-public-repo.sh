#!/usr/bin/env bash
# 生成一个「干净历史」的公开仓库副本：只包含源码与引擎，不含课程录音/课件 PDF/导出笔记，
# 也不含旧历史里那些大文件（例如 150MB 的 SYE2066-1.m4a）。
#
# 用法：bash scripts/make-public-repo.sh [目标目录]
#   默认目标：../whisper-notes-public
# 之后：cd 目标目录 && git remote add origin <你的仓库> && git push -u origin main
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DST="${1:-$(dirname "$SRC")/whisper-notes-public}"

echo "源仓库: $SRC"
echo "目标:   $DST"
[ -e "$DST" ] && { echo "目标已存在，请先删除或换一个路径"; exit 1; }

mkdir -p "$DST"
cd "$SRC"
# 只导出「当前磁盘上真实存在、且未被忽略」的文件；
# 再显式剔除用户材料（即使它们曾被 git 跟踪、或被 .gitignore 之外的规则漏掉）
git ls-files -z --cached --others --exclude-standard \
  | while IFS= read -r -d '' f; do
      [ -f "$f" ] || continue
      case "$f" in
        *.m4a|*.mp3|*.wav|*.pdf|SYE*|SN+*|*+SYE*|qa-shots/*|*.part) continue ;;
      esac
      printf '%s\0' "$f"
    done \
  | tar --null -T - -cf - | (cd "$DST" && tar xf -)

cd "$DST"
git init -q -b main
git add -A
git -c user.name="$(git -C "$SRC" config user.name || echo whisper-notes)" \
    -c user.email="$(git -C "$SRC" config user.email || echo whisper-notes@example.com)" \
    commit -q -m "Initial public release: WhisperNotes"
echo
echo "完成。检查一下有没有不该有的东西："
echo "  du -sh \"$DST\""
echo "  find \"$DST\" -size +30M -not -path '*/.git/*'"
echo
echo "下一步："
echo "  cd \"$DST\" && git remote add origin <你的仓库地址> && git push -u origin main"
