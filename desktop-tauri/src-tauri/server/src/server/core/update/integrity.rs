use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};

use crate::server::logging;

use super::{assert_downloadable, website, UpdateError};

struct TrustedDigest {
    value: String,
    size: u64,
    until: i64,
}

fn digests() -> &'static Mutex<HashMap<String, TrustedDigest>> {
    static CACHE: OnceLock<Mutex<HashMap<String, TrustedDigest>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn parse_digest(value: &str) -> Option<String> {
    let hash = value.strip_prefix("sha256:")?;
    (hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| hash.to_ascii_lowercase())
}

pub fn remember_website_release(payload: &Value, repository: &str) {
    let Some(tag) = payload.get("tag_name").and_then(Value::as_str) else { return; };
    let Some(assets) = payload.get("assets").and_then(Value::as_array) else { return; };
    let now = logging::now_ms();
    if let Ok(mut cache) = digests().lock() {
        cache.retain(|_, digest| digest.until > now);
        for asset in assets {
            let Some(url) = asset.get("browser_download_url").and_then(Value::as_str) else { continue; };
            let name = asset.get("name").and_then(Value::as_str).unwrap_or("");
            if !website::installer_url(url, repository, tag, name) { continue; }
            let size = asset.get("size").and_then(Value::as_u64).unwrap_or(0);
            if size == 0 || size > super::MAX_INSTALLER_BYTES { continue; }
            let Some(hash) = asset.get("digest").and_then(Value::as_str).and_then(parse_digest) else { continue; };
            cache.insert(url.to_string(), TrustedDigest { value: hash, size, until: now + 30 * 60_000 });
        }
    }
}

fn cached(value: &str) -> Option<(String, u64)> {
    digests().lock().ok().and_then(|cache| {
        cache.get(value).filter(|digest| digest.until > logging::now_ms())
            .map(|digest| (digest.value.clone(), digest.size))
    })
}

pub async fn trusted_digest(value: &str) -> Option<(String, u64)> {
    if !website::download_url(value) { return None; }
    if let Some(digest) = cached(value) { return Some(digest); }
    let url = url::Url::parse(value).ok()?;
    let parts: Vec<_> = url.path_segments()?.collect();
    // 官网是 `/downloads/{owner}/{repo}/{tag}/{name}`；自用 fork 的 GitHub 是
    // `/owner/repo/releases/download/{tag}/{name}`（2026-11-19 独立复核 P1-4：
    // 原来只认前者，GitHub 的 6 段路径直接返回 None → 缓存过期后下载被 fail-closed 拒）。
    let (repository, tag, api) = match parts.as_slice() {
        ["downloads", owner, repo, tag, _name] => {
            (format!("{owner}/{repo}"), tag.to_string(), website::API_BASE)
        }
        [owner, repo, "releases", "download", tag, _name] => {
            (format!("{owner}/{repo}"), tag.to_string(), "https://api.github.com")
        }
        _ => return None,
    };
    let endpoint = format!("{api}/repos/{repository}/releases/tags/{tag}");
    let response = website::fetch_json(&endpoint, 15_000).await.ok()?;
    if !response.status.is_success() { return None; }
    remember_website_release(&response.value, &repository);
    cached(value)
}

pub async fn download_plan(value: &str) -> Result<Value, UpdateError> {
    assert_downloadable(value)?;
    let (sha256, size) = trusted_digest(value).await
        .ok_or_else(|| UpdateError::new("未取得官网安装包校验值，已拒绝下载，请重新检查更新"))?;
    Ok(json!({ "url": value, "sha256": sha256, "size": size }))
}
