# 2026-10-30 QQ 端「DSH 任务」通道 + 每日 60 秒日报

## 现象

- 用户原话（m02155）：「怎么发给大肥鱼插件qq信息，不理我」
- 用户原话（m02243）：「2」——选择「给 QQ 端加受控的 DSH 任务工具」这条路线
- 用户原话（m02530）：「让他每天中午十二点读取60s，发在群里」
- 影响面：私聊完全静默（不是崩溃，是没被唤醒）；迁移到 surfcore 后聊天会话**没有任何本地工具**，所以「操作电脑」这件事整体消失；群里到点没有任何自动播报。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | Windows 11 / DSH 桌面版（bundle 含 surfcore） |
| SurfCore 版本 | v0.7.0（git clone，`E:\大肥鱼 dsh\surfcore`） |
| 安装方式 | git（profile 用 `scripts/setup-dsh.mjs desktop` 注册 bundle） |
| 其它相关版本 | SnowLuma 2.2.1（QQ 1953950841）、Node 24.22.1、OneBot HTTP 3000 / WS 3001 |

## 根因

1. **私聊不理人**：`src/bridge.js` 的 `socialV2.tokenGuard` 默认 `privateMaxWakesPerDay: 10`。日志原话：
   `[token-guard] 跳过唤醒 private:2972340740（private）：Token 防爆破：这个会话今天已经醒了 10/10 次，今天不再唤醒`。
   消息进了未读队列，但会话不再唤醒 → 用户看到「已读不回」。
2. **没法操作电脑**：`qq-chat-v2` preset 在**注册期**（`src/qq-tool-restrict.mjs`）就把本地工具剔掉了，规则里也写着「你没有本地工具」。
   所以 AstrBot 时代的 `dsh_run` 能力在迁移后整体丢失，聊天会话只能聊天。
3. **每日日报不存在**：桥接只有「目的 / 搭话 / 收尾」这类社交定时器，没有「到点发固定内容」的任务通道。

## 完整逻辑

- **链路**
  - 唤醒：OneBot WS → `src/bridge.js` 消息泵 → `evaluateWakeBudget()`（`src/token-guard.js`）→ 允许则 `prompt` 聊天会话。
  - 任务：模型调用 MCP `qq_dsh_task`（`src/mcp-snowluma-safe.js`）→ 本机 `POST /api/socialV2/dsh-task` → `runDshTask()` 校验 owner → `runDshWorker()` → DSH `sessions/prompt` 到**独立 worker 会话** → `waitLearnerTurn()` 等 `turn/end` → 结果回给模型 → 模型用自己的话回 QQ。
  - 日报：`setInterval(dailyNewsTick, 30000)` → 到点且当天没发过 → `runDailyNews()` → 同一个 worker（联网检索）→ `onebotSend('group', ...)` 直接发群。
- **机制**
  - `tokenGuard` 是「每次唤醒都记一笔」的预算制，私聊与群聊分开计；撞顶后当天不再唤醒，但**消息仍在**（所以不是丢消息）。
  - worker 会话是**复用的静默会话**，而 `pumpMux` 的 learner 分支在 turn 结束时会 `learnerSessions.delete(sessionId)`（它假设学习会话用完即弃）。不重新登记就收不到第二次 `turn/end` —— 这是「第二条任务必超时」的真因，不是 DSH 慢。
  - 定时发群绕开聊天会话，是因为 `qq-chat-v2` 的 L7 边界（聊天会话不能发消息工具）必须保留；桥接本来就有 OneBot 长连接与群白名单，由它发最省事也最安全。
- **爆炸半径**
  - 进程：桥接 1 个；文件：`config.json`、`state/schedule-state.json`；读者：桥接自身 + 控制台。
  - 静默=3 项（超时/退回/退避），报错=1；碰钱（worker 会话按次计费）→ 因此失败后有 10 分钟退避、单日最多 6 次。
  - 命令执行仍受 DSH 侧沙箱与审批约束：后台会话没人点审批时会**失败而不是假成功**。
- **取舍**
  - A：让聊天会话直接拿到工具 → 破坏 L7 边界，群友也可能触发，否决。
  - B（采用）：单独 worker 会话 + 桥接侧按 `private:<ownerQQ>` 硬校验；聊天会话只保留一个转发工具。
  - 日报：A 让 AI 自己定时发（依赖它醒着）→ 不稳定；B（采用）桥接定时器 + 一次 worker 检索。
