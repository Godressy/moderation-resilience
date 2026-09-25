// history-scrub.mjs tests.
// Sandbox-only: verifies dry-run vs apply, backup/atomic/verify, structure preservation,
// idempotence, custom patterns, the live-session guard and the --session search mode.
//   node tests/history-scrub.test.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const TOOL = fileURLToPath(new URL("../tools/history-scrub.mjs", import.meta.url));
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "hs-test-"));

const FIXTURE_LINES = (sid) => [
  JSON.stringify({ type: "user", sessionId: sid, model: "mimo-v2.6-flash",
    message: { content: [{ type: "text", text: "请分析这段文本里的 explicit 标注和 NSFW 标签。BLUEBIRD77" }] } }),
  JSON.stringify({ type: "assistant", model: "mimo-v2.6-flash",
    message: { content: [{ type: "text", text: "中性回复，不含敏感词，也不含其他内容。" }] } }),
  "{not json garbage line",
  JSON.stringify({ type: "tool-result", toolUseResult: { output: "统计结果：色情 一词出现 3 次。BLUEBIRD77 也在这里。" } }),
];
const mkFixture = (name, sid = "TEST-scrub") => {
  const p = path.join(SANDBOX, name + ".jsonl");
  fs.writeFileSync(p, FIXTURE_LINES(sid).join("\n") + "\n", "utf8");
  fs.utimesSync(p, new Date(Date.now() - 600000), new Date(Date.now() - 600000)); // 10 min old
  return { path: p, lines: FIXTURE_LINES(sid) };
};
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const run = (args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8", timeout: 20000 });
const jsonOf = (r) => { try { return JSON.parse((r.stdout || "").trim()); } catch { return null; } };
const linesOf = (p) => { const s = fs.readFileSync(p, "utf8"); const ls = s.split("\n"); if (s.endsWith("\n")) ls.pop(); return ls; };
const diag = (r) => `exit=${r.status} err=${(r.stderr || "").trim().slice(0, 110)}`;

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  cond ? pass++ : fail++;
};

// S1: dry-run — reports, writes nothing, no backup
const f1 = mkFixture("s1");
const f1sha = sha(f1.path);
let r = run(["--transcript", f1.path, "--json"]);
let j = jsonOf(r);
check("S1 dry-run reports", j && j.units_masked >= 2 && j.applied === false, diag(r) + ` units=${j && j.units_masked}`);
check("S1 file untouched", sha(f1.path) === f1sha && !fs.readdirSync(SANDBOX).some((x) => x.includes(".bak-scrub-")));

// S2: apply — backup + masked + line count + JSON validity of real entries
r = run(["--transcript", f1.path, "--apply", "--json"]);
j = jsonOf(r);
const ls2 = linesOf(f1.path);
let parsedOk = true;
for (const i of [0, 1, 3]) { try { JSON.parse(ls2[i]); } catch { parsedOk = false; } }
check("S2 applied w/ backup", j && j.applied === true && j.backup && fs.existsSync(j.backup), diag(r));
check("S2 line count & validity", ls2.length === 4 && parsedOk);
check("S2 words masked, remaining 0", !fs.readFileSync(f1.path, "utf8").includes("explicit 标注") && j.remaining_hits === 0,
  `remaining=${j && j.remaining_hits}`);

// S3: structure preserved; untouched line byte-identical; garbage line kept
const f3 = mkFixture("s3");
r = run(["--transcript", f3.path, "--apply", "--json"]);
const ls3 = linesOf(f3.path);
const ass = JSON.parse(ls3[1]);
check("S3 keys preserved", ass.type === "assistant" && ass.model === "mimo-v2.6-flash" && ass.message.content[0].type === "text");
check("S3 neutral line byte-identical", ls3[1] === f3.lines[1]);
check("S3 garbage line kept verbatim", ls3[2] === "{not json garbage line");

// S4: idempotent second apply (rewind mtime first — S3's apply just wrote it)
const before4 = sha(f3.path);
fs.utimesSync(f3.path, new Date(Date.now() - 600000), new Date(Date.now() - 600000));
r = run(["--transcript", f3.path, "--apply", "--json"]);
j = jsonOf(r);
check("S4 idempotent (no further change)", j && j.units_masked === 0 && sha(f3.path) === before4, diag(r));

// S5: custom pattern only masks the canary
const f5 = mkFixture("s5");
r = run(["--transcript", f5.path, "--apply", "--pattern", "BLUEBIRD77", "--json"]);
j = jsonOf(r);
const txt5 = fs.readFileSync(f5.path, "utf8");
check("S5 custom pattern: canary masked", !txt5.includes("BLUEBIRD77") && j.units_masked >= 2, `units=${j && j.units_masked} ${diag(r)}`);
check("S5 default words untouched by custom pattern", txt5.includes("explicit 标注") && txt5.includes("色情"));

// S6: live-session guard (fresh mtime) + --force bypass
const f6src = mkFixture("s6src");
const f6live = path.join(SANDBOX, "s6.jsonl");
fs.copyFileSync(f6src.path, f6live);
fs.utimesSync(f6live, new Date(), new Date()); // Windows copyFileSync preserves source mtime — force fresh
r = run(["--transcript", f6live, "--apply", "--json"]);
check("S6 live guard refuses", r.status === 1 && /LIVE session/.test(r.stderr || ""), diag(r));
r = run(["--transcript", f6live, "--apply", "--force", "--json"]);
check("S6 --force bypasses", r.status === 0 && jsonOf(r).applied === true, diag(r));

// S7: search mode (--session + --projects-dir)
const projDir = path.join(SANDBOX, "projects", "C--Some-Proj");
fs.mkdirSync(projDir, { recursive: true });
const sid7 = "abc-123-def";
const f7 = path.join(projDir, sid7 + ".jsonl");
fs.writeFileSync(f7, FIXTURE_LINES(sid7).join("\n") + "\n", "utf8");
fs.utimesSync(f7, new Date(Date.now() - 600000), new Date(Date.now() - 600000));
r = run(["--session", sid7, "--projects-dir", path.join(SANDBOX, "projects"), "--json"]);
j = jsonOf(r);
check("S7 session search finds transcript", j && j.transcript.endsWith(sid7 + ".jsonl") && j.units_masked >= 2, diag(r));

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`sandbox: ${SANDBOX}`);
process.exit(fail ? 1 : 0);
