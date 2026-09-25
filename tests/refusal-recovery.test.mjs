// refusal-recovery.mjs tests.
// Drives the StopFailure state machine against fabricated transcripts in a sandbox:
// escalating tiers, give-up marker, model gate, still-dead re-check, window pruning,
// min-gap guard and the kill switch. No external deps.
//   node tests/refusal-recovery.test.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../hooks/refusal-recovery.mjs", import.meta.url));
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "rr-test-"));
const HOOKS = path.join(SANDBOX, "hooks");
fs.mkdirSync(HOOKS, { recursive: true });

const REFUSAL =
  "This conversation contains sensitive content. Try switching models or  start a new session (input /clear)";

const writeTranscript = (name, entries) => {
  const p = path.join(SANDBOX, name + ".jsonl");
  fs.writeFileSync(p, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  return p;
};
const deadEntries = () => [
  { type: "user", sessionId: "TEST", message: { content: "开始吧" } },
  { type: "assistant", model: "mimo-v2.6-flash", message: { content: [{ type: "text", text: "好的" }] } },
  { type: "assistant", model: "<synthetic>", message: { content: [{ type: "text", text: REFUSAL }] } },
  { type: "last-prompt" },
  { type: "file-history-snapshot" },
];
const aliveEntries = () => [...deadEntries(), { type: "user", message: { content: [{ type: "text", text: "继续" }] } }];

const deadT = writeTranscript("dead", deadEntries());
const aliveT = writeTranscript("alive", aliveEntries());

const payload = (over = {}) =>
  JSON.stringify({
    hook_event_name: "StopFailure", session_id: "TEST-rr", transcript_path: deadT,
    cwd: "TEST", model: "mimo-v2.6-flash", error: "invalid_request", error_details: REFUSAL,
    last_assistant_message: REFUSAL, ...over,
  });

const run = (payloadStr, envOver = {}) =>
  spawnSync(process.execPath, [HOOK], {
    input: payloadStr, encoding: "utf8", timeout: 30000,
    // GAP=1ms (not 0) — the hook treats 0 as "unset" and falls back to its 8s default
    env: { ...process.env, QODER_CONFIG_DIR: SANDBOX, REFUSAL_RECOVERY_BACKOFF_MS: "50,50,50", REFUSAL_RECOVERY_GAP_MS: "1", ...envOver },
  });

const readState = () => { try { return JSON.parse(fs.readFileSync(path.join(HOOKS, "refusal-recovery-state.json"), "utf8")); } catch { return null; } };
const readMarker = () => { try { return JSON.parse(fs.readFileSync(path.join(HOOKS, "refusal-recovery-attention.json"), "utf8")); } catch { return null; } };
const auditLines = () => { try { return fs.readFileSync(path.join(HOOKS, "refusal-recovery-audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  cond ? pass++ : fail++;
};

// C1-C3: escalating tiers 1/3 -> 3/3
let r = run(payload()); let st = readState();
check("C1 wake 1/3", r.status === 2 && /1\/3/.test(r.stderr || ""), `exit=${r.status} stderr=${(r.stderr || "").slice(0, 70)}`);
check("C1 state attempts=1", !!(st && st.sessions["TEST-rr"] && st.sessions["TEST-rr"].attempts.length === 1));

r = run(payload()); st = readState();
check("C2 wake 2/3", r.status === 2 && /2\/3/.test(r.stderr || ""));
check("C2 attempts=2", !!st && st.sessions["TEST-rr"].attempts.length === 2);

r = run(payload()); st = readState();
check("C3 wake 3/3", r.status === 2 && /3\/3/.test(r.stderr || ""));
check("C3 attempts=3", !!st && st.sessions["TEST-rr"].attempts.length === 3);

// C4: 4th refusal -> give up (no wake, marker written)
r = run(payload());
check("C4 giveup: exit=0 & no stderr", r.status === 0 && !(r.stderr || "").trim(), `exit=${r.status}`);
const mk = readMarker();
check("C4 marker attempts=3", !!(mk && mk["TEST-rr"] && mk["TEST-rr"].attempts === 3));
check("C4 audit giveup", auditLines().some((l) => l.action === "giveup" && l.session === "TEST-rr"));

// C5: non-gated model -> skip
r = run(payload({ session_id: "TEST-rr-nonmimo", model: "DeepSeek-Flash" }));
check("C5 skip_model", r.status === 0 && auditLines().some((l) => l.action === "skip_model" && l.session === "TEST-rr-nonmimo"));

// C6: missing model + refusal signature -> acts
r = run(payload({ session_id: "TEST-rr-nomodel", model: undefined }));
check("C6 missing model acts 1/3", r.status === 2 && /1\/3/.test(r.stderr || ""), `exit=${r.status}`);

// C7: alive transcript -> skip_alive + marker self-clean
fs.writeFileSync(path.join(HOOKS, "refusal-recovery-attention.json"), JSON.stringify({ "TEST-rr-alive": { ts: Date.now(), attempts: 3 } }), "utf8");
r = run(payload({ session_id: "TEST-rr-alive", transcript_path: aliveT }));
const mk7 = readMarker();
check("C7 skip_alive", r.status === 0 && auditLines().some((l) => l.action === "skip_alive" && l.session === "TEST-rr-alive"));
check("C7 marker self-cleaned", !!(mk7 && !mk7["TEST-rr-alive"]));

// C8: attempts older than the window get pruned -> fresh 1/3
const old = Date.now() - 40 * 60 * 1000;
fs.writeFileSync(path.join(HOOKS, "refusal-recovery-state.json"), JSON.stringify({ v: 1, sessions: { "TEST-rr-prune": { attempts: [old, old, old], lastWakeTs: old } } }), "utf8");
r = run(payload({ session_id: "TEST-rr-prune" }));
check("C8 window pruning -> 1/3", r.status === 2 && /1\/3/.test(r.stderr || ""));

// C9: min-gap guard (second refusal within GAP_MS after a wake)
run(payload({ session_id: "TEST-rr-gap" })); // GAP=1ms -> wake
const r9 = run(payload({ session_id: "TEST-rr-gap" }), { REFUSAL_RECOVERY_GAP_MS: "8000" });
check("C9 gap guard -> skip_recent", r9.status === 0 && auditLines().some((l) => l.action === "skip_recent" && l.session === "TEST-rr-gap"));

// C10: kill switch
r = run(payload({ session_id: "TEST-rr-off" }), { REFUSAL_RECOVERY_DISABLE: "1" });
check("C10 disable -> inert", r.status === 0 && !auditLines().some((l) => l.session === "TEST-rr-off"));

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`sandbox: ${SANDBOX}`);
process.exit(fail ? 1 : 0);
