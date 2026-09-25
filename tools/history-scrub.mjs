#!/usr/bin/env node
// history-scrub — deep-recovery CLI for content-locked sessions.
//
// When a session is content-locked (every request refused by a gateway review and the
// auto-retry ladder has given up), the way out is to clean the STORED history: agent CLIs
// rebuild a session's context from its transcript JSONL on fork/resume, so masking the
// offending spans on disk lets the session come back clean on the next load.
//
// Properties:
//   * OPERATOR-INVOKED ONLY — never wired into any hook; dry-run by default; --apply writes.
//   * structure-preserving: one JSONL line per entry in/out, keys/types untouched, values are
//     masked with the same span algorithm as content-firewall.mjs (structure hints ignored =
//     aggressive). Never deletes or reorders entries.
//   * backup + atomic write + post-write verify (line count unchanged; every line that parsed
//     before still parses; lines that never parsed are preserved verbatim on purpose).
//   * refuses transcripts modified in the last 60s (likely a live session) unless --force.
//
// Usage:
//   node history-scrub.mjs --session <id> [--projects-dir <dir>] [--pattern <regex>] [--json]
//   node history-scrub.mjs --session <id> --apply            # write (backup made)
//   node history-scrub.mjs --transcript <path> --apply --pattern "MYCANARY"
//
// NOTE: the masking core below is a deliberate copy of content-firewall's core. The hook is a
// self-contained stdin script and is not importable; keep the two in sync when rules change.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MASK = "[explicit descriptive content removed]";
const UNIT_WINDOW = 160;
const WHOLE_SEG_HITS = 4;
const DEFAULT_SRC =
  "\\bexplicit\\b|\\bR18\\b|\\bNSFW\\b|\\b18\\+\\b|" +
  "\\bnud(?:e|ity)\\b|\\berotic\\b|\\bsex(?:ual|ually)?\\b|" +
  "\\bpornograph\\w*|\\bhentai\\b|\\berotic(?:a|al)?\\b|" +
  "\\borgasm\\w*|\\bbreast(?:s)?\\b|\\bpenis\\b|\\bvagina\\b|" +
  "\\bsexual(?:ly|ized)?\\b|\\barousal\\b|\\blingerie\\b|" +
  "性爱|做爱|露骨|情色|色情|裸体|乳房|阴茎|阴道|高潮|性暗示|性行为|成人向|里番";
const TERM = /[.!?。！？；;\n]/;

function density(text, SRC) {
  const cleaned = text.split(MASK).join(" ");
  const hits = cleaned.match(new RegExp(SRC, "gi")) || [];
  return { count: hits.length };
}

function maskSegment(seg, SRC) {
  const local = new RegExp(SRC, "gi");
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
    if (m.index < pos) continue;
    if (inMask(m.index)) continue;
    let s = m.index;
    let e = m.index + m[0].length;
    while (s > 0 && m.index - s < UNIT_WINDOW && !TERM.test(seg[s - 1])) s--;
    while (e < seg.length && e - (m.index + m[0].length) < UNIT_WINDOW && !TERM.test(seg[e])) e++;
    out += seg.slice(pos, s) + MASK;
    pos = e;
    masked++;
  }
  out += seg.slice(pos);
  return { out, maskedUnits: masked };
}

// Aggressive single pass: no structure exemptions (deep-recovery intent).
function maskText(text, SRC) {
  const lines = text.match(/[^\n]*\n|[^\n]+/g) || [];
  const outLines = [];
  let maskedUnits = 0;
  for (const line of lines) {
    const nl = line.endsWith("\n") ? "\n" : "";
    const body = nl ? line.slice(0, -1) : line;
    const subs = body.split("\\n");
    const handled = subs.map((sub) => {
      const cleanedSub = sub.split(MASK).join(" ");
      if (density(cleanedSub, SRC).count === 0) return sub;
      const hits = (cleanedSub.match(new RegExp(SRC, "gi")) || []).length;
      if (hits >= WHOLE_SEG_HITS) { maskedUnits++; return MASK; }
      const r = maskSegment(sub, SRC);
      maskedUnits += r.maskedUnits;
      return r.out;
    });
    outLines.push(handled.join("\\n") + nl);
  }
  return { text: outLines.join(""), maskedUnits };
}

function scrubValue(v, pathArr, SRC, stats) {
  if (typeof v === "string") {
    const r = maskText(v, SRC);
    if (r.maskedUnits > 0) {
      stats.units += r.maskedUnits;
      if (stats.changedPaths.length < 12) stats.changedPaths.push(`${pathArr.join(".")} (${r.maskedUnits})`);
      return r.text;
    }
    return v;
  }
  if (Array.isArray(v)) return v.map((x, i) => scrubValue(x, pathArr.concat(`[${i}]`), SRC, stats));
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = scrubValue(v[k], pathArr.concat(k), SRC, stats);
    return o;
  }
  return v;
}

// ---- CLI ----
const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(name);
const SESSION = arg("--session");
const TRANSCRIPT = arg("--transcript");
const PATTERN = arg("--pattern");
const PROJECTS_DIR = arg("--projects-dir") || path.join(os.homedir(), ".qoder", "projects");
const APPLY = has("--apply");
const FORCE = has("--force");
const AS_JSON = has("--json");
const SRC = PATTERN ? PATTERN : DEFAULT_SRC;

