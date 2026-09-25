# moderation-resilience

> Keep agent CLI sessions alive when an over-triggering gateway content review kills turns.
> Reference implementation for **Qoder hooks** + the Xiaomi MiMo gateway, battle-tested in daily
> use. Zero dependencies, plain Node ESM.

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

因此本项目提供三件套（预防 → 恢复 → 兜底）：

| 组件 | 挂点 | 一句话 |
|---|---|---|
| `hooks/content-firewall.mjs` | PostToolUse | 工具结果进模型**之前**把敏感片段原位遮罩（结构/行数不变），仅对指定模型族生效 |
| `hooks/refusal-recovery.mjs` | StopFailure + `asyncRewake` | 拒答后**自动把会话叫起来**：退避 → 复核 → 分级改写指令，每会话窗口最多 N 次，超出熔断 |
| `tools/history-scrub.mjs` | 命令行（人工） | 内容锁死时**清洗磁盘上的 transcript**，重开/分支会话即干净复活 |

```
工具结果 ─[content-firewall]→ 模型上下文        ← 预防（只对目标模型族）
拒答事件 ─[refusal-recovery]→ 自动重试 ×≤N → 熔断标记
熔断后  ─[history-scrub]→ 清洗历史 → 重开会话复活   ← 人工兜底
```

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
    }]}]
  }
}
```

3. 跑测试确认环境正常（三套共 42 条断言，全部在临时沙盒里跑，不碰真实数据）：

```bash
node tests/content-firewall.test.mjs
node tests/refusal-recovery.test.mjs
node tests/history-scrub.test.mjs
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
| `QODER_CONFIG_DIR` | `~/.qoder` | 配置与审计根目录 |

审计与状态文件一律**零原文**（只记长度、规则名、计数），位置：`<config>/hooks/*-audit.jsonl`、
`refusal-recovery-state.json`、`refusal-recovery-attention.json`。

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
  重新注入会话的通道"，三件套都能搬。详见 `docs/ARCHITECTURE.md` 的契约表。

## English

**moderation-resilience** mitigates false-positive blocks from strict gateway content reviews
and auto-recovers refused turns in agent CLI sessions. Three components: a PostToolUse
**content-firewall** (in-place span masking of tool results, structure-preserving, gated to a
configurable model family), a StopFailure + `asyncRewake` **refusal-recovery** hook (backoff →
still-dead re-check → escalating instructions → hard retry cap), and a CLI **history-scrub**
tool (backup + atomic + verified masking of the stored transcript so a reloaded session comes
back clean; proved via a fork experiment — see docs).

Battle-tested with Qoder hooks + the Xiaomi MiMo gateway in daily use. Node ≥ 20, zero deps.
Disclaimers: use only on your own accounts/content, comply with provider terms and local law,
no unlawful use. MIT.

## License

MIT — see [LICENSE](LICENSE).
