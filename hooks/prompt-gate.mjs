#!/usr/bin/env node
// prompt-gate — UserPromptSubmit hook with three jobs:
//   1. density warning on the incoming prompt (warn by default, never echoing matched text)
//   2. surfacing, once, the notices the recovery layer produced while nobody was looking:
//        * refusal-recovery give-up markers (this session is content-locked)
//        * refusal-watchdog inbox items (a refusal happened somewhere; see refusal-watchdog.mjs)
//   3. throttled spawn of the zero-model-request patrol (a local file scan, no model call)
//
// Deliberate philosophy: the operator legitimately analyses sensitive material, so an
// unconditional hard block would fight its own user. Default = warn (systemMessage with
// counts only). CONTENT_GATE_BLOCK=1 turns the warning into a real block (exit 2).
// Nothing here re-injects matched fragments into the conversation.
//
// Config (env):
//   QODER_CONFIG_DIR             config root (default ~/.qoder)
//   CONTENT_GATE_HITS            hit threshold for the density warning (default 8)
//   CONTENT_GATE_BLOCK=1         block (exit 2) instead of warn
//   CONTENT_GATE_DISABLE=1       turn the whole hook off
//   CONTENT_GATE_SPAWN_MS        patrol spawn throttle, ms (default 300000)
//   REFUSAL_WATCHDOG_DISABLE=1   never spawn the patrol
//
// Audit: <config>/hooks/prompt-gate-audit.jsonl — metadata only (lengths/counts), no prompt text.
// fail-open: any exception -> exit 0.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const BASE = process.env.QODER_CONFIG_DIR || path.join(os.homedir(), ".qoder");
const EXPLICIT_SRC =
  "\\bexplicit\\b|\\bR18\\b|\\bNSFW\\b|\\b18\\+\\b|" +
  "\\bnud(?:e|ity)\\b|\\berotic\\b|\\bsex(?:ual|ually)?\\b|" +
  "\\bpornograph\\w*|\\bhentai\\b|\\berotic(?:a|al)?\\b|" +
  "\\borgasm\\w*|\\bbreast(?:s)?\\b|\\bpenis\\b|\\bvagina\\b|" +
  "\\bsexual(?:ly|ized)?\\b|\\barousal\\b|\\blingerie\\b|" +
  "性爱|做爱|露骨|情色|色情|裸体|乳房|阴茎|阴道|高潮|性暗示|性行为|成人向|里番";

const truthy = (v) => ["1", "true", "yes", "on"].includes(String(v || "").trim().toLowerCase());

function audit(rec) {
  try {
    const p = path.join(BASE, "hooks", "prompt-gate-audit.jsonl");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n", "utf8");
  } catch { /* audit must never break input */ }
}

function quit(out, code = 0) {
  if (out) process.stdout.write(JSON.stringify(out));
  process.exit(code);
}

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  try {
    if (truthy(process.env.CONTENT_GATE_DISABLE)) return quit(null);
    const input = JSON.parse(raw);
    if (input.hook_event_name !== "UserPromptSubmit") return quit(null);
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    if (!prompt) return quit(null);

    const threshold = parseInt(process.env.CONTENT_GATE_HITS || "8", 10) || 8;
    const hits = (prompt.match(new RegExp(EXPLICIT_SRC, "gi")) || []).length;
    const notices = [];

    // refusal-recovery give-up marker: shown once, then cleared so it never nags.
    try {
      const mp = path.join(BASE, "hooks", "refusal-recovery-attention.json");
      const mk = JSON.parse(fs.readFileSync(mp, "utf8"));
      const ent = mk && mk[input.session_id];
      if (ent && Date.now() - Number(ent.ts || 0) < 24 * 3600 * 1000) {
        notices.push(
          `⚠️ refusal-recovery: ${ent.attempts} auto-retries for this session were refused by the gateway ` +
          `(content-locked). Repeating the same turn is pointless — switch model, start a new session, ` +
          `or scrub the stored history first (tools/history-scrub.mjs).`
        );
        delete mk[input.session_id];
        const tmp = mp + ".tmp-" + process.pid;
        fs.writeFileSync(tmp, JSON.stringify(mk), "utf8");
        fs.renameSync(tmp, mp);
      }
    } catch { /* marker surfacing must never break input */ }

    // refusal-watchdog inbox: zero-model-request patrol results, surfaced once.
    try {
      const wp = path.join(BASE, "hooks", "refusal-watchdog-pending.json");
      const w = JSON.parse(fs.readFileSync(wp, "utf8"));
      const its = w && Array.isArray(w.items) ? w.items : [];
      for (const it of its.slice(0, 4)) {
        notices.push(
          `⚠️ refusal-watchdog: gateway refusal in session ${String(it.session || "").slice(0, 8)} ` +
          `at ${String(it.ts || "").slice(11, 16)} (${it.detail || "?"}). If refusal-recovery already ` +
          `re-woke that session, ignore this; if it is still stuck, switch model / start a new session, ` +
          `or scrub the stored history.`
        );
      }
      if (its.length > 4) notices.push(`⚠️ refusal-watchdog: ${its.length - 4} more event(s) — see refusal-watchdog-pending.json.`);
      if (its.length) fs.rmSync(wp, { force: true });
    } catch { /* inbox surfacing must never break input */ }

    // throttled patrol spawn: pure local file scan (no model call, no request quota).
    try {
      if (!truthy(process.env.REFUSAL_WATCHDOG_DISABLE)) {
        const claim = path.join(BASE, "hooks", "refusal-watchdog-spawn.json");
        const throttle = Math.max(1000, Number(process.env.CONTENT_GATE_SPAWN_MS || 5 * 60 * 1000) || 5 * 60 * 1000);
        let last = 0;
        try { last = Number(JSON.parse(fs.readFileSync(claim, "utf8")).ts) || 0; } catch { /* first run */ }
        if (Date.now() - last > throttle) {
          fs.writeFileSync(claim, JSON.stringify({ ts: Date.now() }), "utf8");
          const child = spawn(process.execPath, [path.join(BASE, "hooks", "refusal-watchdog.mjs")], {
            detached: true, stdio: "ignore", windowsHide: true,
          });
          child.unref();
        }
      }
    } catch { /* patrol is best-effort */ }

    if (hits < threshold) return notices.length ? quit({ systemMessage: notices.join("\n") }) : quit(null);

    const block = truthy(process.env.CONTENT_GATE_BLOCK);
    audit({ session: input.session_id, mode: block ? "block" : "warn", rule: "prompt_density", prompt_len: prompt.length, hits });

    if (block) {
      // exit 2 blocks; stderr becomes the feedback the operator sees.
      process.stderr.write(
        `[prompt-gate] this prompt hit ${hits} explicit-content matches and was blocked to keep the session ` +
        `history clean. Trim it to the task-relevant excerpt and resend (no matched text is echoed here).`
      );
      return quit(null, 2);
    }
    notices.push(
      `⚠️ prompt-gate: this prompt hit ${hits} explicit-content matches (threshold ${threshold}). ` +
      `Passed in warn mode — dense sensitive text in the history raises the chance of a gateway refusal; ` +
      `consider trimming long pastes (CONTENT_GATE_BLOCK=1 to block instead).`
    );
    return quit({ systemMessage: notices.join("\n") });
  } catch {
    quit(null); // fail-open
  }
});
process.stdin.on("error", () => quit(null));
