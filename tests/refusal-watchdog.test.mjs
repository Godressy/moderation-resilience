// refusal-watchdog.mjs tests.
// Runs the patrol against a sandbox config dir with fabricated transcripts + a fabricated
// recovery audit; asserts classification (refusal vs quota), dedup, the audit path, merge
// behaviour and the mtime window. No model calls, no external deps.
//   node tests/refusal-watchdog.test.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../hooks/refusal-watchdog.mjs", import.meta.url));
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "rw-test-"));
const HOOKS = path.join(SANDBOX, "hooks");
const PROJ = path.join(SANDBOX, "projects", "proj-a");
fs.mkdirSync(HOOKS, { recursive: true });
fs.mkdirSync(PROJ, { recursive: true });

const STATE = path.join(HOOKS, "refusal-watchdog-state.json");
const PENDING = path.join(HOOKS, "refusal-watchdog-pending.json");
const RECOVERY_AUDIT = path.join(HOOKS, "refusal-recovery-audit.jsonl");
const PAST = new Date(Date.now() - 3600 * 1000).toISOString();

const REFUSAL_TEXT = "This conversation contains sensitive content. Try switching models or  start a new session (input /clear)";
const QUOTA_TEXT = "You've reached your daily usage limit for Chat. Come back tomorrow to continue working with me.";
const synthetic = (text, ts = new Date().toISOString()) => ({ type: "assistant", model: "<synthetic>", timestamp: ts, message: { model: "<synthetic>", content: [{ type: "text", text }] } });
const writeTranscript = (name, entries) => fs.writeFileSync(path.join(PROJ, name), entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
const resetState = (lastScanTs, notified = []) => { fs.mkdirSync(HOOKS, { recursive: true }); fs.writeFileSync(STATE, JSON.stringify({ lastScanTs, notified }), "utf8"); };
const readPending = () => { try { return JSON.parse(fs.readFileSync(PENDING, "utf8")); } catch { return null; } };
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return null; } };

const run = (args = [], envOver = {}) => spawnSync(process.execPath, [HOOK, "--json", ...args], {
  encoding: "utf8", timeout: 20000, maxBuffer: 32 * 1024 * 1024,
  env: { ...process.env, QODER_CONFIG_DIR: SANDBOX, ...envOver },
});
const summaryOf = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  cond ? pass++ : fail++;
};

// W1: refusal fingerprint classified as refusal -> queued; quota classified separately -> silent
writeTranscript("sess-refusal.jsonl", [
  { type: "user", message: { role: "user", content: [{ type: "text", text: "neutral question" }] } },
  synthetic(REFUSAL_TEXT),
  synthetic(QUOTA_TEXT),
]);
resetState(PAST);
let r = run();
let s = summaryOf(r);
let p = readPending();
check("W1 refusal queued with session + kind", !!(p && p.items.length === 1 && p.items[0].session === "sess-refusal" && p.items[0].kind === "refusal"),
  `items=${p ? p.items.length : "none"}`);
check("W1 quota counted but suppressed", s && s.synthetic_seen.refusal === 1 && s.synthetic_seen.quota === 1 && s.new_items === 1,
  `seen=${s && JSON.stringify(s.synthetic_seen)} new=${s && s.new_items}`);
check("W1 state persisted (lastScanTs + notified)", !!(readState() && readState().lastScanTs && readState().notified.length === 2),
  `notified=${readState() && readState().notified.length}`);

// W2: same data, previous lastScanTs restored (so the window still covers it) -> dedup, no new items
resetState(PAST, readState().notified);
fs.rmSync(PENDING, { force: true });
r = run(); s = summaryOf(r);
check("W2 dedup: re-scan adds nothing", s && s.new_items === 0 && !readPending(),
  `new=${s && s.new_items} pending=${readPending() ? "recreated" : "absent"}`);
check("W2 counters still report the hits", s && s.synthetic_seen.refusal === 1 && s.transcripts_with_fingerprint === 1,
  `files=${s && s.transcripts_with_fingerprint}`);

