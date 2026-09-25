#!/usr/bin/env node
// content-firewall — PostToolUse hook: mask explicit-content spans in tool results BEFORE
// they reach the model, so they never enter the conversation history.
//
// Why: some gateways (Xiaomi MiMo in the reference deployment) review the WHOLE request and
// refuse turns that carry "high risk" content. Once risky text lands in history it poisons
// every later request, so prevention beats recovery.
//
// Design invariants:
//   * in-place replacement — never deletes content; physical line count and literal "\n"
//     structure are preserved byte-for-byte, so tool results keep their shape
//   * units carrying structure hints (URL/version/selector/label...) are exempted on pass 1;
//     the residual tier then re-masks any still-exempt unit that holds real trigger words
//   * model gate: masking applies ONLY to the configured model family (default: /mimo/i);
//     every other model receives byte-identical output
//   * scan scope: hit counting runs over the FULL text (measured ~5 ms/MB) — the old 512 KiB
//     counting window silently skipped hits late in large tool results and is gone
//   * the model gate reads a field the published PostToolUse schema does not list (see
//     KNOWN-LIMITATIONS.md). When the field is ABSENT the hook stays passive but records
//     rule=no_model_skip, so the failure mode is observable instead of silent
//   * fail-open: any exception -> exit 0 with no output (a broken filter must never break the
//     agent); the audit jsonl records sizes/rules/counters only, never raw content
//
// Config (env):
//   CONTENT_FIREWALL_DISABLE=1       turn the hook off entirely
//   CONTENT_FIREWALL_DEBUG=1         add hit samples to the audit
//   CONTENT_FIREWALL_RESIDUAL=off    disable the residual tier (pass-1 only)
//   CONTENT_FIREWALL_MODEL_MATCH     regex for the gated model family (default "mimo")
//   QODER_CONFIG_DIR                 config root for hooks/audit (default ~/.qoder)
//
// Audit: <config>/hooks/content-firewall-audit.jsonl

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.QODER_CONFIG_DIR || path.join(os.homedir(), ".qoder");
const MODEL_MATCH = new RegExp(process.env.CONTENT_FIREWALL_MODEL_MATCH || "mimo", "i");
const MIN_CHARS = 400;
const UNIT_WINDOW = 160; // chars each side of a hit when expanding the masked unit
const WHOLE_SEG_HITS = 4; // >=4 hits in a hint-free segment -> mask the whole segment
const MASK = "[explicit descriptive content removed]";
const BLOCK_REPORT =
  "[content-firewall] BLOCKED: this tool result is an image/visual payload that is " +
  "itself the task target and cannot be safely summarized. Raw payload kept locally; " +
  "not forwarded. Refine the request (e.g. ask for element text / layout) or handle " +
  "this step manually.";

const EXPLICIT_SRC =
  "\\bexplicit\\b|\\bR18\\b|\\bNSFW\\b|\\b18\\+\\b|" +
  "\\bnud(?:e|ity)\\b|\\berotic\\b|\\bsex(?:ual|ually)?\\b|" +
  "\\bpornograph\\w*|\\bhentai\\b|\\berotic(?:a|al)?\\b|" +
  "\\borgasm\\w*|\\bbreast(?:s)?\\b|\\bpenis\\b|\\bvagina\\b|" +
  "\\bsexual(?:ly|ized)?\\b|\\barousal\\b|\\blingerie\\b|" +
  "性爱|做爱|露骨|情色|色情|裸体|乳房|阴茎|阴道|高潮|性暗示|性行为|成人向|里番";
