# 架构与设计

## 问题模型

参考网关（Xiaomi MiMo）对**整个请求**做内容审核，判定 high risk 时返回拒答。客户端侧表现为：

- 回合以 `ModelRefusalError`（`retryable:false`）结束，transcript 里留下一条
  `model:"<synthetic>"` 的拒答消息（Qoder：`displayErrorCode:406`）；
- 拒答是**概率型**的：同内容可能下一次就通过；
- 判定基于**发送出去的全部历史**，因此一次污染会持续生效。

推论：**预防 >> 恢复 >> 兜底**。三件套就是按这个顺序设计的。

## 组件与钩子契约

Qoder 钩子的通用契约：stdin 收事件 JSON、stdout 回控制 JSON、退出码 0=放行 / 2=阻断（视事件）、
任何异常都应 exit 0（fail-open）。

| 组件 | 事件 | 输入 | 输出 | 特殊字段 |
|---|---|---|---|---|
| content-firewall | `PostToolUse` | `tool_name/tool_response/model` | `hookSpecificOutput.updatedToolOutput` 替换工具结果 | `model` 用于模型门（**未列入官方字段清单，靠实测确认**；缺失时写 `no_model_skip` 审计，见 [KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md) 能力边界 5） |
| refusal-recovery | `StopFailure` | `error/error_details/transcript_path/model/session_id` | **exit 2 + stderr**（异步唤醒） | `asyncRewake:true` |

关键平台事实（详见 [ASYNCREWAKE.md](ASYNCREWAKE.md)）：

- `StopFailure` 是**通知级**事件——其输出与退出码被忽略，钩子无法直接阻断/重试；
- `asyncRewake` 钩子在后台运行，**exit 2 会向会话注入 `<task-notification>`** 并启动新回合——
  这是"把已经死掉的回合叫起来"的唯一官方杠杆；
- 拒答路径不触发 `Stop` 事件，因此不能靠"Stop 钩子续跑"这一常见手法。

## 设计原则

1. **fail-open**：三个脚本的任何异常都是 exit 0 / 无输出。过滤器坏掉的默认形态是"不干预"，
   而不是"断链"。
2. **零原文审计**：所有 `*-audit.jsonl` 只记时间戳、长度、规则名、计数与样本词干，
   永不记录被处理文本本身。
3. **结构不变量**：遮罩层永不删行、永不改变物理行数与字面 `\n` 结构（工具结果保持 JSON 形状），
   且从不重复遮蔽既有占位符。
4. **作用域最小化**：遮罩只对 `CONTENT_FIREWALL_MODEL_MATCH`（默认 `mimo`）命中的模型生效；
   其他模型拿到逐字节相同的输出（历史教训：无差别的过滤器会毁掉所有模型的工作）。
5. **重试必须有刹车**：自动恢复同时具备 窗口上限、退避、最小间隔、熔断与"仍死复核"，
   任何情况下都不会变成死循环（对照：无熔断的盲重试会把会话永远卡在拒答上）。
6. **人工优先的破坏性操作**：清洗 transcript 默认 dry-run、必须 `--apply`、强制备份、
   写后校验、活跃保护——它是操作者工具，不是钩子。

## 状态与文件

```
<config>/hooks/
  content-firewall-audit.jsonl       # 遮罩审计
  refusal-recovery-audit.jsonl       # 恢复动作审计（rewake/giveup/skip_*）
  refusal-recovery-state.json        # 每会话 attempts[] + lastWakeTs（原子写）
  refusal-recovery-attention.json    # 熔断标记，供你自己的 UX 钩子呈现并自清
  refusal-recovery.lock              # 跨进程互斥（120s 陈旧回收）
```

`refusal-recovery` 的审计 `action` 词表：
`rewake`（唤醒，含 attempt/max/backoff_ms）、`giveup`（熔断）、
`skip_notrefusal / skip_model / skip_alive / skip_unknown / skip_locked / skip_recent`、
`error`。

## 数据流（一次拒答的完整旅程）

```
1. 工具结果 →[firewall: 模型门→span 遮罩→残余层]→ 历史      （预防）
2. 网关拒答 → StopFailure 事件
   ├─ refusal-recovery：退避 → 复核仍死 → exit 2 → 注入唤醒 → 新回合   （恢复，≤N 次）
   └─ 超限 → attention 标记（永不唤醒）                              （熔断）
3. 熔断后：由你的 UX 钩子/巡检把标记递给用户
4. 内容锁死 → history-scrub dry-run → --apply → 重开/分支会话        （兜底）
```

## 与其他方案的关系

- **纯重试**（无熔断）：碰到"内容锁死"会无限打转——本项目的熔断就是为它设计的。
- **纯改写代理**（每个请求先过改写模型）：成本高、延迟大，且改写模型自身也可能拒答；
  本项目把"改写"压缩成注入指令，让主模型在下一次尝试里自然完成。
- **网关侧降级/换模型**：不是所有客户端都支持；本方案在客户端侧工作，与模型选择无关。
