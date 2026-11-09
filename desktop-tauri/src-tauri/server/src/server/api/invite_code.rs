//! 邀请码：查状态（GET）与绑定（POST）。
//!
//! ── 这一层只做三件事 ─────────────────────────────────────────
//! ① 参数整形与校验（邀请码非空、长度、控制字符）；
//! ② 找到账号对应的提供商插件；
//! ③ 把动作名连同参数透传给 `admin.action`。
//!
//! 真正的上游调用、`deviceId` 生成规则、业务码判定全在插件里（`loomy` 的
//! `invite.status` / `invite.bind`）—— 网关不认识 `loomy-campus-` 前缀，也
//! 不该认识。与 `campaign_rewards` / `codearts_welfare` 同一分层。
//!
//! ── 为什么 GET/POST 共用一条路径 ─────────────────────────────
//! 两者是同一件事的两个方向（看有没有填 / 填一个），路径写成一个语义单元比
//! 拆成 `/invite-code/status` + `/invite-code/bind` 更好读；按 HTTP method 分派
//! 也是 REST 的常规做法。

use axum::{body::Bytes, response::Response};
use serde_json::Value;

use crate::server::core::providers::adapter::adapter_by_id;
use crate::server::errors::management_error;
use crate::server::http::{ok_json, parse_body};
use crate::server::ServerState;

/// 账号 → 提供商 id（账号不存在直接 404）
fn provider_of(state: &ServerState, account: &str) -> Result<String, Response> {
    state
        .store()
        .account_provider_of(account)
        .ok_or_else(|| management_error(404, "找不到该账号"))
}

/// `GET /api/accounts/{id}/invite-code` —— 查这个号填没填、填的哪个码。
///
/// 上游返回 `{ activated, appliedInvitationCode? }`，只读，可随时重复调用。
pub async fn status(state: &ServerState, account: &str) -> Response {
    let provider = match provider_of(state, account) {
        Ok(provider) => provider,
        Err(response) => return response,
    };
    let Some(adapter) = adapter_by_id(&provider) else {
        return management_error(503, "提供商插件尚未就绪");
    };
    match adapter
        .admin_action(state.store(), account, "invite.status", &Value::Null)
        .await
    {
        Ok(value) => ok_json(value),
        Err(error) => management_error(error.status_code, error.message),
    }
}

/// `POST /api/accounts/{id}/redeem-code` `{ code }` —— 兑换一个兑换码。
///
/// 与邀请码是两条独立的上游路径（`points/redemption-codes/redeem` vs
/// `points/activation`），只是校验规则同族；一个号可以兑多个不同的码，所以这里
/// 不做「已兑过就拒」的判断，由上游各自校验。
pub async fn redeem(state: &ServerState, account: &str, body: &Bytes) -> Response {
    let payload = match parse_body(body) {
        Ok(payload) => payload,
        Err(error) => return management_error(error.status_code, error.message),
    };
    let code = payload
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if code.is_empty() {
        return management_error(400, "请填写兑换码");
    }
    if code.len() > 128 || code.chars().any(char::is_control) {
        return management_error(400, "兑换码格式不合法");
    }

    let provider = match provider_of(state, account) {
        Ok(provider) => provider,
        Err(response) => return response,
    };
    let Some(adapter) = adapter_by_id(&provider) else {
        return management_error(503, "提供商插件尚未就绪");
    };
    match adapter
        .admin_action(
            state.store(),
            account,
            "invite.redeem",
            &serde_json::json!({ "code": code }),
        )
        .await
    {
        Ok(value) => ok_json(value),
        Err(error) => management_error(error.status_code, error.message),
    }
}

///
/// `POST /api/accounts/{id}/invite-code` `{ code }` —— 绑定邀请码。
///
/// 上游对已绑过的号会返回 `alreadyActivated: true`：那是「本来就有」而不是
/// 「这次失败」，原样透出交给界面判断，这里不当错误处理。
pub async fn bind(state: &ServerState, account: &str, body: &Bytes) -> Response {
    let payload = match parse_body(body) {
        Ok(payload) => payload,
        Err(error) => return management_error(error.status_code, error.message),
    };
    let code = payload
        .get("code")
        .or_else(|| payload.get("inviteCode"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if code.is_empty() {
        return management_error(400, "请填写邀请码");
    }
    if code.len() > 64 || code.chars().any(char::is_control) {
        return management_error(400, "邀请码格式不合法");
    }

    let provider = match provider_of(state, account) {
        Ok(provider) => provider,
        Err(response) => return response,
    };
    let Some(adapter) = adapter_by_id(&provider) else {
        return management_error(503, "提供商插件尚未就绪");
    };
    match adapter
        .admin_action(
            state.store(),
            account,
            "invite.bind",
            &serde_json::json!({ "code": code }),
        )
        .await
    {
        Ok(value) => ok_json(value),
        Err(error) => management_error(error.status_code, error.message),
    }
}
