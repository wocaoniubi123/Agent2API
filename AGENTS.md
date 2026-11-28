# AGENTS.md

> **涉及分支、发版、版本号的操作，一律按 Skill `release-flow` 执行：**
> **`.agents/skills/release-flow/SKILL.md`** —— 动手前先读它，细则一律以该文件为准，本文件只作入口指路。
>
> 覆盖范围：切分支 / 给 PR 选 base / 合并 PR / 回复 Issue、PR / 改版本号 / 写更新日志 /
> 打 tag / 挂 GitHub Release / 发 beta 预发布版 / 发版验收 / 排查发版失败。

## 两条红线（先问人，不得自行推进）

1. **发版**：改版本号、推 `main` / `beta`、打 tag、挂 Release 之前，先把版本号与「这次要发什么」讲清楚，等用户确认；**未经确认不得推任何分支或 tag** —— tag 一旦推出去就会触发构建、产出公开的安装包与镜像，收不回来。
2. **更新日志**：写好的日志（= 发布提交信息 = Release 正文）必须先给用户逐条过目；按反馈改完**再确认一次**才能提交。

其余细则（分支落脚点、署名与 AI 落款、六处版本号、正式版 / beta 完整流程、验收清单、已知坑与排查）见上述 Skill。

## 构建与出包：固定用 `ziyong` 分支

**编译、打包、出包一律在 `ziyong` 上做，不要为触发构建新建任何临时分支。**

### 本地编译出安装包（首选）

本机有完整的便携工具链 `G:\ZCode\Agent2API-tool`（便携 node / npm / rust + `env.ps1`），
**出包默认走本地编译**，不要把「重建产物」或「出安装包」甩给 CI —— 云端那条路只为本地编不了的情况留。

```powershell
# ① 每个新 shell 都要先 dot-source（前面那个点不能省，否则变量出不去、rustup 会报找不到 home）
$root = 'G:\ZCode\Agent2API-tool'
. "$root\env.ps1"

# ② 前端产物：先 i18n 再 ui-islands（顺序不能反 —— ui-islands 编译时要读 i18n 产物）
Set-Location 'G:\ZCode\Agent2API\desktop-tauri\i18n'
npm run build

Set-Location 'G:\ZCode\Agent2API\desktop-tauri\ui-islands'
npm run build     # = tsc --noEmit && vite build && vite build --config vite.login.config.ts

# 手机端只在动了手机端代码时才编（跳过可省几分钟）
# Set-Location 'G:\ZCode\Agent2API\desktop-tauri\mobile'; npm run build

# ③ 出 Windows 安装包
Set-Location 'G:\ZCode\Agent2API\desktop-tauri'
tauri-build --bundles nsis
```

- **`tauri.conf.json` 里没有 `beforeBuildCommand`** —— 第 ② 步不会自动发生，漏了就等于把旧前端打进安装包。
- 产物：主程序 `G:\ZCode\Agent2API-tool\target\release\agent2api.exe`；
  安装包 `G:\ZCode\Agent2API-tool\target\release\bundle\nsis\Agent2API_<版本>_x64-setup.exe`。
- 耗时基准（2026-11-10，12 核 / 16 GB，增量编译）：**约 16 分钟**。上游引入 `wasmtime 36` 后
  exe 由 26.9 MB 涨到 33.1 MB，第一次编这坨要多花几分钟。
- `tauri-build` 是 `env.ps1` 里封装的函数：跑完自动把被 tauri 改写的 `src-tauri/Cargo.toml`
  行尾还原，并报告仓库里是否还有别的改动。

### 前端调试：用 web-debug 工具（不重编译、不抢焦点）

改前端（`ui-islands/src/**`、`ui-shared/**`、`ui-kit/**`、`ui/css/**`）后要立刻看效果，
**不要为验证去编 12 分钟的 exe** —— 面板是纯前端，桌面和 web 共用同一份 `ui/`：

| 形态 | 资源来源 | 改前端后 |
|---|---|---|
| 桌面（Tauri） | `ui_assets` 编译进 exe | 必须重编译 |
| web（浏览器） | 磁盘 `ui_dir` | 只要 `npm run build`（约 30 秒） |

工具在 `G:\ZCode\Agent2API-tool\web-debug\`，用 360 极速浏览器起**屏幕外**的可调试实例，
全程 CDP，不抢焦点、不动鼠标键盘：

```powershell
cd G:\ZCode\Agent2API-tool\web-debug

