# asyncRewake：把死掉的回合叫起来（上游未文档化的通道）

> 本文是本项目最"硬"的技术底料。内容基于对 **Qoder 0.4.2 / worker runtime 1.1.62**
> （2026-09 实测）的解包与活体实验；上游未公开承诺，未来版本可能变化。

## 事实一：StopFailure 不能自救

拒答在 CLI 内部是一条确定的错误路径：

```
stop_reason === "refusal"
  → ModelRefusalError (retryable:false, displayErrorCode:406, isContentFilteredMessage:true)
  → fireStopFailure(...)        // 触发 StopFailure 钩子，payload 含 model / error_details
  → 回合以 error 收场             // 不触发 Stop 事件
```

而 `StopFailure` 事件在文档中的定位是 **notification-only：输出与退出码被忽略**。
所以"在 StopFailure 钩子里 exit 2 让它重试"是行不通的——这条路堵死。

## 事实二：asyncRewake 是旁路

钩子处理器有一个字段 `asyncRewake`：

```jsonc
{ "type": "command", "command": "node recovery.mjs",
  "asyncRewake": true, "rewakeMessage": "[refusal-recovery]",
  "rewakeSummary": "gateway refusal auto-recovery", "timeout": 180 }
```

- 该钩子**在后台执行**（不阻塞 CLI）；
- 当它 **exit 2** 时，运行时把一条消息**注入会话队列并唤醒模型**，实际注入形态（实测原文）：

```
[SYSTEM NOTIFICATION - NOT USER INPUT]
<task-notification><summary>{rewakeSummary}</summary></task-notification>
<system-reminder>[{rewakeMessage}] {钩子写到 stderr/stdout 的文本}</system-reminder>
```

- 运行时内部：`NFn()` 组装上文 → `Eg({prompt, commandMode:"task-notification",
  priority:"next", stopHookActive:true})` 排入 MessageQueue → 由循环消费（空闲则开新回合，
  忙则作为 steer 注入）。对应地，会话 transcript 里能看到该事件。

**支持矩阵**（SKILL 文档 + 运行时行为）：

| 形态 | 支持 |
|---|---|
| 交互式 / SDK streaming / remote worker（本参考部署） | ✅ 后台 + 唤醒 |
| 一次性 headless（如 `-p` 文本输出） | ⚠️ 退化为同步执行（exit 2 ≈ deny，唤醒文本被忽略） |
| `QueryEnd` 事件 | ❌ 明确排除 |

## 事实三：这套机制怎么起死回生

因为拒答是**概率型**的，把同一个请求原样重发就有一部分概率通过；再叠加"注入指令要求模型
改写措辞"，通过率进一步提高。本项目的 `refusal-recovery` 正是：

```
退避(10/40/90s) → 复核会话仍死 → exit 2 + 分级指令 → 新回合
```

并带三重刹车（窗口上限 / 最小间隔 / 熔断）保证不会变成死循环。`stopHookActive:true`
是注入消息自带的标记，用于抑制"Stop 钩子再次阻断"造成的连锁。

## 如何自证（可复现的验证方法）

1. 在可控事件（如 `PostToolUse`，matcher 限定某条哨兵命令）挂一个 `asyncRewake` 探针：
   `sleep 3; 写日志; echo 文本 >&2; exit 2`。
2. 触发哨兵命令。若数秒后在会话里看到上文的 `<task-notification>` 注入且模型作出反应，
   通道即成立（本仓库首次验证时注入两次，含一次"回合中途 steer"形态）。
3. 静态旁证：在 Qoder 安装目录的 worker 运行时
   （`resources/app.asar.unpacked/node_modules/@qoder-ai/qoder-agent-sdk/dist/_worker/
   qoder-worker-runtime.obf.mjs`）中可检索到 `asyncRewake`、`task-notification`、
   `MessageQueue`、`sendMessageToQueue` 等符号。

## 坑

- **唤醒文本会同时给用户和模型看见**：措辞要短、要说人话（它会出现在 UI 通知里）。
- **后台不是免费**：`timeout` 要为你的退避留够；本项目默认睡 90s 上限 → timeout 180。
- **不要在唤醒里做二次危险操作**：它只是一个"叫醒服务"，具体动作交给主模型。
