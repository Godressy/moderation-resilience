// prompt-gate.mjs tests.
// Runs the input gate against a sandbox config dir: density warn/block, one-shot surfacing of
// refusal-recovery markers and watchdog inbox items, and the throttled patrol spawn.
// The real refusal-watchdog.mjs is copied into the sandbox so the spawn target exists.
//   node tests/prompt-gate.test.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../hooks/prompt-gate.mjs", import.meta.url));
const WATCHDOG = fileURLToPath(new URL("../hooks/refusal-watchdog.mjs", import.meta.url));
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "pg-test-"));
const HOOKS = path.join(SANDBOX, "hooks");
fs.mkdirSync(HOOKS, { recursive: true });
fs.copyFileSync(WATCHDOG, path.join(HOOKS, "refusal-watchdog.mjs"));

const SESSION = "11111111-2222-3333-4444-555555555555";
const PENDING = path.join(HOOKS, "refusal-watchdog-pending.json");
const ATTENTION = path.join(HOOKS, "refusal-recovery-attention.json");
const CLAIM = path.join(HOOKS, "refusal-watchdog-spawn.json");
const WATCHDOG_STATE = path.join(HOOKS, "refusal-watchdog-state.json");
const AUDIT = path.join(HOOKS, "prompt-gate-audit.jsonl");

const run = (prompt, envOver = {}) => spawnSync(process.execPath, [HOOK], {
  input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }),
  encoding: "utf8", timeout: 20000, maxBuffer: 8 * 1024 * 1024,
  env: { ...process.env, QODER_CONFIG_DIR: SANDBOX, REFUSAL_WATCHDOG_DISABLE: "1", ...envOver },
});
const sysMsg = (r) => { try { return JSON.parse((r.stdout || "").trim()).systemMessage || ""; } catch { return ""; } };
const lastAudit = () => {
  try { const ls = fs.readFileSync(AUDIT, "utf8").split("\n").filter(Boolean); return JSON.parse(ls[ls.length - 1]); }
  catch { return null; }
};

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  cond ? pass++ : fail++;
};

// G1: clean prompt -> silence, nothing written
let r = run("请检查这个函数的边界条件并给出修复建议。");
check("G1 clean prompt -> no output", !(r.stdout || "").trim() && !lastAudit(), `stdout=${(r.stdout || "").trim().length}`);

// G2: dense prompt -> warn (systemMessage with counts), audit line, no block
r = run("NSFW NSFW NSFW NSFW NSFW NSFW NSFW NSFW NSFW");
const a2 = lastAudit();
check("G2 dense prompt -> warn + audit", /prompt-gate/.test(sysMsg(r)) && /9/.test(sysMsg(r)) && a2 && a2.mode === "warn" && a2.hits === 9,
  `mode=${a2 && a2.mode} hits=${a2 && a2.hits}`);

// G3: CONTENT_GATE_BLOCK=1 -> exit 2, stderr feedback, no stdout
r = run("NSFW NSFW NSFW NSFW NSFW NSFW NSFW NSFW NSFW", { CONTENT_GATE_BLOCK: "1" });
check("G3 block mode -> exit 2 + stderr", r.status === 2 && !(r.stdout || "").trim() && /prompt-gate/.test(r.stderr || ""),
  `status=${r.status} stderrLen=${(r.stderr || "").length}`);
check("G3 block recorded in audit", (lastAudit() || {}).mode === "block", `mode=${(lastAudit() || {}).mode}`);

// G4: watchdog inbox -> surfaced once, then consumed
fs.writeFileSync(PENDING, JSON.stringify({ ts: new Date().toISOString(), items: [{ session: "abcdef12-9999", ts: new Date().toISOString(), kind: "refusal", detail: "proj-x" }] }), "utf8");
r = run("继续");
check("G4 inbox item surfaced", /refusal-watchdog/.test(sysMsg(r)) && /abcdef12/.test(sysMsg(r)), `msg=${sysMsg(r).slice(0, 60)}`);
check("G4 pending file consumed", !fs.existsSync(PENDING));
r = run("继续");
check("G4 not surfaced twice", !/refusal-watchdog/.test(sysMsg(r)));

// G5: refusal-recovery attention marker -> surfaced once for that session, then cleared
fs.writeFileSync(ATTENTION, JSON.stringify({ [SESSION]: { ts: Date.now(), attempts: 3 }, "other-session": { ts: Date.now(), attempts: 2 } }), "utf8");
r = run("继续");
check("G5 give-up marker surfaced", /refusal-recovery/.test(sysMsg(r)) && /3 auto-retries/.test(sysMsg(r)), `msg=${sysMsg(r).slice(0, 60)}`);
const mk = JSON.parse(fs.readFileSync(ATTENTION, "utf8"));
check("G5 only this session cleared", !(SESSION in mk) && ("other-session" in mk), `keys=${Object.keys(mk).join(",")}`);
r = run("继续");
check("G5 not surfaced twice", !/refusal-recovery/.test(sysMsg(r)));

// G6: throttled patrol spawn — claim written, patrol actually runs and leaves state
fs.rmSync(CLAIM, { force: true });
fs.rmSync(WATCHDOG_STATE, { force: true });
r = run("继续", { REFUSAL_WATCHDOG_DISABLE: "" });
const claim = JSON.parse(fs.readFileSync(CLAIM, "utf8"));
check("G6 spawn claim written", typeof claim.ts === "number" && Date.now() - claim.ts < 10000, `ts=${claim.ts}`);
let ran = false;
for (let i = 0; i < 50 && !ran; i++) { ran = fs.existsSync(WATCHDOG_STATE); if (!ran) await new Promise((s) => setTimeout(s, 100)); }
check("G6 spawned patrol actually completed a scan", ran, ran ? "state file present" : "no state after 5s");

// G7: second message within the throttle window does not re-claim
const tsBefore = JSON.parse(fs.readFileSync(CLAIM, "utf8")).ts;
r = run("继续", { REFUSAL_WATCHDOG_DISABLE: "" });
check("G7 throttle holds (claim unchanged)", JSON.parse(fs.readFileSync(CLAIM, "utf8")).ts === tsBefore);

// G8: CONTENT_GATE_DISABLE=1 -> complete silence even with pending work
fs.writeFileSync(PENDING, JSON.stringify({ ts: new Date().toISOString(), items: [{ session: "deadbeef", ts: new Date().toISOString(), kind: "refusal", detail: "x" }] }), "utf8");
r = run("NSFW NSFW NSFW NSFW NSFW NSFW NSFW NSFW NSFW", { CONTENT_GATE_DISABLE: "1" });
check("G8 disable switch -> no output, pending untouched", !(r.stdout || "").trim() && fs.existsSync(PENDING));

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`sandbox: ${SANDBOX}`);
process.exit(fail ? 1 : 0);
