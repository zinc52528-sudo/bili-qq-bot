# AstrBot B 站推送插件集

运行在 [AstrBot](https://github.com/AstrBotDevs/AstrBot) 上的 B 站动态 / 日报推送插件集合，通过 NapCat（OneBot）向 QQ 私聊与群聊推送关注 UP 的最新动态、直播预约和每日早报。

> 说明：本仓库原为「Bili QQ Bot」机器人项目，QQ 机器人主体代码已移除；当前仅保留 AstrBot 自定义插件与运维文档。

## 插件列表

| 插件 | 版本 | 功能 |
|---|---|---|
| [astrbot_plugin_dynamic_push](astrbot_plugin_dynamic_push/README.md) | v1.2.0 | B 站非视频动态推送（文字/图文/转发/专栏）+ 直播预约/开播预告；聊天内订阅管理指令；长动态自动分段完整送达 |
| [astrbot_plugin_daily_report](astrbot_plugin_daily_report/README.md) | v1.1.0 | 每日 08:00 早报：天气、今日安排、赛事、新视频、直播预约、新动态；支持钉钉会话记忆推送 |

部署环境中还启用了 `astrbot_plugin_bilivideo`（视频动态 + AI 总结）、`astrbot_plugin_bilibili_livemonitor`（直播开播提醒）等插件，源码见各插件官方仓库。

## 快速开始

1. 将需要的插件目录复制到 AstrBot 插件目录（通常为 `data/plugins/`）
2. 在 `data/config/` 下按需修改插件配置（见各插件 README）
3. 重启 AstrBot 使插件生效

前置条件：AstrBot v4.x、已配置 NapCat / OneBot 适配器、`astrbot_plugin_bilivideo`（复用 B 站登录态）。

## 维护文档

- [HANDOVER.md](HANDOVER.md) — 运维修改日志

## 安全提示

- `data/config/*.json` 包含 API 密钥、会话 ID 等敏感信息，请勿提交到仓库
- 各插件使用 WBI 签名 + 登录态 cookies 访问 B 站接口，注意轮询频率以免触发风控