const die = (msg, code = 1) => { console.error(`[history-scrub] ${msg}`); process.exit(code); };

function findTranscript(sid) {
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === `${sid}.jsonl`) hits.push(p);
    }
  };
  walk(PROJECTS_DIR, 0);
  return hits;
}

try {
  let tp = TRANSCRIPT;
  if (!tp) {
    if (!SESSION) die("need --session <id> or --transcript <path>");
    const hits = findTranscript(SESSION);
    if (hits.length === 0) die(`no transcript found for session ${SESSION} under ${PROJECTS_DIR}`);
    if (hits.length > 1) die(`multiple transcripts for session ${SESSION}:\n  ${hits.join("\n  ")}\nuse --transcript to pick one`);
    tp = hits[0];
  }
  if (!fs.existsSync(tp)) die(`transcript not found: ${tp}`);
  const st = fs.statSync(tp);
  if (!FORCE && Date.now() - st.mtimeMs < 60000) {
    die(`transcript was modified ${Math.round((Date.now() - st.mtimeMs) / 1000)}s ago — likely a LIVE session. ` +
        `Wait for it to go idle, or pass --force if you are sure.`);
  }

  const raw = fs.readFileSync(tp, "utf8");
  const hadTrailingNl = raw.endsWith("\n");
  const lines = raw.split("\n");
  if (hadTrailingNl) lines.pop();
  const outLines = [];
  const stats = { entries: lines.length, parsed: 0, unparsed: 0, units: 0, changedLines: 0, changedPaths: [] };
  for (const line of lines) {
    if (!line.trim()) { outLines.push(line); continue; }
    let j;
    try { j = JSON.parse(line); } catch { stats.unparsed++; outLines.push(line); continue; }
    stats.parsed++;
    const before = stats.units;
    const scrubbed = scrubValue(j, [], SRC, stats);
    if (stats.units > before) { stats.changedLines++; outLines.push(JSON.stringify(scrubbed)); }
    else outLines.push(line); // byte-identical for untouched entries
  }
  const newRaw = outLines.join("\n") + (hadTrailingNl ? "\n" : "");
  const leftHits = density(newRaw, SRC).count;

  const summary = {
    ts: new Date().toISOString(), session: SESSION || null, transcript: tp, pattern: PATTERN || "(default explicit set)",
    entries: stats.entries, parsed: stats.parsed, unparsed: stats.unparsed,
    units_masked: stats.units, changed_lines: stats.changedLines,
    changed_paths: stats.changedPaths, remaining_hits: leftHits,
    applied: false, backup: null, bytes_in: raw.length, bytes_out: newRaw.length,
  };

  if (stats.units === 0) {
    if (AS_JSON) console.log(JSON.stringify(summary));
    else console.log(`[history-scrub] nothing to mask (entries=${stats.entries}, unparsed=${stats.unparsed}). ${APPLY ? "No write." : ""}`);
    process.exit(0);
  }

  if (!APPLY) {
    if (AS_JSON) console.log(JSON.stringify(summary));
    else console.log(`[history-scrub] DRY-RUN: would mask ${stats.units} unit(s) across ${stats.changedLines} line(s); ` +
      `remaining_hits_after=${leftHits}; paths: ${stats.changedPaths.join(" | ")}. Re-run with --apply to write.`);
    process.exit(0);
  }

  // atomic write + backup + verify
  const bak = `${tp}.bak-scrub-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}`;
  fs.copyFileSync(tp, bak);
  const tmp = `${tp}.tmp-scrub-${process.pid}`;
  fs.writeFileSync(tmp, newRaw, "utf8");
  const verify = fs.readFileSync(tmp, "utf8");
  const vLines = verify.split("\n");
  if (hadTrailingNl) vLines.pop();
  if (vLines.length !== lines.length) { fs.unlinkSync(tmp); die(`verify failed: line count ${vLines.length} != ${lines.length}; original untouched`); }
  let bad = 0;
  for (let i = 0; i < vLines.length; i++) {
    const l = vLines[i];
    if (!l.trim()) continue;
    let outOk = true; try { JSON.parse(l); } catch { outOk = false; }
    if (outOk) continue;
    // a line that did not parse before is preserved verbatim on purpose — not a failure
    let inOk = true; try { JSON.parse(lines[i] ?? ""); } catch { inOk = false; }
    if (!inOk) continue;
    bad++;
  }
  if (bad > 0) { fs.unlinkSync(tmp); die(`verify failed: ${bad} line(s) do not parse; original untouched`); }
  fs.renameSync(tmp, tp);

  summary.applied = true;
  summary.backup = bak;
  if (AS_JSON) console.log(JSON.stringify(summary));
  else console.log(`[history-scrub] APPLIED: masked ${stats.units} unit(s) in ${stats.changedLines} line(s). ` +
    `backup=${bak} remaining_hits=${leftHits}`);
  process.exit(0);
} catch (e) {
  die(String(e).slice(0, 400));
}
