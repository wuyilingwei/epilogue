# Epilogue

<img src="logo.svg" width="96" align="right" />

**files, remembered.** An AI file workflow desktop app (macOS / Windows / Linux).

English | [中文](README.md)

Open source (**ALE 1.1 & GPL-3.0**) with **zero data collection** — settings, index and vectors never leave your machine; audio/video transcription runs on-device by default.

[**Download releases →**](https://github.com/wuyilingwei/epilogue/releases) (all platforms, both architectures: macOS / Windows / Linux × x64 / arm64)

## Features

- **Cleanup**: periodically scans for files left untouched for too long; AI suggests where each one belongs based on your filing habits written in plain language, and moves them after your item-by-item confirmation. It recognizes sets (lecture series, portable apps, episodes) and files them as a whole, making use of nested destination folder structures.
- **Recall**: "Where did I put last term's lab report?" — find any file in one sentence, via keyword / similarity / AI Q&A modes; find images by text description; understands relative time like "last year" or "last week".
- **Assistant**: a built-in conversational agent — change settings, remember habits like "invoices always go to Finance/", and look files up.
- **Optional automation** (off by default, can only be enabled manually): Solo mode auto-files on schedule without per-item approval; optionally let the AI move clearly worthless temp files to the system Trash.

## AI Capabilities & Multi-Provider Failover

Every capability is a **failover list** (drag to reorder, per-row enable, one-click connectivity test), tried top-down:

| Capability | Built-in presets | Notes |
| --- | --- | --- |
| Chat | Pollinations (no key) → OpenRouter Free → OpenCode Zen Free | paste a key to activate the latter two; add any OpenAI-compatible service |
| Text embeddings | **On-device BGE** (offline) | cloud APIs as fallback |
| Image embeddings | **On-device CLIP family, 4 options** (downloaded on demand) | find images with descriptions like "red poster" |
| Whisper / transcription | **On-device, two quality tiers** (downloaded independently) | cloud transcription as fallback |

Understands archives, Office documents, PDFs, plain text, images, and audio/video.

## Lightweight Residency

Heavily optimized for low footprint: the tray-resident app uses almost no resources, UI and data load only when needed, heavy work automatically yields to your foreground tasks, and everything slows down on battery. No Dock icon while tray-resident (macOS).

## Run & Develop

```bash
npm install
npm start      # launch the app
npm test       # unit tests
bash scripts/pack.sh [platform] [arch]   # local packaging
```

Pushing a `v*` tag triggers CI builds for all platforms and architectures.

## Privacy & License

- No telemetry, no analytics, no phone-home; all data stays on your machine and can be inspected and cleaned in-app.
- When you use AI features, relevant file content is sent to **the providers you configure (or the built-in defaults)**, governed by their own privacy policies; avoid AI features on highly sensitive files.
- License: **ALE 1.1 (Anti-Labor Exploitation License, prevailing) & GPL-3.0** — GPL rights are conditional on ALE compliance; ALE's restrictions apply primarily to commercial and employing entities. Full terms and license texts are bundled in-app (Settings → About).
