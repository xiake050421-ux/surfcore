# 2026-10-30 QQ 回合被 DSH 闸门拦掉（blocked），桥接静默吞消息

## 现象

- 用户原话：「bot又不理我了」（18:18）。
- 具体表现：QQ 私聊里主人发「晚上好」，消息被读走（`[reserved2] 消息已入未读`），但没有任何回复；
  `state/bridge.log` 只有一行 `回合完成但无文本 (private:2972340740)`，没有任何报错。
- 更早还发生过两次：17:13:16 群 `group:663273916`、17:40:30 私聊。
- 影响面：消息不丢（会话日志里有 `agent/inbox/spliced removedCount:1` 说明它被 claim 过），
  但**这一轮的内容彻底没被模型看到**，用户侧就是"已读不回"。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | Windows 11 / DSH 0.2.1-rc.5 |
| SurfCore 版本 | 0.7.0（junction 安装） |
| 其它相关版本 | SnowLuma 2.2.1、Node 22 |
| DSH GUI 端口 | 事发时 3899（当天从 11850 → 2475 → 4385 → 3899 漂移过） |

## 根因

- 代码位置（现象侧）：`src/bridge.js` 的 turn-end 分支 `else if (!ended.text.trim())`，
  原注释写「completed 但没文本（纯工具调用回合）」——把 `blocked` 也归进了这一类。
- 问题链条：
  1. DSH 的 `agent/pre-step` 返回 `{kind:"reject"}` 时，`@deepseek-ai/dsh-agent-loop` 把回合结束原因记成
     `{"kind":"blocked"}`，并且**丢弃本轮 claim 的消息**、模型一步都不跑。
  2. 会话日志里能看到这种回合 `turn/start` → `turn/end` 只隔 12~13ms，中间只有
     `agent/inbox/spliced {removedCount:1}`。
  3. 桥接收到 `turn/end` 后，因为 `ended.text` 为空，走「无文本」分支，只打一行日志就结束了，
     用户侧完全无感知。
- DSH 侧只有两处会返回 reject：`ArchivedSessionGate`（会话被归档）和 `goal-round-driver`（目标轮次状态失效）。
  本次排查：
  - 会话投影 `storages/session_projcache/sessions/session-3ac7591e-….json` 里 `goal.current` 是 `null` → 排除 goal；
  - `storages/workspace.json` 的 `archivedSessionIds` 里**不含**两个 QQ 会话 → 归档名单也不成立。
  - 重启桥接后，**同一个会话**立刻恢复正常（18:24 正常回复「晚上好呀，主人」），说明会话数据没坏，
    问题出在那个桥接进程与 DSH 的连接状态上（DSH 当天 17:00 左右自己重启过一次，端口 4385 → 3899）。
  - 确切是哪条闸门没抓到直接证据：DSH 侧没有输出 reject 原因，`bridge_status`/会话日志都只留 `blocked`。

## 修法

`src/bridge.js`：

1. 新增 `lastPromptByKey`（记住每个会话最后一次投递的文本与媒体）与 `blockedRetries`（连续被拦次数）。
   在 `deliverPromptNow()` 里 `ensureSession()` 成功后写入。
2. turn-end 分支里先判 `ended.reason.kind === 'blocked'`：
   - 记 `⚠️ 回合被 DSH 闸门拦截（blocked）无输出 (key)，第 N 次：退役会话并重建`，并写 `qq-activity.log`；
   - `retireSession(key)`：丢掉本地会话映射，下一条消息自动建新会话；
   - 用 `enqueueForRetry()` 把刚才那条消息重投（最多 2 次，`wakeReason: 'blocked-retry'`），
     超过就停止并留日志。
3. 正常的「纯工具调用无文本」回合仍然只打日志，不受影响。

## 取舍

- A：只在日志里把 `blocked` 标红——成本最低，但用户还是会看到"已读不回"。
- B（采用）：识别 `blocked` → 退役会话 + 重投。代价是一条消息最多重投 2 次，
  收益是自愈；会话映射重建是既有的安全路径（`ensureSession` 本来就在 DSH 重启时这么做）。
- C：把重投推迟到后台队列、最多 5 次——会让"确实被拦"的会话在队列里反复打转，暂时不做。

## 生效与重启

改的是 `src/bridge.js`（桥接进程），必须重启桥接：
`taskkill` 掉 3100 上的 pid（提权）→ 删 `state/bridge.lock` → 跑 `SurfCore-Bridge-Autostart.vbs`。

## 验证

- `node --check src/bridge.js` 通过。
- 重启桥接后 `POST /api/socialV2/wake {key:'private:2972340740',reason:'admin'}`，
  日志出现 `已设置会话模型 session-3ac7591e… -> deepseek-account/deepseek-flash (max)` 与
  `[reserved2] 工具统一发送 private:2972340740: 成功 2/2 条`，会话日志最后一个 `turn/end` 是
  `{"kind":"completed"}`（turn 26）。
- 下次再出现 `blocked`，日志里应是 `⚠️ 回合被 DSH 闸门拦截…退役会话并重建`，随后自动重投。

## 回滚与残余

- 回滚：`git revert` 本次提交即可；旧行为是"静默打一行日志"。
- 残余：
  - DSH 为什么在这个会话上返回 reject 还没拿到直接证据（DSH 不输出 reject 原因）。
    下次复现时优先看 DSH 主进程日志与 `workspaceRegistry.archivedSessionIds` 的实时值。
  - 桥接连着的 DSH 端口变了（4385 → 3899）之后是否会留下"半失效连接"仍未验证。
  - 自动重投上限 2 次；如果桥接连接本身就是坏的，两次都会失败，表现为日志里连打 3 条警告。