const EXPLICIT_SEARCH = new RegExp(EXPLICIT_SRC, "i");
const PRESERVE =
  /(https?:\/\/|\.zip|\.rar|\.7z|\.exe|\.jar|download|manual install|requirements?|file size|version|uploaded|category|author|description\s*[:：]|\btab=|\bfile_id\b|\.json\b|\.py\b|selector|#[\w-]+(?=\s*[,{:]|\s*[>+~])|\bbutton\b|\bhref\b)/i;
const IMG_REF =
  /^(?:data:image\/[\w+.-]+;base64,[A-Za-z0-9+/=\s]+|[A-Za-z]:[\\/].*\.(?:png|jpe?g|webp|gif)\s*)$/i;
const IMAGE_TOOL = /screenshot|vision|capture_screenshot/i;
const TERM = /[.!?。！？；;\n]/;

const truthy = (v) => ["1", "true", "yes", "on"].includes(String(v || "").trim().toLowerCase());

function density(text) {
  // MASK contains "explicit" — strip placeholders before counting so the metric reflects
  // real leftover hits instead of matching its own output.
  const cleaned = text.split(MASK).join(" ");
  const hits = cleaned.match(new RegExp(EXPLICIT_SRC, "gi")) || [];
  return { count: hits.length, samples: hits.slice(0, 5) };
}

// Mask one segment in place. Returns {out, maskedUnits}.
// usePreserve=true (default): structure-hint units are exempted (kept verbatim).
// usePreserve=false: residual tier — even structure-hint units get masked.
function maskSegment(seg, usePreserve = true) {
  const local = new RegExp(EXPLICIT_SRC, "gi");
  const maskRanges = [];
  for (let i = seg.indexOf(MASK); i !== -1; i = seg.indexOf(MASK, i + MASK.length)) {
    maskRanges.push([i, i + MASK.length]);
  }
  const inMask = (i) => maskRanges.some(([a, b]) => i >= a && i < b);
  let out = "";
  let pos = 0;
  let masked = 0;
  let m;
  while ((m = local.exec(seg)) !== null) {
    if (m.index < pos) continue; // inside an already-processed (masked/exempt) region
    if (inMask(m.index)) continue; // never re-mask an existing placeholder
    // expand to a bounded unit around the hit
    let s = m.index;
    let e = m.index + m[0].length;
    while (s > 0 && m.index - s < UNIT_WINDOW && !TERM.test(seg[s - 1])) s--;
    while (e < seg.length && e - (m.index + m[0].length) < UNIT_WINDOW && !TERM.test(seg[e])) e++;
    const unit = seg.slice(s, e);
    if (usePreserve && PRESERVE.test(unit)) {
      // structure wins for this unit: keep verbatim, advance past it
      out += seg.slice(pos, e);
      pos = e;
      continue;
    }
    out += seg.slice(pos, s) + MASK;
    pos = e;
    masked++;
  }
  out += seg.slice(pos);
  return { out, maskedUnits: masked };
}

// One full masking pass: physical lines -> literal-\n splits -> per-segment span masking.
// usePreserve=false runs the residual tier (structure hints ignored).
function maskText(text, usePreserve = true) {
  const lines = text.match(/[^\n]*\n|[^\n]+/g) || [];
  const outLines = [];
  let maskedUnits = 0;
  for (const line of lines) {
    const nl = line.endsWith("\n") ? "\n" : "";
    const body = nl ? line.slice(0, -1) : line;
    // physical line done; further split on literal backslash-n (serialised JSON case)
    const subs = body.split("\\n");
    const handled = subs.map((sub) => {
      const cleanedSub = sub.split(MASK).join(" ");
      if (!EXPLICIT_SEARCH.test(cleanedSub)) return { s: sub, masked: 0 };
      const hits = (cleanedSub.match(new RegExp(EXPLICIT_SRC, "gi")) || []).length;
      if ((!usePreserve || !PRESERVE.test(sub)) && hits >= WHOLE_SEG_HITS) {
        return { s: MASK, masked: 1 }; // high-density tier: whole hint-free segment
      }
      const r = maskSegment(sub, usePreserve);
      return { s: r.out, masked: r.maskedUnits };
    });
    maskedUnits += handled.reduce((a, h) => a + h.masked, 0);
    outLines.push(handled.map((h) => h.s).join("\\n") + nl);
  }
  return { text: outLines.join(""), maskedUnits };
}

function sanitizeText(text) {
  const meta = { rule: null, rawLen: text.length, maskedUnits: 0, residualUnits: 0 };
  if (text.length < MIN_CHARS) return { text: null, meta };
  const { count, samples } = density(text);
  if (count === 0) return { text: null, meta };

  const pass1 = maskText(text, true);
  let newText = pass1.text;
  let maskedUnits = pass1.maskedUnits;

  // residual tier: trigger words that survived via structure hints would still trip the
  // gateway review — re-mask those units with PRESERVE disabled.
  const residualOff = ["0", "false", "no", "off"].includes(String(process.env.CONTENT_FIREWALL_RESIDUAL || "").trim().toLowerCase());
  let residualUnits = 0;
  if (!residualOff) {
    const left1 = density(newText);
    if (left1.count > 0) {
      const pass2 = maskText(newText, false);
      if (pass2.maskedUnits > 0) {
        newText = pass2.text;
        residualUnits = pass2.maskedUnits;
        maskedUnits += pass2.maskedUnits;
      }
    }
  }
  if (maskedUnits === 0) return { text: null, meta };
  const left = density(newText);
  meta.rule = residualUnits > 0 ? "mask_spans+residual" : "mask_spans";
  meta.maskedUnits = maskedUnits;
  meta.residualUnits = residualUnits;
  meta.remainingHits = left.count;
  meta.samples = samples;
  return { text: newText, meta };
}

function shouldBlock(toolName, result) {
  if (!IMAGE_TOOL.test(toolName || "")) return false;
  const body = result.trim();
  if (body.length > 4096) return false;
  return IMG_REF.test(body);
}

function audit(rec) {
  try {
    const p = path.join(BASE, "hooks", "content-firewall-audit.jsonl");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n", "utf8");
  } catch { /* audit must never break the agent */ }
}

function quit(out) {
  if (out) process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  try {
    if (truthy(process.env.CONTENT_FIREWALL_DISABLE)) return quit(null);
    const input = JSON.parse(raw);
    if (input.hook_event_name !== "PostToolUse") return quit(null);
    // model gate: only the configured model family needs masking (gateway review).
    const servedModel = String(input.model || "");
    if (!MODEL_MATCH.test(servedModel)) {
      // `model` is not in the published PostToolUse field list — if it ever disappears the
      // protection would silently no-op, so leave a trace instead of vanishing.
      if (!servedModel) audit({ session: input.session_id, tool: input.tool_name, rule: "no_model_skip", blocked: false, sensitive: false });
      return quit(null);
    }
    const toolName = String(input.tool_name || "");
    let result = input.tool_response;
    if (result == null) return quit(null);
    if (typeof result !== "string") result = JSON.stringify(result);
    if (!result) return quit(null);

    if (shouldBlock(toolName, result)) {
      audit({ session: input.session_id, tool: toolName, raw_len: result.length,
        out_len: BLOCK_REPORT.length, rule: "block_image_payload", blocked: true, sensitive: true });
      return quit({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: BLOCK_REPORT } });
    }
    if (result.length < MIN_CHARS) return quit(null);
    // never decorate error payloads — the model already has a bigger problem
    try {
      const parsed = JSON.parse(result);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
          "error" in parsed && Object.keys(parsed).length <= 3) return quit(null);
    } catch { /* not JSON */ }

    const { text, meta } = sanitizeText(result);
    if (!text) {
      if (truthy(process.env.CONTENT_FIREWALL_DEBUG) && meta.rule === null && result.length >= MIN_CHARS) {
        audit({ session: input.session_id, tool: toolName, raw_len: meta.rawLen,
          out_len: meta.rawLen, rule: "pass", blocked: false, sensitive: false });
      }
      return quit(null);
    }
    const rec = { session: input.session_id, tool: toolName, raw_len: meta.rawLen,
      out_len: text.length, rule: meta.rule, masked_units: meta.maskedUnits,
      residual_units: meta.residualUnits || 0,
      remaining_hits: meta.remainingHits, blocked: false, sensitive: true };
    if (truthy(process.env.CONTENT_FIREWALL_DEBUG)) {
      rec.reason = `explicit_hits_samples=${(meta.samples || []).join(",")}`;
    }
    audit(rec);
    quit({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: text } });
  } catch {
    quit(null); // fail-open
  }
});
process.stdin.on("error", () => quit(null));
