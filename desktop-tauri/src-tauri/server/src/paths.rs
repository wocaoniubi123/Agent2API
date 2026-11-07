//! 配置目录与相关路径的**唯一事实来源**。
//!
//! 拆分前这段实现住在桌面 crate 的 `gateway.rs`（`crate::gateway::config_dir`
//! 是唯一事实来源，`server::config` 只做转发）。网关拆成独立 crate 后事实
//! 来源随迁到这里：`paths::config_dir` 是唯一实现，桌面侧 `gateway::config_dir`
//! 反过来转发本模块 —— 「两条路径、一个实现」的约定不变，只是方向反了。
//!
//! ── 环境变量 ────────────────────────────────────────────────
//! `AGENT2API_PROXY_HOME` 优先，旧名 `WORKBUDDY_PROXY_HOME` 兼容读（1.x 的
//! 启动脚本/快捷方式里可能还留着旧名）。Docker 部署把它指到挂载卷
//! （compose 示例：`AGENT2API_PROXY_HOME=/data`），数据即可留在容器外。

use std::path::PathBuf;
use std::sync::OnceLock;

/// 配置目录：默认 `{用户主目录}/.agent2api`，可被环境变量整体覆盖。
pub fn config_dir() -> PathBuf {
    env_path("AGENT2API_PROXY_HOME")
        .or_else(|| env_path("WORKBUDDY_PROXY_HOME")) // 旧名兼容读
        .unwrap_or_else(default_config_dir)
}

/// 读环境变量里的目录覆盖：未设置 / 全空白一律当未设置
fn env_path(name: &str) -> Option<PathBuf> {
    let custom = std::env::var(name).ok()?;
    let trimmed = custom.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

/// 默认配置目录：优先 `{exe 所在目录}/data`，不可写才回落 `{用户主目录}/.agent2api`。
///
/// ── 为什么优先放在 exe 旁边 ──────────────────────────────────────
/// 安装包允许用户自选安装目录，产物就该跟着安装目录走：整个目录拷走即迁移，
/// 卸载重装也不丢数据。只有在 exe 旁确实写不进去时才回落到传统位置 ——
/// 例如被装进了没有写权限的 Program Files、或 exe 位于只读介质上。回落保证
/// 任何安装位置都能启动，代价只是数据不跟随。
fn default_config_dir() -> PathBuf {
    // 探测要实建目录 + 实写文件，而 `config_dir()` 在运行期被反复调用，
    // 结果只算一次并缓存。
    static RESOLVED: OnceLock<PathBuf> = OnceLock::new();
    RESOLVED
        .get_or_init(|| exe_side_dir().unwrap_or_else(home_config_dir))
        .clone()
}

/// exe 同级的 `data` 目录，仅在该位置确实可写时返回。
///
/// 判据是「建目录 + 写一个探针文件 + 删掉」，不看权限位：安装目录可能是
/// Program Files（普通用户无写权限）、只读介质，或被杀软锁定的路径，
/// 光看属性判断不准。
fn exe_side_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.join("data");
    std::fs::create_dir_all(&dir).ok()?;
    let probe = dir.join(".write-probe");
    std::fs::write(&probe, b"agent2api").ok()?;
    let _ = std::fs::remove_file(&probe);
    Some(dir)
}

/// 传统配置目录：`{用户主目录}/.agent2api`（exe 旁不可写时的回落）。
///
/// 也用于「把旧位置的数据搬到 exe 旁」这条一次性迁移 —— 见
/// `server::config_migration`。名字单独暴露，是因为迁移需要知道
/// 「除当前 `config_dir()` 之外，上一版把数据放过哪」。
pub fn home_config_dir() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".agent2api")
}

/// 旧桌面设置文件的路径（`{config_dir}/desktop-settings.json`）。
///
/// 拆分前由桌面 crate 的 `settings::legacy_file_path()` 提供；本 crate 的
/// 一次性迁移（`db::migrate::settings`）要定位这个文件，而 headless 下
/// 桌面 crate 根本不参与 —— 所以路径事实来源随 `config_dir` 一起迁到本
/// 模块，桌面侧的 `settings::legacy_file_path()` 反过来转发这里。
///
/// 文件名是历史事实：这个文件已不再是设置的真相来源（进了 SQLite 的
/// `kv` 表），名字只被迁移与回落读路径引用，不会随代码演进变化。
pub fn legacy_desktop_settings_file() -> PathBuf {
    config_dir().join("desktop-settings.json")
}
