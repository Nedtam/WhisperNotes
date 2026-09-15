# WhisperNotes

**Local-first lecture recorder → on-device transcription → AI-organized notes.**
Record a class, get a live transcript from a local whisper.cpp engine (audio never leaves your machine), then turn that transcript into structured Markdown notes with your own model.

**本地优先的课堂录音 → 本地转写 → AI 整理成笔记。** 录音在本机用 whisper.cpp 实时转写，音频不出本机；再用你自己的模型把转写整理成结构化笔记。

<p align="center">
  <img src="build/icon.png" width="120" alt="WhisperNotes" />
</p>

---

## Contents / 目录

- [English](#english) — [Features](#features) · [Requirements](#requirements) · [Download & install](#download--install) · [First run](#first-run) · [How it works](#how-it-works) · [Privacy](#privacy) · [Build from source](#build-from-source) · [Releasing](#releasing) · [Settings](#settings-worth-knowing) · [Troubleshooting](#troubleshooting) · [License](#license--credits)
- [中文说明](#中文说明) — [简介](#简介) · [环境要求](#环境要求) · [下载与安装](#下载与安装) · [首次运行](#首次运行) · [运行方式（源码）](#运行方式源码) · [发布流程](#发布流程) · [值得注意的设置](#值得注意的设置) · [常见问题](#常见问题) · [许可与致谢](#许可与致谢)

---

# English

## Features

- 🎙 **Live transcription** — 16 kHz capture → energy-VAD segmentation → resident local `whisper-server`. Sentences are finalized and appended while you speak; a grey italic line shows the live draft.
- ✍️ **Editable transcript** — the transcript is an ordinary text box: fix wording while recording continues.
- 🧹 **Local cleanup** — filler words (`uh/um`), repeated words and punctuation are normalized on-device, only for new sentences.
- ✨ **AI-organized notes** — templates (Study / Outline / Cornell / Key points / Custom) × length (Concise / Standard / Detailed). Long lectures are chunked, merged, and **auto-continued** when the model hits its output limit.
- 📎 **Slide context** — attach PDF/PPTX (password-protected supported); slide text is passed to the model, and deck terminology improves name/acronym spelling in transcription.
- 📓 **Notes library** — SQLite storage, notebooks & sub-notebooks, Markdown editor (highlight/table/image), tags, full-text search, TOC jump, undo, draft recovery, `.md` export.
- 🗂 **Transcriptions library** — every recording/import is archived; polish or organize it into a note later without re-transcribing.
- ⚡ **GPU acceleration on macOS** — bundled engine is a Metal build, with a CPU toggle in Settings. Windows ships a CPU-only engine.
- 🌏 **Bilingual UI** — Chinese / English, including errors, progress and default titles.
- 🖥 **Inspectable progress** — click the organizing card for per-chunk progress, live log, failure reason, retry, and history of recent runs.

## Requirements

| | |
|---|---|
| macOS | **12+, Apple Silicon (arm64)**. Intel Macs are not covered by the prebuilt release — build from source with an x64 engine. |
| Windows | **10 / 11, x64**. Requires the [VC++ 2015–2022 Redistributable (x64)](https://aka.ms/vs/17/release/vc_redist.x64.exe) (the engine DLLs depend on it). |
| AI notes | An [OpenRouter](https://openrouter.ai/keys) API key (the default model is free). Recording/transcribing needs no key and no network. |
| Disk | ≈1 GB (mostly the model downloaded on first run) |

## Download & install

Grab the latest from **[Releases](../../releases/latest)**:

| Platform | File |
|---|---|
| macOS (Apple Silicon) | `WhisperNotes-<version>-arm64.dmg` (recommended) or `-arm64-mac.zip` |
| Windows (x64) | `WhisperNotes-<version>-win-x64.exe` (installer) or `-win-x64.zip` (portable) |

### macOS

1. Open the `.dmg` and drag **WhisperNotes** into **Applications**.
2. The release is **not notarized** (that needs a paid Apple Developer account), so Gatekeeper blocks the first launch with *“Apple could not verify…”* or *“… is damaged and can't be opened”*. Do **one** of these:

   **A — no Terminal (recommended on macOS 15+)**
   Try to open it once, then  → **System Settings → Privacy & Security** → scroll down → **Open Anyway** next to WhisperNotes → confirm.

   **B — remove the quarantine flag (Terminal)**
   ```bash
   xattr -dr com.apple.quarantine /Applications/WhisperNotes.app
   open -a WhisperNotes
   ```

   **C — build it yourself** — locally built apps carry no quarantine flag (see [Build from source](#build-from-source)).

   > **Why is this needed?** The macOS build is *ad-hoc signed* (integrity only — no certificate, no notarization ticket), so Gatekeeper cannot verify the developer. Note that neither `codesign --sign -` nor the `com.apple.security.cs.disable-library-validation` entitlement can bypass Gatekeeper: ad-hoc signing carries no identity, and that entitlement only relaxes runtime dylib checks. Only a **Developer ID + notarization** removes this step — the CI is already wired for it ([Releasing](#releasing)).

### Windows

1. Run `WhisperNotes-<version>-win-x64.exe` (or unzip the portable build and run `WhisperNotes.exe`).
2. If SmartScreen appears, choose **More info → Run anyway**.
3. If the engine fails to start with a missing-DLL error, install the [VC++ 2015–2022 Redistributable (x64)](https://aka.ms/vs/17/release/vc_redist.x64.exe) — the app detects this case and tells you.

## First run

1. **Model** — not bundled (keeps the download small). On first launch the app fetches the default model (`ggml-large-v3-turbo-q5_0`, ≈574 MB) and selects it; switch or delete models in **Settings → Transcription models**.
2. **Microphone** — grant permission when asked.
3. **AI (optional)** — paste your OpenRouter key in **Settings → AI model**. Without it you can still record and transcribe.
4. **Language** — UI language and recording language are separate settings.

> **Recording system audio** (online lectures) on macOS: install [BlackHole 2ch](https://existential.audio/blackhole/), create a Multi-Output Device in *Audio MIDI Setup* (speakers + BlackHole), then select it in **Settings → Recording device**.

## How it works

```
mic / audio file
   │ 16 kHz PCM
   ├─► VAD segmentation ─► resident whisper-server (local whisper.cpp) ─► live transcript
   │                                                                        │
   └─► optional slide text (PDF/PPTX) ───────────────────────────────────────┤
                                                                            ▼
                                     chat completions (OpenRouter-compatible) ─► chunks ─► merge
                                                                            ▼
                                                          SQLite notes library + Markdown editor
```

- **Electron 44 + React 19 + TypeScript + Tailwind v4** (electron-vite build, electron-builder packaging).
- **ASR**: resident `whisper-server` child process (bundled `native/mac` = Metal build, `native/win` = CPU build), driven over local HTTP.
- **LLM**: plain `fetch` against any OpenRouter-compatible chat-completions endpoint; the key is stored encrypted (Keychain / DPAPI) with Electron `safeStorage`.

## Privacy

- **Audio never leaves your machine** — transcription is 100 % local.
- **Only** “Organize into a note” / “Polish transcript” send *text* to the endpoint you configured.
- API keys are encrypted with the OS keystore; notes, recordings and the database live in your own storage folder (configurable).
- No telemetry, no analytics, no accounts.

## Build from source

```bash
git clone https://github.com/<you>/whisper-notes.git
cd whisper-notes
npm ci            # installs deps and rebuilds better-sqlite3 for Electron
npm run dev       # dev mode with HMR
```

```bash
npm run typecheck   # tsc (main/preload + renderer)
npm run build       # build out/
npm run dist        # package for the current platform
npm run smoke       # headless smoke test (db + engine probe)
```

whisper.cpp binaries are **already in the repo** (`native/mac`, `native/win`), so no Xcode/C++ toolchain is required. To rebuild the engine (e.g. an x64 Metal build):

```bash
git clone https://github.com/ggml-org/whisper.cpp && cd whisper.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DBUILD_SHARED_LIBS=ON -DWHISPER_BUILD_SERVER=ON
cmake --build build -j
# copy build/bin/whisper-server + libwhisper/libggml*.dylib into native/mac/{bin,lib}
```

`GGML_METAL_EMBED_LIBRARY=ON` embeds the Metal kernels as source, so **no Xcode / `xcrun metal` is required** — shaders compile once at runtime and are cached by macOS.

## Releasing

Releases come from GitHub Actions (`.github/workflows/release.yml`):

| Job | Runner | Output |
|---|---|---|
| `windows` | `windows-latest` | NSIS installer + portable zip (x64, CPU engine) |
| `macos` | `macos-14` | DMG + zip (arm64, Metal engine) |
| `release` | tags only | GitHub Release with every artifact |

Windows **must** be built on Windows: `better-sqlite3` is native and `node-gyp` cannot cross-compile it from macOS.

```bash
# bump "version" in package.json, then:
git commit -am "release: 0.1.4"
git tag v0.1.4
git push origin main --tags      # CI builds and publishes
```

The workflow can also be started manually (Actions → Build & Release → Run workflow).

**Enabling macOS signing + notarization** (removes the Gatekeeper step entirely)

1. Enroll in the Apple Developer Program, create a **Developer ID Application** certificate, export it as `.p12`.
2. Add repository secrets: `MAC_CERT_P12` (base64 of the `.p12`), `MAC_CERT_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.
3. Push a tag — CI imports the certificate, signs with the hardened runtime, notarizes with `notarytool` and staples the ticket (`scripts/notarize.sh` does the same locally).

Without those secrets CI falls back to **ad-hoc deep signing** (`scripts/sign-adhoc.sh`), which is why the Gatekeeper workaround above exists.

## Settings worth knowing

| Setting | Why it matters |
|---|---|
| **Use GPU (Metal)** (macOS) | On by default; off forces CPU (`-ng`). Applies on the next recording/import. |
| **Max output tokens per request** | 8k / 16k / **32k** / 64k. Bigger = longer notes, slower requests. If the model still truncates, the chunk is auto-continued and the note is flagged. |
| **Max chunk size (chars)** | How much transcript goes into one request (long text is split, then merged). |
| **Note length** | Shapes the prompt. *Detailed* asks the model to keep every fact (no compression) — pair it with a larger budget. |
| **Threads** | CPU threads for the engine; barely matters when running on GPU. |

## Troubleshooting

| Symptom | Fix |
|---|---|
| macOS: *“WhisperNotes is damaged”* | `xattr -dr com.apple.quarantine /Applications/WhisperNotes.app`, or System Settings → Privacy & Security → *Open Anyway*. |
| Windows: engine won't start / missing DLL | Install the VC++ 2015–2022 Redistributable (x64); the app shows a dedicated hint. |
| Engine start timeout | Check **Settings → Transcription engine** (status/probe) and the logs under the app data folder. |
| Notes cut off | Raise **Max output tokens** and/or use *Detailed*. Truncated notes get a ⚠️ line at the top. |
| “Provider returned error (HTTP 400)” | The upstream provider rejected an oversized request; the app retries that chunk with a smaller budget automatically. |
| Daily limit message | Free OpenRouter tier has a per-day request cap; usage is counted locally in Settings and can be reset. |
| `better-sqlite3` ABI error after upgrading Electron | `npm run rebuild` |
| Where is my data? | App data folder (`~/Library/Application Support/WhisperNotes` on macOS, `%APPDATA%\WhisperNotes` on Windows) unless a custom storage folder is set. |

## License & credits

Apache License 2.0 — see [LICENSE](LICENSE).

Bundled third-party components:
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT) — transcription engine under `native/`.
- [FFmpeg](https://ffmpeg.org/) — `native/win/bin/ffmpeg.exe` (audio decoding on Windows) ships under FFmpeg's own license (LGPL/GPL depending on the build); macOS uses the system `afconvert` or a user-installed `ffmpeg`.
- Whisper models are downloaded from HuggingFace at first run under their own licenses.
- AI features call the endpoint you configure (OpenRouter by default).

---

# 中文说明

## 简介

**WhisperNotes** 是一个本地优先的课堂笔记工具：用麦克风录音或导入音频 → **本机 whisper.cpp 实时/离线转写** → 用你自己配置的模型（默认 OpenRouter 免费模型）把转写整理成结构化 Markdown 笔记。

- **音频不出本机**：转写全部本地完成，可断网使用。
- **只有「AI 整理 / 润色」联网**：把你选中的文本发给你配置的模型端点。
- **中英双语**：界面、报错、进度、默认标题都有中英两版。

主要功能：实时转写 + 可编辑转写区、本地轻清洗、AI 整理（模板 × 长度三档 × 自动分块与续写）、课件参考（PDF/PPTX，支持加密）、笔记库（笔记本/子笔记本、Markdown 编辑、标签、搜索、导出）、转写归档库、macOS Metal GPU 加速、整理进度可点开看详情与历史。

## 环境要求

| | |
|---|---|
| macOS | **12 以上，Apple Silicon（arm64）**。Intel Mac 请自行用源码构建 x64 引擎。 |
| Windows | **10 / 11 x64**，需要 [VC++ 2015–2022 Redistributable (x64)](https://aka.ms/vs/17/release/vc_redist.x64.exe)。 |
| AI 整理 | 一个 [OpenRouter](https://openrouter.ai/keys) API Key（默认模型免费）；不配也能录音和转写。 |
| 磁盘 | 约 1 GB（主要是首次运行下载的转写模型） |

## 下载与安装

到 **[Releases](../../releases/latest)** 下载：

| 平台 | 文件 |
|---|---|
| macOS（Apple Silicon） | `WhisperNotes-<版本>-arm64.dmg`（推荐）或 `-arm64-mac.zip` |
| Windows（x64） | `WhisperNotes-<版本>-win-x64.exe`（安装包）或 `-win-x64.zip`（免安装） |

### macOS 安装步骤

1. 打开 `.dmg`，把 **WhisperNotes** 拖进「应用程序」。
2. 首次打开会被 Gatekeeper 拦截（"无法验证开发者"或"已损坏，无法打开"），因为发布包**未经 Apple 公证**。任选一种方式通过：

   **方式 A（推荐，macOS 15+ 官方入口）**：先双击一次让它报错 → **系统设置 → 隐私与安全性** → 向下滚动 → 点 WhisperNotes 旁的 **"仍要打开"** → 确认。

   **方式 B（终端去掉隔离标记）**：
   ```bash
   xattr -dr com.apple.quarantine /Applications/WhisperNotes.app
   open -a WhisperNotes
   ```

   **方式 C**：直接[从源码运行](#运行方式源码)（本地构建无隔离标记）。

   > 说明：`codesign --sign -`（ad-hoc 签名）和 `com.apple.security.cs.disable-library-validation` **都无法绕过** Gatekeeper——前者没有证书身份，后者只是运行时放宽动态库校验，与"首次启动是否放行"无关。想让人人双击即开，只有 **Developer ID 证书 + 公证**（CI 已预留，见[发布流程](#发布流程)）。

### Windows 安装步骤

1. 运行 `WhisperNotes-<版本>-win-x64.exe`（或解压免安装版运行 `WhisperNotes.exe`）。
2. 若出现 SmartScreen「Windows 已保护你的电脑」→ **更多信息 → 仍要运行**。
3. 若转写启动失败并提示缺少 DLL → 安装 [VC++ 2015–2022 Redistributable (x64)](https://aka.ms/vs/17/release/vc_redist.x64.exe)（app 会专门提示）。

## 首次运行

1. **自动下载模型**：安装包不附带模型；首次启动自动下载 `ggml-large-v3-turbo-q5_0`（约 574 MB）并选用。可在 **设置 → 转写模型** 更换或删除（删掉后下次缺模型仍会自动下载）。
2. **麦克风权限**：按提示允许。
3. **AI（可选）**：**设置 → AI 模型** 填 OpenRouter API Key。
4. **语言**：界面语言与录音语言是两套独立设置。

> 录**系统声音**（网课）：macOS 装 [BlackHole 2ch](https://existential.audio/blackhole/)，在「音频 MIDI 设置」建多输出设备（扬声器 + BlackHole），再到 **设置 → 录音输入设备** 选它。

## 运行方式（源码）

```bash
git clone https://github.com/<你的用户名>/whisper-notes.git
cd whisper-notes
npm ci            # 安装依赖（并为 Electron 重编 better-sqlite3）
npm run dev       # 开发模式（热更新）
```

```bash
npm run typecheck   # 类型检查
npm run build       # 构建 out/
npm run dist        # 打当前平台安装包
npm run smoke       # 无界面冒烟测试（数据库 + 引擎探测）
```

whisper.cpp 引擎**已随仓库提供**（`native/mac` Metal 版、`native/win` CPU 版），无需 Xcode 或 C++ 工具链。想自己重编（例如给 Intel Mac 编 x64）：

```bash
git clone https://github.com/ggml-org/whisper.cpp && cd whisper.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DBUILD_SHARED_LIBS=ON -DWHISPER_BUILD_SERVER=ON
cmake --build build -j
# 把 build/bin/whisper-server 与 libwhisper/libggml*.dylib 复制到 native/mac/{bin,lib}
```

`GGML_METAL_EMBED_LIBRARY=ON` 把 Metal 着色器以源码形式嵌进二进制，**不需要装 Xcode**（运行时编译一次，之后由系统缓存）。

## 发布流程

发布由 GitHub Actions（`.github/workflows/release.yml`）完成：

| 任务 | 运行器 | 产物 |
|---|---|---|
| `windows` | `windows-latest` | NSIS 安装包 + 免安装 zip（x64，CPU 引擎） |
| `macos` | `macos-14` | DMG + zip（arm64，Metal 引擎） |
| `release` | 仅打 tag 时 | 汇总产物并创建 GitHub Release |

**Windows 必须在 Windows 上构建**：`better-sqlite3` 是原生模块，`node-gyp` 不支持从 macOS 交叉编译过去。

```bash
# 先改 package.json 里的 version，然后
git commit -am "release: 0.1.4"
git tag v0.1.4
git push origin main --tags      # CI 自动构建并发布
```

也可在 Actions 页面手动触发（Actions → Build & Release → Run workflow）。

**启用正式签名 + 公证**（让用户双击即可打开）：

1. 加入 Apple Developer Program，创建 **Developer ID Application** 证书并导出 `.p12`。
2. 仓库 Secrets 添加：`MAC_CERT_P12`（p12 的 base64）、`MAC_CERT_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。
3. 推 tag 即可：CI 自动导入证书 → hardened runtime 签名 → `notarytool` 公证 → staple（本地也可用 `scripts/notarize.sh`）。

没有这些 secrets 时 CI 退回 **ad-hoc 深签名**（`scripts/sign-adhoc.sh`），这就是上面 macOS 需要手动放行的原因。

## 值得注意的设置

| 设置 | 说明 |
|---|---|
| **使用 GPU（Metal）**（macOS） | 默认开；关掉传 `-ng` 强制 CPU。下次开始录音/导入生效。 |
| **单次输出上限（tokens）** | 8k / 16k / **32k** / 64k。越大笔记越长、越慢；触顶自动续写，仍不够会在笔记顶部标 ⚠️。 |
| **单块文本上限（字符）** | 每个请求的转写量；超长自动分块再合并。 |
| **笔记长度**（简洁/标准/详细） | 影响提示词；"详细"要求尽量不压缩，建议搭配更大的输出上限。 |
| **线程数** | 引擎的 CPU 线程数；走 GPU 时几乎无影响。 |

## 常见问题

| 现象 | 处理 |
|---|---|
| macOS 提示"已损坏，无法打开" | `xattr -dr com.apple.quarantine /Applications/WhisperNotes.app`，或 系统设置 → 隐私与安全性 → "仍要打开"。 |
| Windows 引擎起不来、缺 DLL | 装 VC++ 2015–2022 Redistributable (x64)。 |
| `whisper-server 启动超时` | 检查 **设置 → 转写引擎** 的状态/路径；日志在应用数据目录的 `logs/`。 |
| 笔记被截断 | 调大「单次输出上限」和/或用"详细"档；被截断的笔记顶部有 ⚠️ 提示。 |
| “Provider returned error (HTTP 400)” | 上游拒绝了过大的请求；app 会自动用更小的预算重试该块。 |
| 提示每日额度用尽 | OpenRouter 免费档每日请求上限，本地计数（设置页可查看/重置）。 |
| 升级 Electron 后 `better-sqlite3` ABI 报错 | `npm run rebuild` |
| 数据在哪 | 应用数据目录（macOS：`~/Library/Application Support/WhisperNotes`；Windows：`%APPDATA%\WhisperNotes`），可在设置里改。 |

## 许可与致谢

Apache License 2.0，见 [LICENSE](LICENSE)。

内置第三方组件：
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp)（MIT）——`native/` 下的转写引擎。
- [FFmpeg](https://ffmpeg.org/)——Windows 版 `native/win/bin/ffmpeg.exe` 用于音频解码，遵循其自身许可（LGPL/GPL，取决于构建）；macOS 使用系统 `afconvert` 或你自行安装的 `ffmpeg`。
- Whisper 模型首次运行时从 HuggingFace 下载，遵循各自许可。
- AI 功能调用你配置的端点（默认 OpenRouter）。



## Developer's notes

This is a project that is done completely by me with Deepseek API, and of course, is fully paid by myself. This app aims to help students like me to drop down notes in a way easier way and is completely free of charge, thats why its not notarized (im just a student...).
Hope this can help you all with your studies. This project costs me around 10$usd for development, if it's useful to you and you'd like to help cover that, you can leave a small one-time donation here: paypal.me/TNed132. No pressure—using, starring, or reporting bugs is already a big help.
