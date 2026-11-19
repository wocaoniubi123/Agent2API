//! 应用更新与强制更新读取官网同步的官方 app.json，沿用已确认的策略缓存。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::server::core::task_state;
use super::version::{compare_versions, DEFAULT_REPO};

const TRUSTED_KEY: &str = "updateWebsiteTrustedApp";

/// 自用 fork 的应用更新仓库（2026-11-15）。
///
/// ── 为什么覆盖而不是改索引 ──────────────────────────────────
/// 更新仓库的正规来源是索引仓库 `Agent2plugin/Agent2plugin` 的 `app.json`
/// （`app.repo`），那是别人的仓库、改不了。所以在这里把这个字段固定成自己的
/// 仓库；`forceUpdate`（强制更新策略）仍原样采用索引里的内容，只换「去哪下载」。
///
/// ── 这个仓库必须满足什么 ────────────────────────────────────
/// 1. 有一个 **非 draft** 的 Release（beta 通道从列表里按语义化版本筛，
///    正式通道打 `/releases/latest`，预发布标签会被 GitHub 排除）；
/// 2. tag 能按语义化版本解析（`v3.5.0-beta.1` 这种），`ziyong-20261108.2`
///    那样的日期序号解析不出来，会被跳过；
/// 3. 资产名形如 `Agent2API_<版本>_x64-setup.exe`（安装包的既有命名）。
const APP_REPO: &str = "aimod-cc/Agent2API";

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ForceRule {
    pub minimum_version: Option<String>,
    pub target_version: Option<String>,
    pub message: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ForceUpdate {
    pub stable: ForceRule,
    pub beta: ForceRule,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppIndex {
    pub repo: String,
    pub force_update: ForceUpdate,
}

impl Default for AppIndex {
    fn default() -> Self { Self { repo: DEFAULT_REPO.to_string(), force_update: ForceUpdate::default() } }
}

impl AppIndex {
    pub fn required(&self, current: &str) -> Option<Value> {
        let rule = if super::is_prerelease_version(current) { &self.force_update.beta } else { &self.force_update.stable };
        let minimum = rule.minimum_version.as_deref()?.trim();
        if compare_versions(current, minimum) != Some(-1) { return None; }
        let target = rule.target_version.as_deref().filter(|value| !value.trim().is_empty()).unwrap_or(minimum).trim();
        if compare_versions(target, minimum).is_none_or(|order| order < 0) { return None; }
        Some(json!({ "required": true, "minimumVersion": minimum, "targetVersion": target,
            "message": if rule.message.trim().is_empty() { "当前版本已停止提供模型服务，请先完成更新。" } else { rule.message.trim() },
            "source": format!("{}/app.json", super::website::API_BASE),
        }))
    }
}

pub fn cached() -> AppIndex {
    task_state::read(TRUSTED_KEY).ok().and_then(|state| state.value)
        .and_then(|value| serde_json::from_value(value).ok()).unwrap_or_default()
}

pub async fn resolve() -> AppIndex {
    let previous = cached();
    let url = format!("{}/app.json", super::website::API_BASE);
    let response = match super::website::fetch_json(&url, 15_000).await {
        Ok(response) if response.status.is_success() => response,
        _ => return previous,
    };
    let Some(index) = parse(&response.value) else { return previous; };
    let _ = task_state::store_value(TRUSTED_KEY, json!(index));
    index
}

fn parse(value: &Value) -> Option<AppIndex> {
    if value.get("schema").and_then(Value::as_u64) != Some(1) { return None; }
    let mut index: AppIndex = serde_json::from_value(value.get("app")?.clone()).ok()?;
    // 仓库固定成自己的（见 [`APP_REPO`]）；`forceUpdate` 仍是索引里的策略。
    index.repo = APP_REPO.to_string();
    if !is_repo_slug(&index.repo) { return None; }
    for rule in [&index.force_update.stable, &index.force_update.beta] {
        if rule.message.chars().count() > 2000 { return None; }
        if let Some(minimum) = rule.minimum_version.as_deref().filter(|value| !value.is_empty()) {
            if compare_versions(minimum, minimum).is_none() { return None; }
            if let Some(target) = rule.target_version.as_deref().filter(|value| !value.is_empty()) {
                if compare_versions(target, minimum).is_none_or(|order| order < 0) { return None; }
            }
        }
    }
    Some(index)
}

fn is_repo_slug(value: &str) -> bool {
    let mut parts = value.split('/');
    let (Some(owner), Some(repo), None) = (parts.next(), parts.next(), parts.next()) else { return false; };
    [owner, repo].iter().all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')))
}
