# 桌宠不会提醒「DSH 需要你确认」

## 现象

- 用户原话：**「修改一下插件的桌宠，当你这边需要我确认权限时，插件的桌宠会发气泡主动提醒我」**。
- 复现步骤：让 DSH 去动系统设置（触发权限确认），然后切到别的窗口；桌宠没有任何动静，用户要等自己想起来切回去。
- 影响面：只影响「提醒」这一层，不丢数据；错过确认的结果是任务挂在那里等（最坏到超时放弃）。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | Windows 11 / DSH 0.2.1-rc.5 |
| SurfCore 版本 | 0.7.0（junction 安装） |
| 桌宠 | feiyu-pet 0.2.3（Electron，`~/.dsh/surfcore/pet/app`） |
| 宿主 | DSH Web GUI（端口会漂移） |

## 根因

- 代码位置：`plugins/surfcore/lib/index.js`（插件只注册了 `session/event` 用于 token 用量采集，没有把「等待确认」转给桌宠）；桌宠侧 `pet/app/dist/main.js:onEvent`。
- 问题链条：DSH 的确认请求只发生在宿主会话里（`approval/asked`、`ask_user_question`）；桌宠是**另一个进程**，它唯一能收到消息的通道是长轮询 `GET /pet-api/events`（`pet-client.loop()`），而插件从没往这个事件流里写过「等待确认」。所以桌宠永远不知道你在等确认。
- 为什么之前没发现：桌宠的事件流原本只服务「对话回复 / 主动搭话」，没人想过把它当提醒渠道；DSH 自己的确认框只有你在窗口前才看得到。

## 完整逻辑（给用户看的那一遍）

- **链路**：DSH 宿主（`plugins/surfcore/lib/index.js` 的 `ctx.on('session/event')`）→ `petChat.emit({type:'reply', text})` → 事件队列（`pet-chat.js` 的 `events`/`eventSeq`）→ 桌宠长轮询 `GET /pet-api/events?since=…`（`pet-api.js`）→ `main.js` `onEvent()` 收到 `type==='reply'` → `showBubble()`。读者只有桌宠一个；QQ 桥接不走这条队列。
- **机制**：桌宠不知道「DSH 在等我」，因为这个信息在宿主进程里、且没有外发口；`type:'reply'` 是桌宠已经支持的「她说一句话 → 冒泡」语义，所以把提醒伪装成一句话就能复用整条渲染/收起/悬停暂停逻辑，不用改桌宠应用（它还是 zip 安装的构建产物，改了就丢）。
- **爆炸半径**：1 个插件进程 × 1 个读者（桌宠）× 静默 = 3 分；不碰用户数据、不碰密钥、不额外花 token（`emit` 不发 LLM 请求）。
- **取舍**：
  - A（选中）：往现有事件流里推 `reply` —— 零改桌宠、零新接口、复用气泡渲染；代价是提醒文案会进桌宠对话历史（可接受）。
  - B：改桌宠应用加一个新事件类型 —— 桌面端重新打包，版本一更新就丢补丁，被否。
  - C：走 Windows toast —— 实测 `CreateToastNotifier` 抛 `该进程没有程序包标识符 (0x80073D54)`，`ShowBalloonTip` 在 Win11 也不显示，直接排除。
- **生效与重启**：插件是 DSH bundle，改完必须重启 DSH（页面 F5 不够）。桌宠不用动。

## 修法

- 在 `plugins/surfcore/lib/index.js` 里，`tokenBudget.ingestEvent` 的那个监听旁边新增第二个 `ctx.on('session/event')`：
  - `approval/asked` → `⚠ 需要你确认权限（对话名）`
  - `tool/call` 且 `name === 'ask_user_question'` → `⚠ 需要你回答一下（对话名）`
  - 同类提醒 20 秒内只冒一次；`petChat.emit({ type:'reply', text, modality:'text', messageId:'pet-alert-…' })`
  - 对话名取 `ctx.get('sessionTitle')?.get?.(session)`，取不到就省略括号。
- 为什么选这个方案：桌宠已经会「收到 reply 就冒泡」，我们只需要在正确的时机说一句话；改动 30 行、不动构建产物、随时可回滚。
- 回滚方式：删掉 `petAlertOff` 那个监听块（以及 dispose 里的 `petAlertOff?.()`），重启 DSH。

## 验证

```powershell
# 1) 语法
node --check plugins/surfcore/lib/index.js   # 拷贝成 .mjs 再检查
# 2) 重启 DSH 后，让宿主弹一个确认框（ask_user_question），桌宠应在 1 秒内冒气泡
```

- 实测：重启 DSH 后触发 `ask_user_question`，桌宠右下角冒出「⚠ 需要你确认权限（接入 AstrBot 实现 QQ 机器人控制…）」，用户确认「看到了，桌宠冒泡了」。
- 截图证据（临时）：`pet_shots3/150529.png`（气泡出现在桌宠旁），已按交付清理。

## 残余风险 / 没做的事

- 目前**没有开关**：桌宠装了就一直提醒。想要「专注模式」下不提醒，得再接 `focus.json`（桌宠侧已有该状态，插件侧 `readFocus()` 可读）。
- 只在桌宠运行时有效；桌宠没开就只有 DSH 自己的确认框。
- 提醒文案会写进桌宠对话历史（`pet/chat` 那条 `messages`），不影响记忆卡（记忆卡只摄取 `/chat` 的成功问答）。

## 发布交接块

```
feat(pet): DSH 需要确认时让桌宠冒气泡提醒
- plugins/surfcore/lib/index.js：新增 session/event 监听，approval/asked 与 ask_user_question 转成 petChat.emit({type:'reply'})，同类 20s 去重
- 不改桌宠应用（zip 构建产物）；生效需重启 DSH
- 验证：重启后触发 ask_user_question，桌宠冒「⚠ 需要你确认权限（对话名）」
```
