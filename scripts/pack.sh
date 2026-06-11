#!/bin/bash
# Epilogue 打包脚本：依赖裁剪 + 平台图标 + 语言包裁剪（保 en/zh）
# 用法: bash scripts/pack.sh [darwin|win32|linux] [arm64|x64]   （默认 darwin arm64）
set -e
cd "$(dirname "$0")/.."

PLATFORM="${1:-darwin}"
ARCH="${2:-arm64}"
OUT="dist/Epilogue-$PLATFORM-$ARCH"

case "$PLATFORM" in
  darwin) ICON=build/icon.icns ;;
  win32)  ICON=build/icon.ico ;;
  linux)  ICON=build/icon.png ;;
  *) echo "unknown platform: $PLATFORM" >&2; exit 1 ;;
esac

# onnxruntime 仅保留目标 平台/架构 二进制：六组合中排除当前，逐一明确（避免负向先行误伤目录前缀）
ORT_DROP=""
for combo in darwin/arm64 darwin/x64 linux/x64 linux/arm64 win32/x64 win32/arm64; do
  [ "$combo" = "$PLATFORM/$ARCH" ] && continue
  ORT_DROP="$ORT_DROP${ORT_DROP:+|}$combo"
done

npx electron-packager . Epilogue --platform="$PLATFORM" --arch="$ARCH" --out=dist --overwrite \
  --icon="$ICON" \
  --asar.unpackDir=build \
  --ignore="^/agents" --ignore="^/test" --ignore="^/dist" --ignore="^/\.git" --ignore="^/scripts" \
  --ignore="onnxruntime-node/bin/napi-v6/($ORT_DROP)" \
  --ignore="libonnxruntime_providers_(cuda|tensorrt)" \
  --ignore="node_modules/onnxruntime-web" \
  --ignore="node_modules/pdfjs-dist" \
  --ignore="node_modules/@napi-rs" \
  --ignore="pdf-parse/lib/pdf\.js/(v1\.9\.426|v1\.10\.88|v2\.0\.550)"

# 语言包裁剪：仅保留 en* / zh*
if [ "$PLATFORM" = "darwin" ]; then
  RES="$OUT/Epilogue.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources"
  find "$RES" -maxdepth 1 -name '*.lproj' ! -name 'en*' ! -name 'zh*' -exec rm -rf {} +
else
  # win/linux：Chromium locales/*.pak
  find "$OUT/locales" -maxdepth 1 -name '*.pak' ! -name 'en-US*' ! -name 'zh-CN*' ! -name 'zh-TW*' -delete
fi

du -sh "$OUT"
