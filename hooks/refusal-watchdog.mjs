#!/usr/bin/env node
// refusal-watchdog — zero-model-request patrol over local session transcripts.
//
// Why a patrol at all: a gateway refusal is invisible unless you go looking. The first
// design ran this check as a scheduled *agent turn*, which was wrong on two counts — every
// run appended to one long conversation (context growth) and every run cost a model request
// (quota). This script does the same detection with pure local file scans: no model call,
// no session writes, no deletions.
//
// Invocation:
//   * detached child of prompt-gate.mjs (throttled there, so this stays cheap)
//   * manual / scheduler: node refusal-watchdog.mjs [--json] [--root <dir>]... [--window-hours N]
//
// Scans:
//   A) refusal-recovery-audit.jsonl — entries with action rewake|giveup newer than the previous
//      scan (in-session recoveries the operator should hear about).
//   B) session transcripts (modified within the window; subagents/ and dot-dirs skipped) for the
//      strict refusal fingerprint `"model":"<synthetic>"`. That fingerprint alone is NOT
//      refusal-specific: quota/auth failures land the same way, so every hit is classified by
//      text and only real refusals are queued (see REFUSAL_RE / QUOTA_RE).
//
// Output:
//   <config>/hooks/refusal-watchdog-state.json    {lastScanTs, notified[]}  (dedup)
//   <config>/hooks/refusal-watchdog-pending.json  {ts, items[]}             (read+cleared by prompt-gate)
//
// Never calls a model. Never writes to a transcript. Never deletes anything.
//
// Config (env):
//   QODER_CONFIG_DIR              config root (default ~/.qoder)
//   REFUSAL_WATCHDOG_ROOTS        extra transcript roots, path-delimiter separated
//   REFUSAL_WATCHDOG_WINDOW_HOURS scan window for transcripts (default 24)
//
// Audit: <config>/hooks/refusal-watchdog-state.json + ...-pending.json only.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CFG = process.env.QODER_CONFIG_DIR || path.join(os.homedir(), ".qoder");
const HOOKS = path.join(CFG, "hooks");
const STATE = path.join(HOOKS, "refusal-watchdog-state.json");
const PENDING = path.join(HOOKS, "refusal-watchdog-pending.json");
const AUDIT = path.join(HOOKS, "refusal-recovery-audit.jsonl");
const FINGERPRINT = '"model":"<synthetic>"';
const REFUSAL_RE = /contains sensitive content|considered high risk|content[_ ]?polic|content[_ ]?filter|try switching models/i;
const QUOTA_RE = /daily usage limit|billing daily count|come back tomorrow|quota exceeded/i;
const MAX_NOTIFIED = 200;
const MAX_PENDING = 50;
const DEFAULT_WINDOW_H = 24;

const argv = process.argv.slice(2);
const wantJson = argv.includes("--json");
const argVal = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const rootsArg = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === "--root" && argv[i + 1]) rootsArg.push(argv[i + 1]);
const envRoots = String(process.env.REFUSAL_WATCHDOG_ROOTS || "")
  .split(path.delimiter)
  .map((s) => s.trim())
  .filter(Boolean);
const ROOTS = rootsArg.length ? rootsArg : [path.join(CFG, "projects"), ...envRoots];
const WINDOW_MS =
  Math.max(1, Number(argVal("--window-hours") || process.env.REFUSAL_WATCHDOG_WINDOW_HOURS || DEFAULT_WINDOW_H)) * 3600 * 1000;

function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } }
function writeJsonAtomic(p, obj) {
  const tmp = p + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj), "utf8");
  fs.renameSync(tmp, p);
}
function cutoff(ts) {
  if (typeof ts === "number") return ts;
  if (typeof ts === "string") { const t = Date.parse(ts); if (Number.isFinite(t)) return t; }
  return 0;
}

const state = readJson(STATE, null) || { lastScanTs: 0, notified: [] };
const since = cutoff(state.lastScanTs) || (Date.now() - WINDOW_MS);
const notified = new Set(Array.isArray(state.notified) ? state.notified : []);
const items = [];

