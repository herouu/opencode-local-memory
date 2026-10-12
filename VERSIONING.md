# 版本与发布规则（VERSIONING）

本文件说明本插件**怎么升版、怎么发、什么不能做**。每条规则后面都标了来源：
**[规范]** = 官方规范原文或工具官方文档；**[惯例]** = 生态通行做法（非强制，但主流插件都这么做）。

工具链：**[semantic-release](https://github.com/semantic-release/semantic-release)**（版本由提交信息推导，不人工写）。
配置见根目录 [`.releaserc.json`](.releaserc.json)、[`.github/workflows/release.yml`](.github/workflows/release.yml)。

---

## 1. 三条版本轴是分开的

| 轴 | 载体 | 谁负责升 | 说明 |
|---|---|---|---|
| **插件版本** | `package.json` 的 `version` + git tag `vX.Y.Z` | semantic-release 自动 | npm 生态里 `package.json.version` 是**唯一真源** [惯例] |
| **存储 schema 版本** | 插件内的 `record.v` | 手工 | 本机 storage 里每条记忆记录的格式版本；变更必须写迁移段（见 §6） |
| **目标 opencode 版本** | `package.json` 的 `engines.opencode` + README 的测试矩阵 | 手工 | 当前声明 `>=2.0.0`；V2 与 V1 插件契约不兼容，故是硬边界 |

三条轴**互不绑定**：插件小版本升了不代表 schema 变了，schema 变了也不必然升 major（只在破坏兼容时才是 major）。

## 2. 提交信息 ↔ 版本号映射

依据 **[Conventional Commits 1.0.0](https://www.conventionalcommits.org/zh-hans/v1.0.0/)** 与 semantic-release 的默认分析器（`@semantic-release/commit-analyzer` + `conventionalcommits` preset）**[规范]**：

| 提交（示例） | 版本变化 | 触发条件 |
|---|---|---|
| `fix: 修正 RECENT_MAX 语义` | **PATCH** `x.y.Z+1` | `fix` 类型 |
| `feat: 支持 memory 工具 forget` | **MINOR** `x.Y+1.0` | `feat` 类型 |
| `feat!: 移除 V1 兼容层` 或 footer 里带 `BREAKING CHANGE:` | **MAJOR** `X+1.0.0` | `!` 或 `BREAKING CHANGE:` |
| `chore:` / `docs:` / `ci:` / `test:` / `refactor:` / `style:` | **不发版** | 不产生 release 的类型 |
| `perf:` | PATCH | 按 preset 默认 |

**0.x 期的降级规则 [惯例]**：`major` 在 `0.x` 阶段被降级为 **MINOR**。即当前处于 `0.1.x` 时，一个带
`BREAKING CHANGE:` 的提交产出 `0.2.0` 而不是 `1.0.0`。这是工具对 SemVer §4「0.y.z 视为初始开发，任何东西都可能变」的通行实现。

提交格式（本次已启用 `conventional-changelog-conventionalcommits` preset，支持 `CHANGELOG` 分组与 emoji 之外的完整 schema）：

```
<type>(<可选 scope>)<!>: <描述>

<可选正文>

<可选 footer，例如：BREAKING CHANGE: 说明>
```

## 3. 首发为什么是 `0.1.0` 而不是 `1.0.0`

**[规范]** semantic-release 的 `FIRST_RELEASE` 常量默认值就是 `1.0.0`
（`semantic-release@25.0.9`，`lib/definitions/constants.js:3`：`export const FIRST_RELEASE = "1.0.0";`）。
**仓库里没有任何历史 tag 时，它一定会首发 `1.0.0`。**

因此本仓库**手工建了初始 tag `v0.1.0`** 作为"上一个发布"的锚点：`v0.1.0` 之后，
`fix:` → `0.1.1`、`feat:` → `0.2.0`、`!`/`BREAKING CHANGE:` → `0.2.0`。

> 想要从 `0.1.0` 起步，就必须自己先打这个锚点 tag —— 这不是 semantic-release 的配置项，而是它的默认契约。

## 4. 分支与预发布

`.releaserc.json` 的 `branches`：

| 分支 | 产出 | dist-tag | GitHub Release |
|---|---|---|---|
| `main` | 稳定版 `0.2.0` | `latest`（第一个分支即默认通道）**[规范]** | 正式 Release |
| `beta` | 预发布 `0.2.0-beta.1` | `beta`（未显式设 channel 时按**分支名**作为 channel；此处显式写成 `beta`）**[规范]** | 勾选 **pre-release** |

推 `beta` 不影响 `main` 的稳定版本线；预发布版本号里的 `.N` 由 semantic-release 自增。

## 5. 一次发版实际发生了什么

推送到 `main`（或 `beta`）后，`.github/workflows/release.yml` 依次：

1. `actions/checkout@v5`，`fetch-depth: 0`（要有全部历史才能定位上一个 tag）；
2. `actions/setup-node@v5` + `npm ci`；
3. 跑离线 harness：`node tests/harness.mjs`（54 项断言，不联网）；
4. `npx semantic-release`：
   - **commit-analyzer** 从上一个 tag 到 HEAD 的提交算出 `nextRelease.version`；
   - **release-notes-generator** 生成 Release Notes；
   - **changelog** 把新段落插进 `CHANGELOG.md`；
   - **npm** 更新 `package.json` 的 `version`（**当前不发布，见 §7**）；
   - **github** 建 GitHub Release + tag `vX.Y.Z`；
   - **git** 把 `CHANGELOG.md` + `package.json` 以 `chore(release): X.Y.Z [skip ci]` 提交回推。

> 回推的提交带 `[skip ci]` 后缀，避免 CI 自触发循环 **[惯例]**。

## 6. 禁令

1. **不要移动或删除已发布的 tag** —— tag 是 semantic-release 计算下一个版本的锚点，改动会让版本线错乱。
2. **不要手工编辑 `CHANGELOG.md`** —— 它由插件维护；手改会在下次发版产生冲突或重复段落。
3. **schema 变更必须写迁移段** —— 改 `record.v` 或改 key 形态（`mem:u_…` / `mem:t_…` / `mem:import_…`）时，
   必须在 `CHANGELOG.md` 的 `### Changed` 里写清"老数据怎么办"（原地升级？丢弃？还是提供重导入脚本），
   并在 `docs/` 里补对应说明。
4. **不要绕过常规提交** —— 直接 `git commit -m "update"` 不会被识别，等于白推一次。
5. **不要 `force push` 到 `main` / `beta`。**

## 7. 将来要发 npm 时怎么开

当前 `package.json` 是 `"private": true`，**[规范]** 官方文档原句：`@semantic-release/npm` 的
`npmPublish` 默认值 = `package.json.private === true` 时为 `false`，否则为 `true`；且
"If `false` the `package.json` version will still be updated."
—— 也就是**版本号照常更新，只是跳过上传**。这正是现在想要的：先跑通发版链路，不污染 npm。

启用步骤：

1. 把 `private` 改成 `false`（`.releaserc.json` 无需改动，npm 插件会自动开始发布）；
2. **优先用 npm Trusted Publishing（OIDC）** **[惯例]**：npm 侧把本仓库的 `release.yml` 注册为 Trusted Publisher，
   CI 侧已预留 `id-token: write` 权限，**不再使用长期 token**，同时自动获得 provenance 签名；
3. 若暂时只能用长期 token：加 `NPM_TOKEN` secret，并在 workflow 里放开那行注释；
4. 预发布分支 `beta` 会发到 `beta` dist-tag，用户用 `npm i opencode-local-memory@beta` 获取。

## 8. 命令速查

```bash
# 日常：写一个规范提交，推到 main，就自动发版
git commit -m "fix: 修正打分窗口回读上限"     # → 0.1.1
git commit -m "feat: 新增 memory 工具的 stats 输出字段"  # → 0.2.0
git commit -m "feat!: 改变 storage key 形态"            # → 0.2.0（0.x 期 major 降级为 minor）
git push origin main

# 预发布：推到 beta
git push origin beta                          # → 0.2.0-beta.N，dist-tag beta，Release 勾 pre-release

# 本地演练（不会真的发布任何东西）
npx semantic-release --dry-run --no-ci

# 手工兜底发版（CI 不可用时，需要有 GITHUB_TOKEN 且有权限）
GITHUB_TOKEN=... npx semantic-release
```

---

## 来源

- Conventional Commits 1.0.0 — <https://www.conventionalcommits.org/zh-hans/v1.0.0/>
- Semantic Versioning 2.0.0（§4：0.y.z 为初始开发）— <https://semver.org/lang/zh-CN/spec/v2.0.0.html>
- Keep a Changelog 1.1.0 — <https://keepachangelog.com/zh-CN/1.1.0/>
- semantic-release 文档（`branches`、`FIRST_RELEASE`、插件顺序、`npmPublish`）— <https://semantic-release.gitbook.io/semantic-release/>
- `@semantic-release/npm` README（`npmPublish` 与 `private` 的关系）— <https://github.com/semantic-release/npm>
- npm Trusted Publishing (OIDC) — <https://docs.npmjs.com/trusted-publishers>
