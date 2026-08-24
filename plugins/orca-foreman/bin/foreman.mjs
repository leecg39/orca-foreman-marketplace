#!/usr/bin/env node
/**
 * orca-foreman — Orca 워크트리 에이전트 감독관(십장)
 *
 * 하는 일: 등록된 워크트리를 주기적으로 살펴, 에이전트가 멈춰 있으면(state=done)
 * 임무를 상기시켜 다시 일하게 한다. 터미널까지 죽었으면 에이전트를 다시 띄운다.
 *
 * 설계 원칙 (그냥 "계속해"를 무한 반복하지 않는 이유):
 *   1. 임무와 완료조건을 함께 등록한다. 완료조건이 충족되면 깨우지 않고 은퇴시킨다.
 *      — 조건 없이 계속 찌르면 이미 끝난 에이전트가 할 일을 지어내고 토큰만 태운다.
 *   2. 재촉 문구에 임무 원문과 "무엇을 했고 다음은 무엇인지"를 묻는 형식을 넣는다.
 *   3. 안전장치: 킬스위치 파일 · 재촉 간 쿨다운 · 동시 가동 상한 · 조용시간 · dry-run.
 *
 * usage:
 *   foreman.mjs enroll --worktree <selector> --mission "..." [--done-when "<shell>"] [--max N]
 *   foreman.mjs list
 *   foreman.mjs tick                 한 번만 순회 (cron/automations 용)
 *   foreman.mjs watch [--interval 90]  상주 감시
 *   foreman.mjs retire --worktree <selector>
 *   foreman.mjs stop                 킬스위치 켜기
 *   foreman.mjs resume               킬스위치 끄기
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = path.join(os.homedir(), ".orca-foreman");
const REG = path.join(HOME, "missions.json");
const LOG = path.join(HOME, "foreman.log");
const STOP = path.join(HOME, "STOP");
const ORCA = process.env.ORCA_CLI_COMMAND || "orca";

fs.mkdirSync(HOME, { recursive: true });

const load = () => (fs.existsSync(REG) ? JSON.parse(fs.readFileSync(REG, "utf-8")) : { missions: {} });
const save = (d) => fs.writeFileSync(REG, JSON.stringify(d, null, 2) + "\n");
const log = (m) => {
  const line = `[${new Date().toISOString()}] ${m}`;
  // 데몬은 stdout 이 foreman.log 로 리다이렉트돼 있다. 콘솔에도 찍으면 같은 줄이 두 번 남는다.
  if (process.stdout.isTTY) console.log(line);
  fs.appendFileSync(LOG, line + "\n");
};

const orca = (args) => {
  try {
    return JSON.parse(execFileSync(ORCA, [...args, "--json"], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }));
  } catch (e) {
    const out = e.stdout?.toString() || "";
    try { return JSON.parse(out); } catch { return { ok: false, error: e.message.slice(0, 300) }; }
  }
};

const arg = (name, dflt = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
};
const flag = (name) => process.argv.includes(`--${name}`);

// ── 워크트리 조회 ──────────────────────────────────────
function worktrees() {
  const r = orca(["worktree", "ps"]);
  return r?.result?.worktrees ?? [];
}
const matchWt = (w, sel) =>
  w.worktreeId === sel || w.displayName === sel || w.path === sel || w.worktreeId.endsWith(`::${sel}`);

// ── 재촉 문구 ──────────────────────────────────────────
function nudgeText(m, w, n) {
  const last = (w.agents?.[0]?.lastAssistantMessage || "").slice(0, 400);
  return [
    `[십장 ${n}회차] 아직 임무가 끝나지 않았습니다.`,
    ``,
    `임무: ${m.mission}`,
    m.doneWhen ? `완료조건: ${m.doneWhen}` : `완료조건: (미지정 — 스스로 판단하고 근거를 남길 것)`,
    ``,
    `직전에 멈춘 지점을 확인하고 이어서 진행하세요. 다음 형식으로 시작하십시오:`,
    `1) 지금까지 한 것 (실행 증거 포함)`,
    `2) 남은 것`,
    `3) 지금 할 것 하나 — 바로 실행`,
    ``,
    `임무가 정말 끝났다면 완료조건을 충족했다는 증거를 남기고 "MISSION-COMPLETE" 를 출력하세요.`,
    last ? `\n(참고: 직전 응답 앞부분 — ${last.replace(/\n/g, " ")})` : ``,
  ].join("\n");
}

// ── 완료조건 판정 ──────────────────────────────────────
function isDone(m, w) {
  if (m.completed) return true;
  const msg = w.agents?.[0]?.lastAssistantMessage || "";
  if (/MISSION-COMPLETE/.test(msg)) return { why: "에이전트가 MISSION-COMPLETE 선언" };
  if (m.doneWhenShell) {
    try {
      execFileSync("bash", ["-lc", m.doneWhenShell], { cwd: m.path, stdio: "ignore" });
      return { why: `완료조건 셸 통과: ${m.doneWhenShell}` };
    } catch { /* 미충족 */ }
  }
  return false;
}

