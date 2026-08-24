<p align="center">
  <img src="assets/foreman.png" alt="Orca Foreman" width="220">
</p>

<h1 align="center">Orca Foreman · 십장</h1>

<p align="center">멈춘 Orca 워크트리 에이전트를 감지해 다시 일하게 하는 감독관</p>

---

## 문제

Orca 워크트리에서 에이전트는 응답을 마치면 멈춘다. 그리고 아무도 깨우지 않으면 며칠씩 그대로 있다.
실측: 워크트리 22개 중 13개에 에이전트가 있었고 **전부 `done` 상태, 유휴 10시간~6일**.
그중 살아있는 터미널은 **1개뿐**이라 나머지는 말을 걸 수조차 없었다.

## 하는 일

십장은 90초마다 명부를 순회하며,

- 멈춘 에이전트를 찾고
- **터미널까지 죽었으면 에이전트를 다시 띄우고**
- 임무를 상기시켜 이어서 일하게 한다

AI 세션과 분리돼 상주하므로 Claude Code를 꺼도 계속 돈다.

## 설치

```bash
/plugin marketplace add leecg39/orca-foreman-marketplace
/plugin install orca-foreman
~/.claude/plugins/cache/*/orca-foreman/*/bin/install.sh   # 데몬을 고정 경로로 설치
```

설치 스크립트는 데몬을 `~/.orca-foreman/` 로 복사한다. 플러그인 업데이트 시 캐시 경로가
바뀌어 옛 데몬이 살아남는 문제를 막기 위해서다.

## 사용

```bash
foreman scan                     # 놀고 있는 부하와 직전 맥락
foreman enroll --worktree "<이름>" --mission "..." --done-when "<셸>" --max 0
~/.orca-foreman/start.sh 90      # 상주 시작
foreman list                     # 현황
foreman stop | resume            # 킬스위치
tail -f ~/.orca-foreman/foreman.log
```

슬래시 명령: `/foreman-scan` `/foreman-enroll` `/foreman-status`

## 설계 원칙 — "계속해"를 무한 반복하지 않는다

가장 쉬운 실패는 멈춘 에이전트에게 "계속해"만 계속 보내는 것이다.
**이미 끝난 에이전트가 할 일을 지어내고 토큰만 태운다.**

그래서 십장은 **임무와 완료조건을 함께** 받는다.

| | |
|---|---|
| 완료 판정 | 셸 검사(`--done-when "test -f out.mp4"`) 또는 에이전트의 `MISSION-COMPLETE` 선언 |
| 재촉 문구 | 임무 원문 + 직전 응답 요약 + "① 한 것(증거) ② 남은 것 ③ 지금 할 것" 형식 강제 |
| 맥락이 빈 워크트리 | 임무를 지어내지 않고 **자가 판정** 임무를 준다 (스킬 §2-B) |

동봉된 스킬이 임무 설계 판단을 담당한다 — 맥락 유무로 구체/자가판정을 가르고,
막혔던 원인의 해법을 임무에 넣고, 등록하면 안 되는 워크트리를 걸러낸다.

## 안전장치

| | 기본 | |
|---|---|---|
| `--max` | 20 | 재촉 상한 (**0 = 무제한**) |
| `--cooldown` | 90s | 재촉 간 최소 간격 |
| `--grace` | 45s | 유휴 판정 유예 |
| `maxConcurrent` | 4 | 동시 가동 상한 — 16GB 기기는 3 이하 권장 |
| 킬스위치 | — | `foreman stop` / `~/.orca-foreman/STOP` |

## 등록하면 안 되는 것

- **지금 작업 중인 워크트리** — 같은 리포에서 동시에 파일을 건드려 충돌한다
- **사람의 결정을 기다리는 곳** — 깨워도 같은 질문만 반복한다

## 라이선스

MIT
