# 2026-10-30 桥接只在启动时认 DSH 端口 → DSH 一重启就「已读不回」

## 现象

- DSH 桌面端一天里换了好几次回环端口（11850 → 2475 → 4385 → 3899 → 1371），每次换完，
  QQ 侧消息还在进、桥接进程也还活着，但**回复再也不出现**；`state/bridge.log` 里连报错都没有。
- 用户感受：机器人「已读不回」，只能靠手动重启桥接恢复。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | Windows 11 / DSH 0.2.1-rc.5 |
| SurfCore 版本 | 0.7.0（junction） |
| 桥接 | `node src/bridge.js`，端口 3100 |

## 根因

- 代码位置：`src/bridge.js` 启动阶段的端口探测（`probeDshBaseUrl` / `discoverDshBaseUrl`）+ `src/dsh-client.js` 的
  `NodeApiClient`。
- 问题链条：
  1. 桥接启动时探一次 `cfg.dsh.baseUrl`，连不上就 `discoverDshBaseUrl()` 找一个，找到后写回 `config.json`——**只做这一次**。
  2. `NodeApiClient.baseUrl` 构造后固定不变，`_remoteMuxGenerator` 用 `new URL('/api/remote.mux', this.baseUrl)` 建 WebSocket。
  3. DSH 换端口后，旧端口的连接要么拒绝、要么残留在半开状态；`pumpMux` 的退避重连仍在重试**旧地址**，
     于是「进程活着、会话事件不来」，QQ 侧就是已读不回。
- 为什么之前没发现：开发时 DSH 与桥接同生共死，端口在桥接生命周期内不变；桌面版 `DSH_WEB_URL` 场景也绕过了这条。

## 修法

1. `src/dsh-client.js` 新增 `moveToBaseUrl(next)`：地址变了就更新 `baseUrl`、`invalidateAuth()`（旧 Cookie 的
   authority 已对不上）、并调 `this._closeMux?.()` 主动关掉当前事件流，让上层 `pumpMux` 立刻用新地址重连。
   事件流生成器里注册 `this._closeMux = () => socket.close()`。
2. `src/dsh-port.js` 新增纯函数 `planDshPortMove({ current, misses, probe, discover })`：
   - `stay`（探得通，misses 归零）/ `wait`（第一次失败，只累计）/ `move`（连续两轮失败且发现到别的地址）/ `lost`（探不到也没找到）。
   连续两轮才动，避免 DSH 短暂忙碌时来回切。
3. `src/bridge.js` 启动后起 `setInterval(..., 60_000)` 的守护：跳过 `DSH_WEB_URL` 与远程地址；
   按 `planDshPortMove` 的结果切地址、写回 `config.json`，并打 `🔄 DSH 端口守护：旧 → 新，已切换地址并重启事件流`。
   定时器 `unref()`，不拖住进程退出。

## 取舍

- A：光在 `pumpMux` 的重连里每次重新发现地址——每 3 秒一次探测，DSH 正常时也白探，且发现逻辑会探测本机所有回环端口，太吵。
- B（采用）：独立 60 秒守护 + 连续两轮才动。代价是换端口后最多 2 分钟才恢复，收益是不抖动、日志干净。
- C：直接由 DSH 拉起桥接并注入 `DSH_WEB_URL`——依赖用户启动方式，且桌面版重启时不会重拉桥接，解决不了「桥接活得比 DSH 久」。

## 生效与重启

改的是桥接代码，必须重启桥接（`taskkill` 3100 的 pid → 删 `state/bridge.lock` → 跑 `SurfCore-Bridge-Autostart.vbs`）。
DSH 不用动。

## 验证

- `node --check src/bridge.js src/dsh-port.js` 通过。
- `node scripts/test-dsh-port-watch.mjs`：5 个用例全过（探得通 stay、首轮 wait、二轮 move、地址未变 wait、找不到 lost）。
- `npm run test:audit`：81/81 scripts passed。
- 桥接以新代码重启后日志正常（`DSH 已就绪（模式: reserved2）`），守护静默——**真实的「DSH 换端口」尚未在线上触发过**，
  下次 DSH 重启时应能在日志里看到 `🔄 DSH 端口守护：… → …`。

## 回滚与残余

- 回滚：`git revert` 本次提交；旧行为是「端口变了要手动重启桥接」。
- 残余：
  - 守护只在 `config.json` 的 `dsh.baseUrl` 是回环地址、且没有 `DSH_WEB_URL` 时生效；远程 DSH 不覆盖。
  - `discoverDshBaseUrl()` 依赖本机监听端口与 DSH 特征，若 DSH 换到非回环地址就找不到，只会打 `lost` 警告。
  - 换端口瞬间正在跑的那一轮对话会丢失（消息在 `agent/inbox` 里已被 claim）——`blocked` 的补丁不覆盖这条路径。
