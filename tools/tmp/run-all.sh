#!/bin/bash
# 全量回归：每个套件独立跑，输出通过数
cd "$(dirname "$0")/../.."
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
pkill -f "whisper notes/node_modules/electron" 2>/dev/null; sleep 1
pgrep -f "fake-llm.mjs" >/dev/null || (node tools/tmp/fake-llm.mjs 8799 > /tmp/fake-llm.log 2>&1 &)
sleep 1
# 隔离环境引导配置：/tmp/wn-devdata 的 config.json 必须把 dataParent 指向 /tmp/wn-devbase（里面有 26 篇笔记/23 篇转写）。
# 某些套件/异常退出会把它改回默认，导致后续套件在"空库"上跑出一堆假失败 → 每个套件前都恢复一次。
restore_bootstrap() {
  python3 - <<'PYEOF'
import json, os
boot = '/tmp/wn-devdata/config.json'
base = '/tmp/wn-devbase/whisper-notes/config.json'
os.makedirs(os.path.dirname(boot), exist_ok=True)
os.makedirs(os.path.dirname(base), exist_ok=True)
# ① 引导配置：userData 里的 config 指向 base（真正的数据目录）
try:
    c = json.load(open(boot)) if os.path.exists(boot) else {}
except Exception:
    c = {}
c.setdefault('storage', {})['dataParent'] = '/tmp/wn-devbase'
c.setdefault('storage', {}).setdefault('recordingsParent', '')
c.setdefault('ui', {})['language'] = 'zh'
json.dump(c, open(boot, 'w'), ensure_ascii=False, indent=2)
# ② base 配置：缺了就补一份指向本地假模型（否则各套件会打真上游/空渠道，出卡永远 0 张）
if not os.path.exists(base):
    json.dump({
        'storage': {'recordingsParent': '', 'dataParent': ''},
        'ui': {'language': 'zh'},
        'llm': {
            'baseUrl': 'http://127.0.0.1:8799/v1', 'apiKey': 'fake-key', 'modelId': 'fake-model',
            'maxChunkChars': 14000, 'maxOutputTokens': 16384, 'templateId': 'study', 'customTemplate': '',
            'autoFallback': False, 'fallbackModels': [],
            'providers': [{'id': 'fake', 'name': 'Fake', 'baseUrl': 'http://127.0.0.1:8799/v1', 'apiKey': 'fake-key', 'modelId': 'fake-model', 'enabled': True}],
            'activeProviderId': 'fake',
        },
    }, open(base, 'w'), ensure_ascii=False, indent=2)
PYEOF
}
restore_bootstrap
run() {
  local name="$1"; shift
  restore_bootstrap
  local out
  out=$("$@" 2>&1)
  local line
  line=$(echo "$out" | grep -E "^结果:" | tail -1)
  local fails
  fails=$(echo "$out" | grep -c "^❌")
  if [ -z "$line" ]; then line="(无结果行, 失败标记=$fails)"; fi
  printf "%-22s %s\n" "$name" "$line"
  echo "$out" | grep "^❌" | head -3 | sed 's/^/    /'
  pkill -f "whisper notes/node_modules/electron" 2>/dev/null; sleep 1
  rm -rf /tmp/wn-phone   # 每套手机测试都在干净的本地存储上跑
}
echo "===== 全量回归 $(date '+%H:%M:%S') ====="
run "桌面:局域网服务"   node tools/tmp/mobile-check.mjs
run "手机:只读浏览"     node tools/tmp/mobile-ui-check.mjs
node tools/tmp/reset-fake-llm.mjs >/dev/null
node tools/tmp/reset-fake-llm.mjs >/dev/null
run "桌面:闪卡"         node tools/tmp/cards-check.mjs
run "桌面:出卡系统"     node tools/tmp/cardsys-check.mjs
run "手机:闪卡复习"     node tools/tmp/cards-mobile-check.mjs
run "桌面:未完成笔记"   node tools/tmp/incomplete-check.mjs
run "桌面:整理健壮性"   node tools/tmp/orgfix-check.mjs
run "桌面:断点续做"     node tools/tmp/resume-check.mjs
run "桌面:拖入文件"     node tools/tmp/dropfile-check.mjs
run "桌面:文档转笔记"   node tools/tmp/docnote-check.mjs
run "桌面:生成增强版"   node tools/tmp/polish-check.mjs
run "桌面:窄列不出界"   node tools/tmp/narrowbar-check.mjs
run "手机:同步修复"     node tools/tmp/syncfix-check.mjs
run "手机:按钮出框审计" node tools/tmp/phone-overflow-check.mjs
node tools/tmp/coverage-unit.mjs 2>/dev/null || (cd "$(dirname "$0")/../.." && ./node_modules/.bin/esbuild tools/tmp/coverage-unit.ts --bundle --platform=node --format=esm --outfile=/tmp/coverage-unit.mjs --log-level=error && node /tmp/coverage-unit.mjs > /tmp/cov.log 2>&1; tail -1 /tmp/cov.log | sed 's/^/纯函数:完整性地板         /')
node tools/tmp/drop-unit.mjs 2>/dev/null || (cd "$(dirname "$0")/../.." && ./node_modules/.bin/esbuild tools/tmp/drop-unit.ts --bundle --platform=node --format=esm --outfile=/tmp/drop-unit.mjs --log-level=error && node /tmp/drop-unit.mjs > /tmp/drop.log 2>&1; tail -1 /tmp/drop.log | sed 's/^/纯函数:拖入决策           /')
node tools/tmp/assemble-unit.mjs 2>/dev/null || (cd "$(dirname "$0")/../.." && ./node_modules/.bin/esbuild tools/tmp/assemble-unit.ts --bundle --platform=node --format=esm --outfile=/tmp/assemble-unit.mjs --log-level=error && node /tmp/assemble-unit.mjs > /tmp/asm.log 2>&1; tail -1 /tmp/asm.log | sed 's/^/纯函数:分段拼接         /')
run "桌面:渠道/改名/荧光" node tools/tmp/ui-check.mjs
run "子窗:同步改名"     node tools/tmp/child-check.mjs
node tools/tmp/reset-fake-llm.mjs >/dev/null
run "闪卡:分类(桌面)"   node tools/tmp/cards-scope-check.mjs
run "闪卡:分类(手机)"   node tools/tmp/phone-scope-check.mjs
run "手机:界面一致性"   node tools/tmp/phone-ui-check.mjs
run "手机:缩放/点击"    node tools/tmp/zoombug-check.mjs
run "桌面:APK直传版本"  node tools/tmp/apk-serve-check.mjs
run "手机:离线可用性"   node tools/tmp/phone-offline-check.mjs
restore_bootstrap
echo "===== 完成 $(date '+%H:%M:%S') ====="
