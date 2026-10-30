# 更新来源切到 fork（xiake050421-ux/surfcore）

- 日期：2026-10-30
- 触发：用户要求「把更新源改到 fork」——上游 `Mieksido/surfcore` 没有写权限，v0.8.0 只能发到 fork。

## 现象

发布到 fork（`xiake050421-ux/surfcore`）后，设置页「检查更新」仍然查不到任何新版本：组件清单里 `SurfCore 本体` 的 `versionRepo` 与客户端「去下载新版」链接都硬编码指向上游 `Mieksido/surfcore`。

## 根因（链路）

1. `plugins/surfcore/lib/index.js` 的 `components()` 里，本体组件写死 `versionRepo: 'Mieksido/surfcore'`。
2. `plugins/surfcore/lib/updates.js` 的 `inspectGitComponent()` 走**本地 `origin` 远端**（`git remote get-url origin` + `fetch origin <branch>` + `rev-list HEAD..origin/main`），`versionRepo` 只用于取「最新版本号」。
3. `plugins/surfcore/lib/client.js` 两处「去下载新版 / 手动下载」链接写死上游 Releases 地址。

所以只改 `versionRepo` 不够：`origin` 指向谁，就只会拿谁的提交做比较与 `--ff-only` 更新。

## 修法

| 文件 | 改动 |
| --- | --- |
| `plugins/surfcore/lib/index.js` | `versionRepo: String(updCfg.repo ?? '').trim() \|\| 'Mieksido/surfcore'` |
| `plugins/surfcore/lib/client.js` | 新增 `RELEASES_LATEST_URL` 常量（指向 fork），两处硬编码链接改用它 |
| `config.json`（不入库） | `updates.repo = "xiake050421-ux/surfcore"`（脚本用） |
| `~/.dsh/surfcore/config.json`（统一配置，不入库） | **`updates.repo` ← `readUnified()` 真正读的是这一份** |
| 本地 git 远端 | `origin` → `upstream`（只读上游），新建 `origin` = fork |

> `readUnified()`（`plugins/surfcore/lib/store.js:328`）读 `~/.dsh/surfcore/config.json`，不是仓库根的 `config.json`——两处都写，避免以后改错文件。

## 验证

```bash
node -e "import('./plugins/surfcore/lib/updates.js').then(async m=>console.log(await m.inspectComponent({id:'surfcore',dir:process.cwd(),kind:'git',branch:'main',versionRepo:'xiake050421-ux/surfcore'})))"
```

预期：`remoteUrl` 为 fork，`behind: 0`、`ahead: 0`、`status: 'latest'`。

## 回滚

`config.json` 删掉 `updates.repo`、`git remote set-url origin https://github.com/Mieksido/surfcore.git`、`client.js` 把 `RELEASES_LATEST_URL` 改回上游即可；代码改动可单独 revert。

## 残余风险

- fork 上的 `v0.8.0` 标签内容与上游后续版本会分叉；下次同步上游需要 `git fetch upstream && git merge upstream/main`。
- 自动更新依赖 fork 的 `main` 可 `--ff-only`（本地有未推送提交时会被 `blocked: 本地有未推送提交` 拦住，符合设计）。