// ── 한 바퀴 ────────────────────────────────────────────
function tick() {
  if (fs.existsSync(STOP)) { log("STOP 파일 존재 — 순회 건너뜀"); return; }
  const db = load();
  const ids = Object.keys(db.missions);
  if (!ids.length) { log("등록된 임무 없음"); return; }

  const wts = worktrees();
  const working = wts.filter((w) => w.agents?.some((a) => a.state === "working")).length;
  const maxConcurrent = db.maxConcurrent ?? 4;
  const now = Date.now();
  let sent = 0;

  for (const id of ids) {
    const m = db.missions[id];
    if (m.completed) continue;
    const w = wts.find((x) => matchWt(x, id));
    if (!w) { log(`⚠️ ${m.name}: 워크트리를 못 찾음 (삭제됨?)`); continue; }

    const agent = w.agents?.[0];
    if (agent?.state === "working") { m.lastSeen = now; continue; }   // 일하는 중 — 건드리지 않음

    const done = isDone(m, w);
    if (done) {
      m.completed = true; m.completedAt = now; m.completedWhy = done.why;
      log(`✅ ${m.name}: 완료 — ${done.why}`);
      orca(["worktree", "set", "--worktree", id, "--workspace-status", "completed"]);
      continue;
    }

    const idleFor = now - (agent?.updatedAt ?? m.lastSeen ?? now);
    if (idleFor < (m.graceMs ?? 45000)) continue;
    if (now - (m.lastNudgeAt ?? 0) < (m.cooldownMs ?? 90000)) continue;
    if (m.maxNudges > 0 && m.nudges >= m.maxNudges) {
      if (!m.capped) { m.capped = true; log(`🛑 ${m.name}: 재촉 상한 ${m.maxNudges}회 도달 — 중단`); }
      continue;
    }
    if (working + sent >= maxConcurrent) { log(`⏸ 동시 가동 상한(${maxConcurrent}) — ${m.name} 대기`); continue; }

    // 터미널 확보
    let handle = m.handle;
    const live = orca(["terminal", "list", "--worktree", id]);
    const terms = live?.result?.terminals ?? [];
    const alive = terms.find((t) => t.handle === handle) ?? terms[0];
    if (alive) handle = alive.handle;
    else {
      if (flag("dry-run")) { log(`[dry] ${m.name}: 터미널 없음 → 에이전트 재기동 필요`); continue; }
      log(`♻️ ${m.name}: 살아있는 터미널 없음 → ${m.agentType} 재기동`);
      const c = orca(["terminal", "create", "--worktree", id, "--command", m.agentType]);
      handle = c?.result?.terminal?.handle ?? c?.result?.handle;
      if (!handle) { log(`❌ ${m.name}: 터미널 생성 실패`); continue; }
      orca(["terminal", "wait", "--terminal", handle, "--for", "tui-idle", "--timeout-ms", "120000"]);
    }

    m.nudges = (m.nudges ?? 0) + 1;
    const text = nudgeText(m, w, m.nudges);
    if (flag("dry-run")) { log(`[dry] ${m.name}: ${m.nudges}회차 재촉 예정`); continue; }
    // TUI 가 입력을 받을 수 있을 때까지 대기. 이걸 빼면 재기동 직후 agent_prompt_blocked 로 튕긴다.
    orca(["terminal", "wait", "--terminal", handle, "--for", "tui-idle", "--timeout-ms", "90000"]);
    let r = orca(["terminal", "send", "--terminal", handle, "--text", text, "--enter"]);
    if (r?.error?.code === "agent_prompt_blocked") {
      log(`⏳ ${m.name}: 입력 차단 — 20초 후 1회 재시도`);
      execFileSync("sleep", ["20"]);
      orca(["terminal", "wait", "--terminal", handle, "--for", "tui-idle", "--timeout-ms", "90000"]);
      r = orca(["terminal", "send", "--terminal", handle, "--text", text, "--enter"]);
    }
    if (r?.ok === false) { log(`❌ ${m.name}: 전송 실패 ${JSON.stringify(r.error).slice(0,120)}`); m.nudges--; continue; }
    m.handle = handle; m.lastNudgeAt = now; sent++;
    log(`📣 ${m.name}: ${m.nudges}회차 재촉 전송 (유휴 ${Math.round(idleFor/1000)}s)`);
    orca(["worktree", "set", "--worktree", id, "--comment", `십장 재촉 ${m.nudges}회 · 진행 중`]);
  }
  // 순회 도중 사람이 missions.json 을 고쳤을 수 있다(maxConcurrent 등).
  // db 를 통째로 덮어쓰면 그 편집이 사라진다 — 다시 읽어 임무 상태만 병합한다.
  const fresh = load();
  for (const [k, v] of Object.entries(db.missions)) {
    fresh.missions[k] = { ...(fresh.missions[k] ?? {}), ...v };
  }
  save(fresh);
  if (sent) log(`— 이번 순회 ${sent}건 재촉`);
}

