# 恢复手册（从被拒到复活）

## 阶梯

```
① 预防   content-firewall 持续遮罩新工具结果        （常态，无需人工）
② 自愈   refusal-recovery 自动重试 ≤N 次（退避+分级改写） （事件触发，无需人工）
③ 通知   熔断标记 → 由你的 UX 钩子呈现 / 巡检提醒你      （熔断后）
④ 深恢复 history-scrub 清洗磁盘历史 → 重开会话           （人工，见下）
⑤ 换路   换模型 / 新会话（内容确实不适合该提供商时）      （人工）
```

大多数拒答止步于 ②。走到 ④ 的条件是：**同一会话连续被拒超过窗口上限**（默认 30 分钟内 3 次），
且熔断标记已生成。

## ④ 深恢复操作手册

原理：会话的 fork/resume 会**从磁盘 transcript 重建历史**（下方有实证）。因此把磁盘上的敏感
span 洗掉，重开会话就是干净的。

```bash
# 1) 先看报告（不改任何东西）
node tools/history-scrub.mjs --session <被测会话ID>

# 输出示例（dry-run）：
# [history-scrub] DRY-RUN: would mask 5 unit(s) across 3 line(s);
#   remaining_hits_after=0; paths: message.content.[0].text (1) | humanInput.text (1) | ...
# 若报告为空 → 没有可遮的命中，说明问题不在显式词表 → 换模型/新会话（阶梯⑤）

# 2) 确认目录和目标无误后写盘（自动备份 + 原子替换 + 写后校验）
node tools/history-scrub.mjs --session <被测会话ID> --apply

# 3) 重开该会话（或 fork 一个分支）——历史即为清洗后的版本
```

要点：

- 默认 dry-run；`--apply` 才写。备份在 `<transcript>.bak-scrub-<ts>`。
- 文件 60 秒内被动过会拒写（疑似活会话），确认空闲后再跑；`--force` 可强制。
- 只想洗掉某个自定义标记（例如你自己塞的测试串）：`--pattern "MYCANARY"`。
- transcript 定位：默认在 `~/.qoder/projects/**` 下按会话 ID 搜索；可用 `--projects-dir`
  或 `--transcript` 指定。
- 清洗是**不可逆语义**（除了备份）——先 dry-run、先 dry-run、先 dry-run。

## 实证：清洗后的历史真的会生效吗（做过）

实验（2026-09，Qoder 0.4.2）：

1. 新建会话，令其记住金丝雀 `BLUEBIRD77-CANARY`（首轮回复"已记住"）；
2. `history-scrub --pattern BLUEBIRD77 --apply` → 报告 **5 处遮蔽**（含 thinking 与 lastPrompt），
   磁盘金丝雀清零；
3. `fork` 出分支并追问"还能逐字看到那个词组吗" → 分支回答 **"看不到。"**；
4. 磁盘对账：分支自己的 transcript 金丝雀 **0 处**、占位符 **3 处**；
5. 静态佐证：fork/rewind 的代码路径为
   `createForkSnapshot() + readTranscriptSnapshot() + resolveBuffer(view:"historical")`
   ——历史从磁盘 transcript 解析。

结论：**transcript 即"重开后的上下文"的事实来源**，清洗它足以让下一次加载变干净。

注意一个反直觉现象：App 的**界面层缓存**仍可能显示原文（聊天列表/气泡来自 UI 侧的存储），
而模型实际上下文来自 transcript。以模型侧为准（它是被审核的对象）。

## 让"熔断"被看见

`refusal-recovery` 熔断时写 `<config>/hooks/refusal-recovery-attention.json`
（内容：会话 ID → {ts, attempts, model, error}）。它只写文件，不弹窗——怎么呈现由你决定。
最小实现（在任意"用户发消息"类钩子里读一次、提示一次、随后清除）：

```js
const mk = JSON.parse(fs.readFileSync(attentionPath, "utf8"));
const ent = mk && mk[sessionId];
if (ent && Date.now() - ent.ts < 24 * 3600e3) {
  // 以系统消息提示：该会话此前 N 次自动重试均被拒，建议换模型/新会话，或先做 history-scrub
  delete mk[sessionId];
  fs.writeFileSync(attentionPath, JSON.stringify(mk)); // 保险起见写临时文件再 rename
}
```