// ---------- scan A: recovery-hook audit ----------
let auditEvents = 0;
try {
  for (const line of fs.readFileSync(AUDIT, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const ts = cutoff(j.ts);
    if (ts <= since) continue;
    if (j.action !== "rewake" && j.action !== "giveup") continue;
    auditEvents++;
    const key = `${j.session || "?"}|${j.action}|${new Date(ts).toISOString().slice(0, 16)}`;
    if (notified.has(key)) continue;
    notified.add(key);
    items.push({
      session: String(j.session || ""), ts: new Date(ts).toISOString(),
      kind: j.action === "giveup" ? "giveup" : "recovered",
      model: j.model || "",
      detail: j.action === "giveup" ? `${j.attempts || "?"} retries refused` : "auto re-wake fired",
    });
  }
} catch { /* audit absent -> nothing to report */ }

// ---------- scan B: transcripts carrying the strict fingerprint ----------
let scannedFiles = 0, scannedBytes = 0;
const walk = (dir, out) => {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name === "subagents" || e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) {
      try { const st = fs.statSync(p); if (Date.now() - st.mtimeMs <= WINDOW_MS || st.mtimeMs > since) out.push(p); } catch { /* skip */ }
    }
  }
  return out;
};
const files = [];
for (const r of ROOTS) if (fs.existsSync(r)) walk(r, files);
const kinds = { refusal: 0, quota: 0, other: 0 };
for (const f of files) {
  let txt = "";
  try { txt = fs.readFileSync(f, "utf8"); } catch { continue; }
  if (!txt.includes(FINGERPRINT)) continue;
  scannedFiles++; scannedBytes += txt.length;
  const session = path.basename(f).replace(/\.jsonl$/, "");
  for (const line of txt.split("\n")) {
    if (!line.includes(FINGERPRINT)) continue;
    let ts = 0, model = "", text = "";
    try {
      const j = JSON.parse(line);
      ts = cutoff(j.timestamp);
      model = String(j.model || (j.message && j.message.model) || "");
      const c = (j.message && j.message.content) ?? j.content;
      if (typeof c === "string") text = c;
      else if (Array.isArray(c)) text = c.map((x) => (x && typeof x.text === "string" ? x.text : "")).join(" ");
    } catch { /* keep raw */ }
    if (ts && ts <= since) continue;
    const kind = REFUSAL_RE.test(text) ? "refusal" : QUOTA_RE.test(text) ? "quota" : "other";
    kinds[kind]++;
    const key = `${session}|${kind}|${ts ? new Date(ts).toISOString().slice(0, 16) : "?"}`;
    if (notified.has(key)) continue;
    notified.add(key);
    // quota/auth failures already surface in-session as a visible assistant message; stay silent.
    if (kind !== "refusal") continue;
    items.push({
      session, ts: ts ? new Date(ts).toISOString() : new Date().toISOString(),
      kind: "refusal", model, detail: path.basename(path.dirname(f)),
    });
  }
}

// ---------- persist ----------
const now = Date.now();
try {
  fs.mkdirSync(HOOKS, { recursive: true });
  writeJsonAtomic(STATE, { lastScanTs: new Date(now).toISOString(), notified: Array.from(notified).slice(-MAX_NOTIFIED) });
} catch { /* never break the caller */ }

if (items.length) {
  const prev = readJson(PENDING, { items: [] });
  const merge = Array.isArray(prev.items) ? prev.items : [];
  const seen = new Set(merge.map((x) => `${x.session}|${x.ts}`));
  for (const it of items) if (!seen.has(`${it.session}|${it.ts}`)) merge.push(it);
  try { writeJsonAtomic(PENDING, { ts: new Date(now).toISOString(), items: merge.slice(-MAX_PENDING) }); } catch { /* ignore */ }
}

const summary = {
  ts: new Date(now).toISOString(), since: new Date(since).toISOString(),
  roots: ROOTS, transcripts_with_fingerprint: scannedFiles, transcript_bytes: scannedBytes,
  audit_events: auditEvents, synthetic_seen: kinds, new_items: items.length, items,
};
if (wantJson) process.stdout.write(JSON.stringify(summary, null, 1) + "\n");
process.exit(0);
