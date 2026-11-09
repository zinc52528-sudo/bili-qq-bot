# QQ Agent · Linux 服务器定制版

本仓库保存 QQ Agent 的服务器部署源码及本地扩展，替换此前的 AstrBot B 站插件集合。旧项目保留在备份分支 backup/pre-qq-agent-20261109。

基于 [K0nd1us/QQ-agent](https://github.com/K0nd1us/QQ-agent) 的 0.4.0 源码快照扩展，保留原作者 Kondius 的 MIT 许可证和各扩展署名。此快照导出于 2026-11-09；不是最新上游 OmniAgent 的兼容承诺。

## 已包含

- Linux 后台入口、网页控制台及登录保护。
- 日记记忆 2.0、设置中的日记浏览、分层会话记忆和短期记事本。
- 群聊/私聊独立周期上下文交接（配置后启用；保留原聊天存档）。
- 记忆导出、导入预览、恢复前备份及同名文件恢复。
- B 站自主浏览、扫码登录、峰谷调度、动态订阅、分享卡片解读。
- 主人识别、主动私信、好感度、表情技能、Token 节流及保守提前收尾。

源码与数据分离：仓库不含真实聊天、日记、画像、个人角色卡、API Key、B站Cookie、QQ登录态或服务令牌。它是源码包，不是已登录的完整服务器镜像。

## Linux 启动

需要 Node.js 20+，建议使用已部署验证过的 Node 版本。QQ 协议端需另外安装并登录，配置兼容的 OneBot 接口；本仓库不分发 QQ / SnowLuma 运行时。Windows 桌面功能仍保留在上游源码中，但本次导出仅核验服务器路径。

```bash
npm ci --omit=dev --ignore-scripts
export QQ_AGENT_DATA_DIR=/var/lib/qq-agent
mkdir -p "$QQ_AGENT_DATA_DIR"
npm run server:linux
```

注意：服务只监听本机 127.0.0.1，默认端口 3210。远程访问使用 SSH 转发；不要直接公开缺少额外访问控制的端口。首次启动后通过管理页设置模型、OneBot、主人及消息目标，凭据只保存在自己的数据目录。

实际部署可以将数据目录放在源码旁的 data/，但必须使用 QQ_AGENT_DATA_DIR 显式指向它，升级源码时不要覆盖。原有生产配置没有随本仓库上传，因此部署者需重新设置或从自己的私有备份恢复。

## 文档

- [Linux 部署与恢复](docs/LINUX-DEPLOYMENT.md)
- [上游原始 README](docs/UPSTREAM-README.md)
- 扩展开发规范：doc/extend_development/。

导入记忆会替换包内同名数据文件，不会逐条合并聊天；先检查预览和备份。自动重启目前针对 Linux systemd 用户服务 qq-agent-original.service，改用其它服务名需同步适配 src/routes.js。

## 验证范围

本次导出检查文件清单、敏感配置排除、JavaScript 语法及隔离核心测试；没有向真实 QQ 发送测试消息。不承诺全部第三方扩展在全新机器零配置即运行，也不承诺 Token 固定减半。
