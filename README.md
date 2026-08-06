# astrbot_plugin_dynamic_push

**B 站动态推送插件（AstrBot）** —— 监控指定 UP 主的最新动态，发现新内容即推送到 QQ（私聊 / 群）。

本项目是一套运行在 [AstrBot](https://github.com/AstrBotDevs/AstrBot) 上的 B 站 → QQ 推送方案的一部分。整条链路为：

```
B 站动态/直播接口  ──(WBI 签名 + 登录态 cookies)──►  astrbot_plugin_dynamic_push
                                                          │
                                                          ▼
                                              QQ（通过 napcat / OneBot 协议）
```

---

## 功能特性

- **全类型动态推送**：文字、图文、转发、专栏、直播预约、开播预告，发现新动态即刻推送。
- **长动态完整送达**：不再截断为「…」。正文超长时自动分段（默认每段 3500 字）逐条发送，保证内容完整。
- **视频去重（与 bilivideo 协作）**：纯视频动态（投稿视频）交由 `astrbot_plugin_bilivideo` 推送（该插件附带 AI 字幕总结），本插件主动跳过，避免同一个视频被推两条。
- **聊天内订阅管理**：不用改配置文件，直接在 QQ 里用指令增删订阅、查看列表。
- **结构化排版**：标题 + 分隔线 + 正文的清爽格式，附带发布时间和动态链接。

> ⚠️ 重要约定：本插件**只推非视频动态**。视频动态由 `bilivideo` 负责。因此请确保你订阅的 UP 主**也已在 bilivideo 订阅**，否则其视频动态将收不到推送。

---

## 与其他 B 站插件的分工

| 插件 | 职责 | 状态 |
|------|------|------|
| `astrbot_plugin_dynamic_push`（本插件） | 非视频动态（文字/图文/转发/专栏）+ 直播预约 / 开播预告 | ✅ 活跃 |
| `astrbot_plugin_bilivideo` | 视频动态推送 + AI 总结 + 视频订阅 | ✅ 活跃 |
| `astrbot_plugin_bilibili_livemonitor` | 直播开播提醒（ids 列表） | ✅ 活跃 |
| `astrbot_plugin_bilibili_live` | 直播间弹幕等，两开关均 `enable:false` | ⛔ 配置停用（保留目录） |
| `astrbot_plugin_bilibiliobs` | 开播监测，与 livemonitor 重复且未配置任何 UP | ⛔ 已停用 |

---

## 安装

将本插件文件夹放入 AstrBot 的插件目录（通常为 `data/plugins/astrbot_plugin_dynamic_push`），重启 AstrBot 即可加载。

前置依赖：
- AstrBot v4.x
- 同一部署下已安装 `astrbot_plugin_bilivideo`（用于复用 B 站登录态 cookies 与视频推送）
- 已配置好 napcat / OneBot 适配器，使 AstrBot 能向目标 QQ 发消息

---

## 配置

插件配置（`data/config/astrbot_plugin_dynamic_push_config.json`）字段说明：

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `uids` | 监控的 UP 主列表，格式 `mid:名称`，多个用英文逗号分隔。也可在聊天中用指令管理 | `50329118:哔哩哔哩英雄联盟赛事` |
| `check_interval_minutes` | 轮询间隔（分钟）。**建议 ≥ 3**，过低可能触发 B 站风控（-400） | `3` |
| `push_target` | 推送目标会话，格式 `platform:消息类型:会话ID`，多个用英文逗号分隔 | `default:FriendMessage:943867461,default:GroupMessage:1041495420` |
| `bili_cookie_path` | B 站登录态 cookies 文件路径，默认复用 bilivideo 的 | `/AStrBot/data/plugin_data/astrbot_plugin_bilivideo/bili_cookies.json` |
| `max_preview_chars` | 单条消息正文上限（字符）。`0` = 不限制（长动态完整推送并自动分段）；`>0` 时作为单段上限 | `0` |

---

## 指令

在 QQ 中向机器人发送：

| 指令 | 别名 | 说明 |
|------|------|------|
| `/动态订阅` | `动态订阅列表`、`我的动态订阅` | 查看当前订阅的 UP 主列表 |
| `/动态订阅添加 <参数>` | `添加动态订阅`、`订阅动态` | 新增订阅。参数支持 **UID** / **空间链接**（`space.bilibili.com/123`）/ **昵称**（昵称会自动搜索并补全） |
| `/动态订阅移除 <参数>` | `移除动态订阅`、`取消动态订阅` | 取消订阅，参数为 UID 或昵称 |
| `/动态状态` | `动态推送状态` | 查看监控的 UP、已记录的最新动态 ID 与下次检查时间 |

示例：

```
/动态订阅添加 233114659
/动态订阅添加 space.bilibili.com/15532638
/动态订阅添加 老番茄
/动态订阅
/动态订阅移除 老番茄
```

> 添加 / 移除会**持久化到配置文件**，重启后依然生效。

---

## 实现要点

- **接口鉴权**：使用 B 站 WBI 签名（`_derive_mixin_key` / `_sign_params`）+ 登录态 cookies，兼容 IP 风控；请求失败时自动跳过并退避，不会因单次异常中断轮询。
- **动态解析**：兼容 `WORD / DRAW / AV / ARTICLE / FORWARD / LIVE_RCMD` 等多种动态类型，统一提取正文、图片、直播预约卡、开播预告等字段。
- **视频分流**：`_format_push` 遇到 `DYNAMIC_TYPE_AV`（纯视频动态）直接返回 `None`，交给 bilivideo，避免重复。
- **长文分段**：`_send` 按 `MAX_MSG_CHARS`（3500）自动切分，逐条发送，图片 / 表情随首段附带。

---

## 更新日志

### v1.2.0
- 长文字动态改为完整推送（移除 120 字截断），超长自动分段。
- 新增聊天内订阅管理指令（`/动态订阅 列表|添加|移除`），支持 UID / 空间链接 / 昵称搜索，并持久化到配置文件。
- 推送排版结构化（标题 + 分隔线 + 时间 + 链接）。
- 视频动态分流至 bilivideo，消除重复推送；订阅 UP 与 bilivideo 对齐。

---

## 许可证

自用项目，按需取用。