// W3: recovery audit newer than `since` -> recovered/giveup items
fs.writeFileSync(RECOVERY_AUDIT, [
  JSON.stringify({ ts: new Date().toISOString(), session: "sess-refusal", model: "mimo-v2.6-flash", action: "rewake", attempt: 1 }),
  JSON.stringify({ ts: new Date().toISOString(), session: "sess-dead", model: "mimo-v2.6-flash", action: "giveup", attempts: 3 }),
  JSON.stringify({ ts: PAST, session: "sess-old", action: "rewake" }), // older than `since` -> ignored
].join("\n") + "\n", "utf8");
resetState(PAST, readState().notified);
r = run(); s = summaryOf(r); p = readPending();
const kinds = p ? p.items.map((i) => i.kind).sort() : [];
check("W3 recovery audit: rewake+giveup queued, stale event ignored", JSON.stringify(kinds) === '["giveup","recovered"]' && s.audit_events === 2,
  `kinds=${JSON.stringify(kinds)} audit_events=${s && s.audit_events}`);
check("W3 giveup detail carries attempt count", !!(p && p.items.find((i) => i.kind === "giveup" && /3/.test(i.detail))),
  `detail=${p && (p.items.find((i) => i.kind === "giveup") || {}).detail}`);

// W4: existing pending items are merged, not duplicated (the already-notified refusal of
// sess-refusal must NOT be re-queued; only the genuinely new one from sess-second is added)
fs.writeFileSync(PENDING, JSON.stringify({ ts: PAST, items: [{ session: "kept", ts: PAST, kind: "refusal", detail: "earlier" }] }), "utf8");
writeTranscript("sess-second.jsonl", [synthetic(REFUSAL_TEXT)]);
resetState(PAST, readState().notified);
r = run(); p = readPending();
check("W4 merge keeps earlier item, adds only the new one", !!(p && p.items.length === 2 && p.items.filter((i) => i.session === "kept").length === 1 && p.items.some((i) => i.session === "sess-second")),
  `items=${p && p.items.length} sessions=${p && p.items.map((i) => i.session).join(",")}`);

// W5: mtime window — a transcript last touched 48h ago is out of the default 24h window
// (isolated tree so sibling transcripts cannot mask the result)
const oldTree = fs.mkdtempSync(path.join(os.tmpdir(), "rw-old-"));
fs.mkdirSync(path.join(oldTree, "proj-c"), { recursive: true });
const old = path.join(oldTree, "proj-c", "sess-old.jsonl");
fs.writeFileSync(old, JSON.stringify(synthetic(REFUSAL_TEXT)) + "\n", "utf8");
const t48 = Date.now() / 1000 - 48 * 3600;
fs.utimesSync(old, t48, t48);
r = run(["--root", oldTree]); s = summaryOf(r);
check("W5 48h-old transcript outside the window", s && s.transcripts_with_fingerprint === 0,
  `files=${s && s.transcripts_with_fingerprint}`);

// W6: --window-hours 72 brings the old transcript back in
r = run(["--root", oldTree, "--window-hours", "72"]); s = summaryOf(r);
check("W6 --window-hours 72 includes it again", s && s.transcripts_with_fingerprint === 1,
  `files=${s && s.transcripts_with_fingerprint}`);

// W7: --root override (scan a different tree entirely)
const other = fs.mkdtempSync(path.join(os.tmpdir(), "rw-other-"));
fs.mkdirSync(path.join(other, "proj-b"), { recursive: true });
fs.writeFileSync(path.join(other, "proj-b", "sess-elsewhere.jsonl"), JSON.stringify(synthetic(REFUSAL_TEXT)) + "\n", "utf8");
r = run(["--root", other]); s = summaryOf(r);
check("W7 --root scans only that tree", s && s.transcripts_with_fingerprint === 1 && s.roots.length === 1 && s.roots[0] === other,
  `roots=${s && JSON.stringify(s.roots)}`);

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`sandbox: ${SANDBOX}`);
process.exit(fail ? 1 : 0);
