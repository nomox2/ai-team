#!/bin/bash
# AI 팀 사무실 맥 앱을 ~/Applications에 만들어요. 더블클릭하면 서버를 켜고(이미 켜져 있으면 그대로) 브라우저로 열어요.
# 다시 실행하면 새로 만들어요. 사용: bash office-app/make-mac-app.sh
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
CLAUDE_BIN="$(command -v claude)"
APP="$HOME/Applications/AI 사무실.app"
PORT=4777

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>AI 사무실</string>
  <key>CFBundleIdentifier</key><string>local.ai-team.office</string>
  <key>CFBundleExecutable</key><string>office</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PLIST
cat > "$APP/Contents/MacOS/office" <<SH
#!/bin/bash
# 서버가 안 떠 있으면 켜고, 사무실 페이지를 열어요. 서버 기록: office-app/logs/server.log
if ! curl -s -o /dev/null "http://127.0.0.1:$PORT/api/state"; then
  mkdir -p "$DIR/office-app/logs"
  CLAUDE_BIN="$CLAUDE_BIN" nohup "$NODE" "$DIR/office-app/server.mjs" >> "$DIR/office-app/logs/server.log" 2>&1 &
  for i in \$(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$PORT/api/state" && break; sleep 0.1; done
fi
open "http://127.0.0.1:$PORT/"
SH
chmod +x "$APP/Contents/MacOS/office"

# 아이콘: 사무실 로고와 같은 픽셀 느낌의 보라색 네모 (sips/iconutil은 맥 기본 도구)
ICON_SRC="$DIR/office-app/icon.png"
if [ -f "$ICON_SRC" ]; then
  SET="$(mktemp -d)/icon.iconset"; mkdir -p "$SET"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$ICON_SRC" --out "$SET/icon_${s}x${s}.png" >/dev/null
    sips -z $((s*2)) $((s*2)) "$ICON_SRC" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$SET" -o "$APP/Contents/Resources/icon.icns"
fi
touch "$APP"
echo "만들었어요: $APP"
echo "끄기: 메뉴 막대 대신 터미널에서 'lsof -ti :$PORT | xargs kill' (또는 맥을 재시작)"
