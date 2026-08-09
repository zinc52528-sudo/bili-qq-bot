# astrbot_plugin_daily_report

**每日早报插件（AstrBot）** —— 每天 08:00 自动推送日报，也可用 `/日报` 手动触发。确定性链路，不依赖 LLM 唤醒。

## 功能板块

- 🌤 今日天气（和风天气，JWT 认证）
- 🗓 今日安排（来自 AstrBot 定时任务表）
- ⚔️ 今日赛事（B 站赛事账号动态 + LLM 总结 / Exa 搜索兜底）
- 📢 新视频（关注的 UP，近 48 小时）
- 🔔 直播预约（今天 / 明天 / 未来，⏰ 标记临近场次）
- 📰 新动态（近 48 小时）

## 推送目标

- 手动 `/日报`：回复到触发会话（QQ / 钉钉均可）；若在钉钉触发，会自动记住该钉钉会话
- 定时 08:00：优先推送“记住的钉钉会话”，未记录时回退到配置的 `target_session`

## 配置

插件配置（`data/config/astrbot_plugin_daily_report_config.json`）关键字段：

| 字段 | 说明 |
|---|---|
| `target_session` | 默认推送会话（QQ 私聊 / 群） |
| `cron_expression` | 自动推送时间，默认 `0 8 * * *` |
| `default_city` | 天气城市 |
| `api_host` / `auth_mode` / `api_key` / `credential_id` / `project_id` | 和风天气认证（JWT 或 API Key） |
| `private_key_path` | 和风 JWT 私钥路径 |
| `exa_key` | Exa 搜索兜底密钥（可选） |
| `bili_cookie_path` | B 站登录态 cookies（复用 bilivideo 插件） |
| `bili_esports_uids` / `bili_extra_uids` | 赛事 / 额外关注的 UP |

## 依赖

- AstrBot v4.x
- 同部署下的 `astrbot_plugin_bilivideo`（复用 B 站登录态与订阅）
- `cryptography`（和风 JWT 签名）

## 更新日志

### v1.1.0
- 新增钉钉推送目标记忆：钉钉触发 `/日报` 后，08:00 定时任务推送到该钉钉会话（`dingtalk_target.json`）
- 手动触发改为回复到触发会话
