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

## 文档落点

安装 / 部署 / 升级 / 排错说明只在 `docs/install.md`（另有 5 份译文 `docs/install.{en,zh-Hant,ja,ko,pt-BR}.md`，六份一一对应）里维护；各语言 README 只留「快速开始」速查表 + 一个指向安装文档的链接，**不要再把安装细节写回 README**。产物名、端口、环境变量、安装脚本参数有改动时，六份一起改。

**README 语言落点：根 `README.md` 是英文**（GitHub 默认展示），简体中文在 `docs/README.zh-CN.md`，其余四份为 `docs/README.{zh-Hant,ja,ko,pt-BR}.md`。中文仍是文案源语言，改支持矩阵等内容时六份同步，别把中文写回根目录。
