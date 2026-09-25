// content-firewall.mjs tests.
// Runs the hook against a sandbox config dir with fabricated payloads; asserts the masking
// rules, the two historical defect fixes and the residual tier. No external deps.
//   node tests/content-firewall.test.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../hooks/content-firewall.mjs", import.meta.url));
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "cf-test-"));
fs.mkdirSync(path.join(SANDBOX, "hooks"), { recursive: true });

const MASK = "[explicit descriptive content removed]";
const NEUTRAL = "这是一段中性的流程说明，用于把测试文本堆到最小长度阈值之上，不包含任何真实业务数据。";
const pad = (core) => {
  let s = NEUTRAL + NEUTRAL + core;
  while (s.length < 520) s += NEUTRAL;
  return s;
};

const run = (text, model = "mimo-v2.6-flash", envOver = {}) => spawnSync(process.execPath, [HOOK], {
  input: JSON.stringify({ hook_event_name: "PostToolUse", session_id: "TEST", model,
    tool_name: "Read", tool_input: {}, tool_response: text }),
  encoding: "utf8", timeout: 20000,
  env: { ...process.env, QODER_CONFIG_DIR: SANDBOX, ...envOver },
});
const parseOut = (r) => {
  const s = (r.stdout || "").trim();
  if (!s) return { changed: false, text: "" };
  try {
    const j = JSON.parse(s);
    const upd = j.hookSpecificOutput && j.hookSpecificOutput.updatedToolOutput;
    return { changed: typeof upd === "string", text: String(upd || "") };
  } catch { return { changed: false, text: "" }; }
};
const auditFile = path.join(SANDBOX, "hooks", "content-firewall-audit.jsonl");
const auditCount = () => { try { return fs.readFileSync(auditFile, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };
const lastAudit = () => {
  try { const ls = fs.readFileSync(auditFile, "utf8").split("\n").filter(Boolean); return JSON.parse(ls[ls.length - 1]); }
  catch { return null; }
};

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  cond ? pass++ : fail++;
};

// T1: plain hit -> masked; remaining_hits must be 0 (the placeholder must not match itself)
let r = run(pad("这里讨论了 explicit 标注的定义与流程。"));
let o = parseOut(r); let a = lastAudit();
check("T1 masked", o.changed && o.text.includes(MASK));
check("T1 remaining_hits=0 (MASK self-match fixed)", a && a.remaining_hits === 0 && a.masked_units >= 1,
  `rule=${a && a.rule} masked=${a && a.masked_units} remaining=${a && a.remaining_hits}`);

// T2: '#foo' must not exempt the unit (narrowed PRESERVE)
r = run(pad("配置项 #foo 这里写了裸体相关的说明文字。"));
o = parseOut(r); a = lastAudit();
check("T2 '#foo' unit masked (PRESERVE narrowed)", o.changed && o.text.includes(MASK) && a && a.remaining_hits === 0,
  `rule=${a && a.rule} remaining=${a && a.remaining_hits}`);

// T3: structure hint inside the unit -> pass 1 exempts, residual tier masks anyway
r = run(pad("版本字段 version 标记之后紧接着出现了色情字样说明。"));
a = lastAudit();
check("T3 residual tier masks structure unit", a && a.rule === "mask_spans+residual" && a.residual_units >= 1 && a.remaining_hits === 0,
  `rule=${a && a.rule} residual=${a && a.residual_units} remaining=${a && a.remaining_hits}`);

// T4: URL prefix inside the unit window -> same path as T3
r = run(pad("露骨内容见 https://example 页面"));
a = lastAudit();
check("T4 URL unit residual-masked", a && a.rule === "mask_spans+residual" && a.remaining_hits === 0,
  `rule=${a && a.rule} remaining=${a && a.remaining_hits}`);

// T5: line-count invariant across the double pass
const multi = ["第一行中性说明。", pad("版本字段 version 标记之后紧接着出现了色情字样说明。"), "末行中性说明。"].join("\n");
r = run(multi); o = parseOut(r);
check("T5 line count preserved", o.changed && (o.text.match(/\n/g) || []).length === (multi.match(/\n/g) || []).length);

// T6: a pre-existing placeholder is never counted as a hit; the new hit still gets masked
r = run(pad(`旧文本 ${MASK} 另有新出现的 NSFW 描述。`));
o = parseOut(r); a = lastAudit();
const maskCount = (o.text.match(/\[explicit descriptive content removed\]/g) || []).length;
check("T6 old MASK not counted as hit; NSFW masked", o.changed && !o.text.includes("NSFW") && maskCount >= 1 && a && a.remaining_hits === 0,
  `maskOccurrences=${maskCount} masked_units=${a && a.masked_units} remaining=${a && a.remaining_hits}`);

// T7: non-gated model -> byte-identical passthrough
r = run(pad("这里讨论了 explicit 标注的定义与流程。"), "DeepSeek-Flash");
check("T7 non-gated model passthrough", !(r.stdout || "").trim());

// T8: CONTENT_FIREWALL_RESIDUAL=off -> pass-1 only; an all-exempt text passes through (documented leak)
const n8 = auditCount();
r = run(pad("版本字段 version 标记之后紧接着出现了色情字样说明。"), "mimo-v2.6-flash", { CONTENT_FIREWALL_RESIDUAL: "off" });
check("T8 residual off -> all-exempt text passes through (documented leak)", !(r.stdout || "").trim() && auditCount() === n8,
  `stdoutLen=${(r.stdout || "").trim().length} auditDelta=${auditCount() - n8}`);

// T9: high-density structure line -> whole segment masked in the residual pass
r = run(pad("version 说明：色情 裸体 性爱 做爱 分别出现了一次。"));
o = parseOut(r); a = lastAudit();
check("T9 high-density residual whole-seg mask", a && a.rule === "mask_spans+residual" && a.remaining_hits === 0 && o.text.includes(MASK),
  `rule=${a && a.rule} masked=${a && a.masked_units}`);

// T10: selector-combinator context recognized on pass 1, residual catches it
r = run(pad("样式 #main > p 区域出现情色描述文本"));
a = lastAudit();
check("T10 combinator ctx -> residual", a && a.rule === "mask_spans+residual" && a.remaining_hits === 0,
  `rule=${a && a.rule} remaining=${a && a.remaining_hits}`);

// T11: structure lines without hits stay byte-identical through both passes
const t11 = ["版本说明 version 2.1 中性与流程无关", pad("下载说明 download 页面包含露骨描述字样"), "结束行 version 仍应原样保留"].join("\n");
r = run(t11); o = parseOut(r);
check("T11 hint line without hits untouched", o.changed && o.text.includes("version 2.1 中性与流程无关") && o.text.includes("结束行 version 仍应原样保留"),
  `firstLineKept=${o.text.includes("version 2.1")}`);

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`sandbox: ${SANDBOX}`);
process.exit(fail ? 1 : 0);