.\start.ps1                              # 起实例：1920×1080、屏幕外、CDP 9224、打开 3065 面板
.\eval.ps1 "location.href"               # 执行任意 JS，返回结果
.\eval.ps1 "window.wbApp.showPage('requests'); 'ok'"
.\eval.ps1 @'
JSON.stringify([...document.querySelectorAll('.req-head > span')].map(s=>s.textContent.trim()))
'@
.\shot.ps1                               # CDP 截图 → shots\<时间戳>.png
.\stop.ps1                               # 停（只杀带 --remote-debugging-port 的进程，不碰日常浏览器）
```

| 要点 | 说明 |
|---|---|
| 窗口尺寸 | **固定 1920×1080**。1280 宽下 15 列的请求日志会把列压成竖排文字（弹性列被 `minmax(0,…fr)` 压到 0），别调小 |
| 登录态 | 存在 `web-debug\profile\`，`stop.ps1` 不删，下次启动免登录 |
| 前台 | 启动瞬间 Chromium 会抢一次，`start.ps1` 结束时还原；之后的 eval / shot 全程不碰前台 |
| 完整用法 | `web-debug\README.md`（含读 DOM、命中测试、截图的现成配方） |

**不要用桌面端调前端**：Tauri 的 WebView2 不认 `PostMessage`，坐标点击基本无效，只能前台
`SendInput` —— 那会抢焦点、动鼠标，违反全局 `R13.5`。真要动桌面端，先问用户。

### 合并上游时：产物 vs 手写

`desktop-tauri/ui/` 下混着两类文件，**分类错了会静默丢掉手写改动，重建也修不回**：

| 类型 | 路径 | 合并策略 |
|---|---|---|
| 产物（构建生成） | `ui/islands/ui.js` `ui.css` `login.js`、`ui/i18n/**`、`ui/m/mobile.js`、`ui/sw.js` | 整份取上游，之后 `npm run build` 重建 |
| **手写**（人改即生效） | `ui/css/**`（25 个）、`ui/table-columns.js`、`ui/index.html`、`ui-islands/src/**`、`ui-shared/**`、`ui-kit/**` | **禁止整份取任一方**，逐 hunk 融合 |

判据：在构建脚本 outDir 里 / 重跑构建会被重写 → 产物；被 html 直接 link 引用 / 多行带注释 /
构建不生成 → 手写。**拿不准按手写处理。**

**踩过的坑（2026-11-23）**：`ui/css/page-requests.css` 被当成产物整份取上游，
我方 21 行命中率列样式全丢，而 `npm run build` 不会把它长回来（它不在构建链里）。
合并后必须验证：

```powershell
git grep -c 'req-hit' -- 'desktop-tauri/ui/css/page-requests.css'                    # 期望 5
git grep -n 'is-low\|is-mid\|is-high' -- 'desktop-tauri/ui/css/page-requests.css'    # 各 1
git grep -n "key: 'hit'\|key: 'cost'" -- 'desktop-tauri/ui/table-columns.js'         # 各 1
```

### 出包后：把安装包放到桌面

```powershell
$desktop = [Environment]::GetFolderPath('Desktop')     # 本机是 E:\desk-ai（桌面被重定向过）
$setup = Get-ChildItem 'G:\ZCode\Agent2API-tool\target\release\bundle\nsis\Agent2API_*-setup.exe' |
         Sort-Object LastWriteTime -Descending | Select-Object -First 1
Copy-Item $setup.FullName -Destination $desktop -Force
```

**桌面路径不要写死 `C:\Users\<用户>\Desktop`** —— 本机桌面重定向在 `E:\desk-ai`
（`HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders` 的 `Desktop` 也是这个值；
`...\Explorer\Shell Folders` 那个键还留着旧的 `C:\Users\Administrator\Desktop`，**别信它**）。
每次放产物前用 `[Environment]::GetFolderPath('Desktop')` 现取。

### 装包前必查三条

1. **先退出网关**：`agent2api.exe` 正监听 3065，占着文件就装不上。
2. **安装目录保持 `E:\1反代项目\Agent2API`**：数据目录跟随 exe（`{exe}/data`）。装进
   `Program Files` 时普通用户写不进去，会按设计回落到 `C:\Users\<用户>\.agent2api`，
   表现就是「账号和配置全没了」。`src-tauri/nsis-template.nsi` 的 `ReadPreviousInstallDir`
   补丁正是为读回上次安装位置而留，装的时候看一眼路径。
3. **首次启动会跑 schema 迁移**（当前 27 → 29）：迁移是加料式的、不重建表；库大的话先点
   「压缩数据库」再启动，扫描更快。

### 插件本地编译（`Agent2Providers`）

提供商插件**也走本地编译**，不要装官方发布仓库的预编译包 —— 那是别人的构建，会丢掉本 fork 的
`invite_code` 能力位（账号页那颗「邀请码」按钮就靠它）。

插件仓库在 `G:\ZCode\Agent2Providers`，**固定用 `ziyong` 分支**：编译、提交、发版全在它上面做；
`main` 只当与上游对齐的中转站（`upstream/main` → `main` → 合进 `ziyong`），不在 `main` 上直接改东西。

依赖只有三样，本机全部就绪，**不需要再装 VS Build Tools**：

| 依赖 | 本机现状 |
|---|---|
| Rust ≥ 1.88（`Cargo.toml` 的 `rust-version`） | `env.ps1` 的便携 `stable-x86_64-pc-windows-msvc`（实测 rustc 1.99.1） |
| MSVC 链接器 | VS 2022 Community 自带 `VC\Tools\MSVC\14.44.35207`（就是 v143），对应 `x86_64-pc-windows-msvc` |
| Node（只为跑 `scripts/pack.mjs`） | 便携 node（实测 v26.13.0） |

**不需要 `npm install`**：`pack.mjs` 自实现 zip 写入（store 模式 + 手写 CRC32），仓库没有 node_modules；
`ui/checkin/**` 是纯静态文件，没有前端构建步骤。`rusqlite` 走 `bundled`，所以要 C 编译器（就是上面那个 MSVC）。

```powershell
$root = 'G:\ZCode\Agent2API-tool'
. "$root\env.ps1"                     # 每个新 shell 都要，别省那个点

Set-Location 'G:\ZCode\Agent2Providers'
git checkout ziyong                   # 固定用 ziyong 分支（编译、提交、发版都在这上面）
node scripts/pack.mjs                 # = cargo build --release -p agent2api-providers + 打 zip

# 想自己控 cargo 参数就分两步：
# cargo build --release -p agent2api-providers
# node scripts/pack.mjs --skip-build
```

- 产物：`G:\ZCode\Agent2Providers\dist\agent2api-providers-<版本>-<三元组>.zip`（约 16 MB，47 项）
- **二进制不在仓库目录里**：`env.ps1` 把 `CARGO_TARGET_DIR` 钉到了 `G:\ZCode\Agent2API-tool\target`，
  所以 exe 在 `G:\ZCode\Agent2API-tool\target\release\agent2api-providers.exe`。
  `pack.mjs` 读这个变量、自动对齐 ✅；但 `verify.mjs` 的默认路径是写死的 `<仓库>/target/release/`，
  本地跑必须显式给 `--exe`：
  `node scripts/verify.mjs --exe G:\ZCode\Agent2API-tool\target\release\agent2api-providers.exe`
- 耗时基准（2026-11-10，12 核 / 16 GB）：`cargo clean -p agent2api-providers --release` 之后
  重编一个 crate + LTO = **4 分 05 秒**；完整冷编**约 6 分钟**。源码没变时 `cargo build` 只花 0.7 秒
  （缓存命中），**那不算验证编译**，要真编就先 `clean -p`。
- **每次编出来的 zip 哈希都不一样**：PE 头 `TimeDateStamp` 写的是编译时刻，本项目不是可复现构建，
  哈希不同不代表产物有问题。
- release profile 很重（`lto = true` / `codegen-units = 1` / `opt-level = "s"` / `strip = true`），
  要限流就给 `$env:CARGO_BUILD_JOBS` 一个小于核数的值。

改版本号必须**两处一起改**：`Cargo.toml` 的 `[workspace.package] version` 和 `pack.json` 的 `version`；
改完 `Cargo.lock` 会跟着变（`cargo build` 自动写回）。

出包后同样放桌面，路径现取别写死：

```powershell
$desktop = [Environment]::GetFolderPath('Desktop')     # 本机是 E:\desk-ai
Copy-Item 'G:\ZCode\Agent2Providers\dist\agent2api-providers-*-x86_64-pc-windows-msvc.zip' `
          -Destination $desktop -Force
```

安装：网关面板 → 插件 →「提供商增强」卡片 → **从文件安装** → 选这个 zip。覆盖安装会重启插件进程，
正在跑的调用会短暂中断。自编包显示「未签名」（`signed: false`）是正常现象；要签名走
`node scripts/sign.mjs keygen` + `sign --zip`，私钥默认落 `~/.agent2api/plugin-signing-key.json`，**绝不进仓库**。

插件仓库 push **不触发任何构建**（`build.yml` 只认 `v*` tag，且只往构建仓库派发），所以改完想推就推；
但按全局规矩，push 前仍要先问。

### 云端出包（仅当本地编译不可用时）

```bash
# ① 改代码 → 提交 → push
git push origin ziyong
#    push 自动触发 artifact-commit：重建 desktop-tauri/ui/** 并提交回 ziyong

# ② 出安装包
gh workflow run ziyong-release.yml --ref ziyong -f tag=<tag>
```

- `artifact-commit.yml` 的 `on.push.branches` 里已包含 `ziyong`，push 即触发。
  历史上为触发它而建的 `merge/artifacts-<sha>` / `merge/preview-<sha>` **已废弃，不要再建**。
- `ziyong-release.yml` 与 `sync-upstream.yml` 必须留在 `main` 上：`workflow_dispatch` 与
  `schedule` 只认**默认分支**上注册的 workflow；而 `push` 只看被推的那个分支 —— 两套规则不同，
  别把 push 触发的 workflow 也往 main 上搬（2026-11-07 踩过）。

### 已知坑：仓库 Actions 被 GitHub 禁用

fork 仓库的 Actions 可能被 GitHub 关掉，症状是「push 成功但什么都不跑」：

- `git ls-remote` 能看到新 sha，但 `gh api .../actions/runs` 里运行数一直是 0；
- `gh workflow run` 报 `HTTP 422: Actions has been disabled for this repository`。

**API 改不了这个状态**（`PUT /actions/permissions` 返回成功但无效），只能由仓库所有者在
**Settings → Actions → General** 点一次启用。启用后 push 立刻恢复触发。

## 反代提供商问题排查

收到反代提供商相关的问题反馈时，**优先使用网络搜索查找已有解决方案**，重点参考同类项目的 Issue、PR、修复记录和适配实现，了解其他项目是否遇到过相同问题、如何解决。**不要默认从零自行排查**：先核对已有方案与本项目的适用性，优先借鉴可靠的解决思路；未找到可靠方案、现有方案不适用或仍有未解决的问题时，再开展针对性的本地排查。

## 本地开发与冒烟测试隔离

在本机拉起 `agent2api-server`、桌面端开发实例或任何需要启动网关的冒烟测试时，**严禁直接使用默认数据目录（`~/.agent2api`）和默认端口（`3065`）**，必须通过环境变量完全隔离：

- **`AGENT2API_PROXY_HOME`**：必须指向本次测试专用的空临时目录（用完即删），**绝不可**指向或默认落到 `~/.agent2api`。
- **`AGENT2API_PROXY_PORT`**：必须指定未占用的临时端口（如 `13065`），避开正式版默认的 `3065`。
- **`AGENT2API_HOST`**：拉起 `agent2api-server` 时显式设为 `127.0.0.1`，避免默认监听 `0.0.0.0` 对外暴露；纯本机临时接口验证若需跳过鉴权，仅在已隔离临时目录且绑定 `127.0.0.1` 时再配合 `AGENT2API_ALLOW_NO_KEY=1`。

**原因**：开发机通常会常驻运行正式版 Agent2API 桌面客户端（占用 `~/.agent2api` 与 `3065` 端口）。若不隔离直接启动调试版网关，不仅会与正式版并发读写同一份 `agent2api.db` 和插件注册表文件，还会在启动阶段先拉起插件、紧接着因端口冲突退出并强行中止加载中的插件，把大量 `Wasm 插件已关闭` / `插件启动失败` 等假报错直接写进正式版日志库，污染正式环境并误导排查。

测试结束后务必停止临时拉起的进程并清理临时目录，不要遗留后台进程或临时文件。

## 文档落点

安装 / 部署 / 升级 / 排错说明只在 `docs/install.md`（另有 5 份译文 `docs/install.{en,zh-Hant,ja,ko,pt-BR}.md`，六份一一对应）里维护；各语言 README 只留「快速开始」速查表 + 一个指向安装文档的链接，**不要再把安装细节写回 README**。产物名、端口、环境变量、安装脚本参数有改动时，六份一起改。

**README 语言落点：根 `README.md` 是英文**（GitHub 默认展示），简体中文在 `docs/README.zh-CN.md`，其余四份为 `docs/README.{zh-Hant,ja,ko,pt-BR}.md`。中文仍是文案源语言，改支持矩阵等内容时六份同步，别把中文写回根目录。