- **生效与重启**：`config.json` 只在桥接启动时读；`loadConfig()` 是**白名单式**归一化，新增配置段必须同时在 `loadConfig()` 里声明默认值，否则运行时读到 `undefined`（本次踩过：日志打出「发到群 (未配置)」）。DSH 侧 preset/MCP 工具变更需要重启 DSH。

## 修法

- `src/bridge.js`
  - 新增 `runDshWorker(instruction, timeoutMs)`（无权限判定）+ `runDshTask()` 复用；worker 每次 prompt 前 `learnerSessions.add(sessionId)`。
  - 新增 `POST /api/socialV2/dsh-task`（agent token 或 console token，`not-owner` → 403）。
  - 新增 `runDailyNews()`、`dailyNewsTick()`、`state/schedule-state.json`（按天去重 + 10 分钟失败退避 + 单日 6 次上限 + 2 小时补发窗口）、`POST /api/schedule/run`。
  - `loadConfig()` 新增 `schedule.dailyNews`（`enabled/time/groupId/itemCount/timeoutMs`）。
- `src/mcp-snowluma-safe.js`：新增 MCP 工具 `qq_dsh_task`（参数 `key/token/instruction/timeoutMs`，用原生 fetch 以保留 `hint`）。
- `dsh/agent-presets/qq-chat-v2/agent.cordis.yml`：保留「你没有本地工具」原文（测试断言该不变量），另起一行说明唯一例外是 `qq_dsh_task`。
- `config.json`（不入库）：`socialV2.tokenGuard` 放宽到 40/30、`schedule.dailyNews = {enabled:true, time:"12:00", groupId:"663273916", itemCount:10}`。
- 回滚：`git revert` 上述文件；`config.json` 里把 `schedule.dailyNews.enabled` 设 false、`tokenGuard` 改回默认。

## 验证

- 单测：`node scripts/test-preset-prompt.mjs` → `pass 12 / fail 0`；`npm run test:audit` → `81/81 scripts passed`（需完整权限，沙箱下 spawn 会 EPERM）。
- 任务通道：连续两次任务（C 盘剩余、系统时间）均 `ok:true`，耗时 17.9s / 4.4s；MCP stdio 自检 `has qq_dsh_task: true`。
- 真实 QQ：13:46 控制台唤醒私聊 → 她调用工具 → 13:46:40 完成 → 回「一共 15.4 G，用了 9.85 G，还剩 5.55 G」。
- 日报：`POST /api/schedule/run {job:"dailyNews", force:true}` → 26 秒后 `messageId: -449223307`，日志「已发到群 663273916（10 条）」；再次触发返回 `{"ok":false,"code":"already"}`。
- 失败路径：`not-owner` → 403 + 「这个工具只在主人的私聊里可用」；worker 超时 → 「执行端一直没回话，等到超时了」；日报失败 → 10 分钟后重试。

## 残余

- 需要改系统设置、写工作区外文件的任务，仍会卡在 DSH 的审批弹窗上（后台没人点），表现为超时而不是成功；要放宽需改 DSH 文件策略。
- `dailyNews` 的内容依赖 worker 联网检索，源站结构变了会退化成「搜不到」，此时不发（不会发空消息）。
- 未验证：连续多天运行后的 `schedule-state.json` 增长率（每天一条同 key 覆盖，理论上恒定）。

## 交接块（给发布会话）

```
文件：src/bridge.js、src/mcp-snowluma-safe.js、dsh/agent-presets/qq-chat-v2/agent.cordis.yml、plugins/surfcore/presets/qq-chat-v2.patch.yml
测试：npm run test:audit 81/81（完整权限）；test-preset-prompt 12/12
建议：minor（新增 MCP 工具 + 新增 HTTP 接口 + 新增定时任务）
case：docs/cases/2026-10-30-qq-dsh-task-and-daily-news.md
层级：接口层向后兼容（新工具、新路由，旧调用不受影响）
爆炸半径：桥接单进程；新增每日 1 次 worker 调用（失败最多 6 次/天）
失败路径：not-owner→403；超时→可读文案；日报失败→10 分钟退避重试
未验证：DSH 审批弹窗在后台会话下的长期行为
```