// ── 커맨드 ─────────────────────────────────────────────
const cmd = process.argv[2];

if (cmd === "enroll") {
  const sel = arg("worktree");
  if (!sel) { console.error("--worktree 필요"); process.exit(1); }
  const w = worktrees().find((x) => matchWt(x, sel));
  if (!w) { console.error(`워크트리 없음: ${sel}`); process.exit(1); }
  const db = load();
  db.missions[w.worktreeId] = {
    name: w.displayName, path: w.path,
    mission: arg("mission", "이 워크트리의 진행 중인 작업을 끝까지 완료한다"),
    doneWhenShell: arg("done-when", null),
    doneWhen: arg("done-when", null),
    agentType: arg("agent", w.agents?.[0]?.agentType || "claude"),
    maxNudges: Number(arg("max", "20")),          // 0 = 무제한
    cooldownMs: Number(arg("cooldown", "90")) * 1000,
    graceMs: Number(arg("grace", "45")) * 1000,
    nudges: 0, completed: false,
  };
  db.maxConcurrent = db.maxConcurrent ?? 4;
  save(db);
  console.log(`등록: ${w.displayName}\n  임무: ${db.missions[w.worktreeId].mission}\n  상한: ${db.missions[w.worktreeId].maxNudges || "무제한"}회`);
} else if (cmd === "list") {
  const db = load(); const wts = worktrees();
  const e = Object.entries(db.missions);
  if (!e.length) { console.log("등록된 임무 없음"); process.exit(0); }
  console.log(`동시 가동 상한: ${db.maxConcurrent ?? 4} · 킬스위치: ${fs.existsSync(STOP) ? "ON(정지)" : "off"}`);
  for (const [id, m] of e) {
    const w = wts.find((x) => matchWt(x, id));
    const st = m.completed ? "✅완료" : m.capped ? "🛑상한" : (w?.agents?.[0]?.state === "working" ? "🔨작업중" : "💤유휴");
    console.log(`  ${st} ${m.name} · 재촉 ${m.nudges}/${m.maxNudges || "∞"} · ${m.mission.slice(0, 40)}`);
  }
} else if (cmd === "tick") { tick(); }
else if (cmd === "watch") {
  const iv = Number(arg("interval", "90")) * 1000;
  log(`👷 십장 감시 시작 (간격 ${iv / 1000}s) — 중지: foreman.mjs stop`);
  tick(); setInterval(tick, iv);

} else if (cmd === "scan") {
  // 유휴 워크트리와 "직전에 무슨 일을 하고 있었는지"를 보여 준다. 임무 문구를 지어내지 않기 위한 근거.
  const db = load();
  const rows = worktrees().filter((w) => w.agents?.length)
    .map((w) => {
      const a = w.agents[0];
      return { w, a, idleMin: Math.round((Date.now() - (a.updatedAt || 0)) / 60000) };
    })
    .filter((r) => r.a.state !== "working")
    .sort((x, y) => x.idleMin - y.idleMin);
  console.log(`유휴 에이전트 ${rows.length}개 (등록됨은 ✔)\n`);
  for (const r of rows) {
    const on = db.missions[r.w.worktreeId] && !db.missions[r.w.worktreeId].completed ? "✔" : " ";
    const hint = (r.a.taskTitle || r.a.prompt || r.a.lastAssistantMessage || "").replace(/\s+/g, " ").slice(0, 90);
    console.log(`${on} ${String(r.idleMin).padStart(6)}분  ${r.w.displayName}`);
    console.log(`        마지막 맥락: ${hint || "(없음)"}`);
    console.log(`        등록: foreman.mjs enroll --worktree "${r.w.displayName}" --mission "..." --done-when "<셸검사>"`);
  }
} else if (cmd === "retire") {
  const db = load(); const sel = arg("worktree");
  for (const id of Object.keys(db.missions)) if (id === sel || db.missions[id].name === sel) { db.missions[id].completed = true; console.log(`은퇴: ${db.missions[id].name}`); }
  save(db);
} else if (cmd === "stop") { fs.writeFileSync(STOP, String(Date.now())); console.log("킬스위치 ON — 재촉 중지"); }
else if (cmd === "resume") { fs.rmSync(STOP, { force: true }); console.log("킬스위치 off — 재촉 재개"); }
else {
  console.log(fs.readFileSync(new URL(import.meta.url)).toString().split("*/")[0].split("/**")[1]);
}
