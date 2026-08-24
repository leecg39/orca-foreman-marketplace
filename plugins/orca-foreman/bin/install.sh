#!/bin/bash
# orca-foreman 설치 — 데몬을 플러그인 캐시 밖(~/.orca-foreman)으로 복사한다.
#
# 왜 복사하는가: 플러그인이 업데이트되면 캐시 경로에 버전 폴더가 붙어 경로가 바뀐다.
# 데몬은 nohup 으로 절대경로를 잡고 상주하므로, 캐시에서 직접 실행하면 업데이트 후
# 옛 경로의 데몬이 계속 돌게 된다. 고정 경로로 복사해 그 문제를 없앤다.
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.orca-foreman"
mkdir -p "$DEST" "$HOME/.local/bin"

if pgrep -f "foreman.mjs watch" >/dev/null; then
  echo "⚠️  상주 데몬이 실행 중입니다. 갱신하려면 먼저 중지하세요:"
  echo "    pkill -f 'foreman.mjs watch'"
  echo "    그다음 이 스크립트를 다시 실행하고 ~/.orca-foreman/start.sh 로 재시작하세요."
  exit 1
fi

cp "$SRC/foreman.mjs" "$DEST/foreman.mjs"
chmod +x "$DEST/foreman.mjs"

cat > "$DEST/start.sh" <<'INNER'
#!/bin/bash
if pgrep -f "foreman.mjs watch" >/dev/null; then echo "이미 실행 중 (PID $(pgrep -f 'foreman.mjs watch' | head -1))"; exit 0; fi
rm -f "$HOME/.orca-foreman/STOP"
nohup node "$HOME/.orca-foreman/foreman.mjs" watch --interval "${1:-90}" >> "$HOME/.orca-foreman/foreman.log" 2>&1 &
disown
echo "십장 상주 시작 (PID $!) · 간격 ${1:-90}s"
INNER
chmod +x "$DEST/start.sh"

cat > "$HOME/.local/bin/foreman" <<'INNER'
#!/bin/bash
exec node "$HOME/.orca-foreman/foreman.mjs" "$@"
INNER
chmod +x "$HOME/.local/bin/foreman"

echo "✅ 설치 완료"
echo "   데몬   $DEST/foreman.mjs"
echo "   진입점 $HOME/.local/bin/foreman"
echo "   시작   $DEST/start.sh [간격초]"
[[ ":$PATH:" == *":$HOME/.local/bin:"* ]] || echo "   ⚠️  PATH 에 ~/.local/bin 을 추가하세요"
