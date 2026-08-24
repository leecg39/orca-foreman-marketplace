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

# node 절대경로를 설치 시점에 확정한다.
# 왜: 래퍼와 start.sh 가 맨 `node` 를 부르면 cron·launchd 처럼 PATH 가 최소인 환경에서
#     실행이 실패한다(실측: `env -i sh -c node` → not found). 절대경로로 박아 그 의존을 없앤다.
# 시스템 설치본을 먼저 찾는다. `command -v` 를 먼저 쓰면 버전 매니저가 관리하는
# 심볼릭 링크(예: ~/.local/bin/node -> ~/.hermes/...)가 잡혀, 그 도구가 노드를
# 갈아치울 때 데몬이 깨진다(실측).
NODE_BIN=""
for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  [ -x "$c" ] && NODE_BIN="$c" && break
done
[ -z "$NODE_BIN" ] && NODE_BIN="$(command -v node 2>/dev/null)"
if [ -z "$NODE_BIN" ]; then echo "❌ node 를 찾을 수 없습니다. Node.js 설치 후 다시 실행하세요."; exit 1; fi
echo "   node   $NODE_BIN"

if pgrep -f "foreman.mjs watch" >/dev/null; then
  echo "⚠️  상주 데몬이 실행 중입니다. 갱신하려면 먼저 중지하세요:"
  echo "    pkill -f 'foreman.mjs watch'"
  echo "    그다음 이 스크립트를 다시 실행하고 ~/.orca-foreman/start.sh 로 재시작하세요."
  exit 1
fi

cp "$SRC/foreman.mjs" "$DEST/foreman.mjs"
chmod +x "$DEST/foreman.mjs"

cat > "$DEST/start.sh" <<INNER
#!/bin/bash
# node 는 설치 시점에 확정된 절대경로 — 최소 PATH 환경(cron/launchd)에서도 뜬다.
NODE="$NODE_BIN"
if pgrep -f "foreman.mjs watch" >/dev/null; then echo "이미 실행 중 (PID \$(pgrep -f 'foreman.mjs watch' | head -1))"; exit 0; fi
rm -f "\$HOME/.orca-foreman/STOP"
nohup "\$NODE" "\$HOME/.orca-foreman/foreman.mjs" watch --interval "\${1:-90}" >> "\$HOME/.orca-foreman/foreman.log" 2>&1 &
disown
echo "십장 상주 시작 (PID \$!) · 간격 \${1:-90}s"
INNER
chmod +x "$DEST/start.sh"

cat > "$HOME/.local/bin/foreman" <<INNER
#!/bin/bash
exec "$NODE_BIN" "\$HOME/.orca-foreman/foreman.mjs" "\$@"
INNER
chmod +x "$HOME/.local/bin/foreman"

echo "✅ 설치 완료"
echo "   데몬   $DEST/foreman.mjs"
echo "   진입점 $HOME/.local/bin/foreman"
echo "   시작   $DEST/start.sh [간격초]"
[[ ":$PATH:" == *":$HOME/.local/bin:"* ]] || echo "   ⚠️  PATH 에 ~/.local/bin 을 추가하세요"
