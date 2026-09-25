# moderation-resilience — 给 Qoder + 小米 MiMo 网关用的会话韧性工具

> Keep agent CLI sessions alive when an over-triggering gateway content review kills turns.
> Built for **Qoder hooks** + the **Xiaomi MiMo** gateway (`/mimo/i` model family by default):
> mask → recover → scrub → observe, zero dependencies, plain Node ESM. Developed and used daily
> by the author; first published 2026-09, **not yet independently validated**.

[English](#english) · 中文说明见下

---

## ⚠️ 定位与免责（先读）

本项目的目标是**缓解自动化内容审核的误杀**（审核系统会把无害文本判为 high risk），以及在被
拒答后**自动恢复会话**——服务于你自己、合法、你已有权处理的内容。

- 仅在你自己的账号、你自己的内容上使用；
- 遵守模型服务商的服务条款与当地法律；**不要用于违法内容**；
- 这类工具可能违反某些平台条款（例如被解读为规避审核），并可能带来账号风险——请自行判断；
- 我们不对使用后果负责（MIT 协议，见 LICENSE）。

本仓库不包含、也不会包含任何"越狱提示词"或内容生成能力——它只做四件事：**遮罩、重试、通知、清洗**。

## 这是什么

一些网关（参考部署：Xiaomi MiMo）会对**整个请求**做内容审核：判定 "high risk" 就直接拒答
（HTTP 200 + `stop_reason:"refusal"`，官方错误码 421），回合当场死亡。三个要命特性决定了一切：

1. **概率型**——同样内容这一次被拒、下一次可能通过；
2. **整段历史判定**——脏内容一旦进入对话历史，之后每次请求都背着它；
3. **客户端不会重试**——Qoder 把拒答标为 `retryable:false`，内置重试无效。

因此本项目提供五件（预防 → 恢复 → 兜底 → 观测）：

| 组件 | 挂点 | 一句话 |
|---|---|---|
| `hooks/content-firewall.mjs` | PostToolUse | 工具结果进模型**之前**把敏感片段原位遮罩（结构/行数不变），仅对指定模型族生效 |
| `hooks/refusal-recovery.mjs` | StopFailure + `asyncRewake` | 拒答后**自动把会话叫起来**：退避 → 复核 → 分级改写指令，每会话窗口最多 N 次，超出熔断 |
| `tools/history-scrub.mjs` | 命令行（人工） | 内容锁死时**清洗磁盘上的 transcript**，重开/分支会话即干净复活 |
| `hooks/refusal-watchdog.mjs` | 手动 / 由 prompt-gate 限流拉起 | **零模型请求**的本地巡检：扫 transcript 拒答指纹并分类，把告警投进收件箱（不删、不改、不请求） |
| `hooks/prompt-gate.mjs` | UserPromptSubmit | 输入密度提醒（默认只警告，不回显）+ 呈报收件箱与熔断标记 + 限流拉起巡检 |

```
工具结果 ─[content-firewall]→ 模型上下文        ← 预防（只对目标模型族）
拒答事件 ─[refusal-recovery]→ 自动重试 ×≤N → 熔断标记
熔断后  ─[history-scrub]→ 清洗历史 → 重开会话复活   ← 人工兜底
全程    ─[refusal-watchdog]→ 本地巡检 → [prompt-gate] 在你下次发消息时呈报一次  ← 观测（零请求）
```

> 巡检为什么不做成"定时自动化任务"：那样每次运行都会往同一个会话里堆上下文、并真发一次模型
> 请求（额度/费用）；本实现是纯本地文件扫描，等价检测、零成本。

## 快速开始

前提：Node ≥ 20、Qoder CLI/App（或任何实现了等价钩子契约的客户端）。

1. 把仓库放到任意目录，记下绝对路径。
2. 在 `~/.qoder/settings.json` 里加钩子（模板见 `settings.example.json`）：

```jsonc
{
  "hooks": {
    "PostToolUse": [{ "hooks": [{
      "type": "command",
      "command": "node \"<ABS_PATH>/hooks/content-firewall.mjs\"",
      "timeout": 10
    }]}],
    "StopFailure": [{ "hooks": [{
      "type": "command",
      "command": "node \"<ABS_PATH>/hooks/refusal-recovery.mjs\"",
      "name": "refusal-recovery",
      "asyncRewake": true,                 // ← 关键：后台执行 + exit 2 唤醒会话
      "rewakeMessage": "[refusal-recovery]",
      "rewakeSummary": "gateway refusal auto-recovery",
      "timeout": 180
    }]}],
    "UserPromptSubmit": [{ "hooks": [{
      "type": "command",
      "command": "node \"<ABS_PATH>/hooks/prompt-gate.mjs\"",
      "timeout": 10
    }]}]
  }
}
```

3. 跑测试确认环境正常（五套共 70 条断言，全部在临时沙盒里跑，不碰真实数据）：

```bash
node tests/content-firewall.test.mjs
node tests/refusal-recovery.test.mjs
node tests/history-scrub.test.mjs
node tests/refusal-watchdog.test.mjs
node tests/prompt-gate.test.mjs
```

## 环境变量（全部可选）

| 变量 | 默认 | 作用 |
|---|---|---|
| `CONTENT_FIREWALL_DISABLE` | — | 置 1 完全停用遮罩 |
| `CONTENT_FIREWALL_RESIDUAL` | 开 | 置 off 关闭"残余层"（结构豁免行不再二次遮罩） |
| `CONTENT_FIREWALL_MODEL_MATCH` | `mimo` | 遮罩生效的模型族正则 |
| `REFUSAL_RECOVERY_DISABLE` | — | 置 1 停用自动恢复 |
| `REFUSAL_RECOVERY_BACKOFF_MS` | `10000,40000,90000` | 每次重试前退避 |
| `REFUSAL_RECOVERY_MAX` / `_WINDOW_MS` / `_GAP_MS` | `3` / `30min` / `8s` | 熔断上限 / 统计窗口 / 最小间隔 |
| `REFUSAL_WATCHDOG_DISABLE` | — | 置 1 不拉起巡检 |
| `REFUSAL_WATCHDOG_ROOTS` | — | 额外要扫的 transcript 根（路径分隔符分隔） |
| `REFUSAL_WATCHDOG_WINDOW_HOURS` | `24` | 巡检只看这个时间窗内动过的 transcript |
| `CONTENT_GATE_HITS` | `8` | 输入密度提醒阈值 |
| `CONTENT_GATE_BLOCK` | — | 置 1 把提醒变成真拦截（exit 2） |
| `CONTENT_GATE_DISABLE` | — | 置 1 完全停用输入门（含呈报与拉起） |
| `CONTENT_GATE_SPAWN_MS` | `5min` | 巡检拉起节流 |
| `QODER_CONFIG_DIR` | `~/.qoder` | 配置与审计根目录 |

审计与状态文件一律**零原文**（只记长度、规则名、计数），位置：`<config>/hooks/*-audit.jsonl`、
`refusal-recovery-state.json`、`refusal-recovery-attention.json`、`refusal-watchdog-{state,pending}.json`。

## 文档

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — 架构、契约与设计原则
- [`docs/ASYNCREWAKE.md`](docs/ASYNCREWAKE.md) — **`asyncRewake` 唤醒通道**（上游未文档化，含实测原文）
- [`docs/RECOVERY-PLAYBOOK.md`](docs/RECOVERY-PLAYBOOK.md) — 熔断后的操作手册 + 深恢复实证
- [`docs/KNOWN-LIMITATIONS.md`](docs/KNOWN-LIMITATIONS.md) — 已知边界与未验证项（诚实清单）

## 移植到其他客户端

核心机制是平台中立的（遮罩算法、状态机、清洗），但钩子契约是 Qoder 形态的。移植要点：

- **Claude Code**：等价杠杆是 `Stop` 钩子（exit 2 = 阻止停止并把 stderr 喂回模型）；
  拒答检测需要换成扫描 transcript 中的拒答特征；遮罩可用 `PostToolUse` 的
  `hookSpecificOutput.updatedToolOutput`（同名字段，语义一致）。
- **其他客户端**：只要满足"能读取工具结果并可替换" + "能拿到会话事件" + "有一个能把消息
  重新注入会话的通道"，这套组件都能搬。详见 `docs/ARCHITECTURE.md` 的契约表。

## English

**moderation-resilience** mitigates false-positive blocks from strict gateway content reviews
and auto-recovers refused turns in agent CLI sessions. Built for **Qoder hooks + the Xiaomi MiMo
gateway**. Five components: a PostToolUse **content-firewall** (in-place span masking of tool
results, structure-preserving, gated to a configurable model family), a StopFailure +
`asyncRewake` **refusal-recovery** hook (backoff → still-dead re-check → escalating instructions
→ hard retry cap), a CLI **history-scrub** tool (backup + atomic + verified masking of the
stored transcript so a reloaded session comes back clean; proved via a fork experiment — see
docs), a zero-model-request **refusal-watchdog** patrol (local transcript scan, classification,
inbox — it never calls a model, because the first design ran as a scheduled agent turn and paid
context + quota for every check), and a UserPromptSubmit **prompt-gate** (density warning,
one-shot surfacing of recovery notices, throttled patrol spawn).

Developed and used daily by the author since 2026-09. Published as-is: no third-party validation
yet. Node ≥ 20, zero deps.
Disclaimers: use only on your own accounts/content, comply with provider terms and local law,
no unlawful use. MIT.

## License

MIT — see [LICENSE](LICENSE).
