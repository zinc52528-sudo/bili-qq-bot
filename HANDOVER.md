# HANDOVER.md — 交接日志

> 本文件记录 AstrBot 机器人运维过程中的关键修改，供后续维护/接手人快速还原上下文。
> 仓库：`zinc52528-sudo/bili-qq-bot`（实际承载 AstrBot 自定义插件集合）

---

## 1. 本次修改概览

| 项 | 内容 |
|---|---|
| 修改主题 | 钉钉「每日日报」推送路由修复 |
| 涉及插件 | `astrbot_plugin_daily_report` |
| 涉及文件 | `main.py`（核心逻辑），新增运行态文件 `dingtalk_target.json` |
| 修改时间 | 2026-08-07（服务器 astrbot 容器于 16:59 重启生效） |
| 负责人 | 小布（AI 运维助手） |
| 复核人 | 用户（Wzj） |
| 部署方式 | 直接改服务器宿主机插件文件（`/home/ubuntu/astrbot/data/plugins/` 与容器 `/AstrBot/data` 为 bind mount），`docker restart astrbot` 生效 |
| 是否入 Git | 是 — 本次已随本提交推入 GitHub（见第 4 节） |

---

## 2. 问题背景（用户反馈）

用户提出两类钉钉相关问题：
1. **钉钉推送系统有问题** —— 实际排查发现钉钉 bot 连接/收发一直正常（日志中 `dingtalk_sjca` 会话长期活跃），真正异常点是路由。
2. **钉钉总结日报会发到 QQ 上面** —— 根因确认：日报被硬编码推到 QQ 会话，而非钉钉会话。

---

## 3. 根因与具体改动

### 3.1 根因
`astrbot_plugin_daily_report` 的配置 `target_session` 硬写为 `default:FriendMessage:943867461`（这是一个 **QQ** 好友会话）。
无论是手动 `/日报` 命令，还是每天 08:00 的定时任务（`_send_daily_report`），都统一发往该 QQ 会话，导致「钉钉日报发到 QQ」。

### 3.2 具体改动（`main.py`）
1. **新增 `import os`**；`__init__` 启动时加载已保存的钉钉会话（`_load_dingtalk_target`）。
2. **`_send(text, target)` 改为会话感知**：
   - 手动 `/日报` 命令：回复到**触发该命令的会话**（通过 `event.get_session_id()` 获取）。
   - 08:00 定时任务：优先发到「记住的钉钉会话」；若该会话尚未初始化，则回退到配置里的 `target_session`（QQ 兜底）。
3. **新增 `_remember_dingtalk_target` / `_load_dingtalk_target`**：
   - 在**钉钉会话**中触发 `/日报` 时，自动把该钉钉会话字符串写入 `dingtalk_target.json`。
   - 之后每天 08:00 cron 自动将日报发到钉钉，无需再手动指定。
4. 命令别名保留：`daily_report` / `日报` / `日报测试`。

### 3.3 会话格式说明（重要坑）
- astrbot `MessageType` 枚举只有 `GroupMessage / FriendMessage / OtherMessage`，**没有** `ChatMessage`。
- 钉钉会话实际字符串格式为 `dingtalk_sjca:FriendMessage:<id>`（冒号在 workspace 名中转为下划线），可被 `MessageSession.from_str` 正确解析。
- 切勿自行编造 `ChatMessage` 等不存在的 type，否则 `from_str` 会抛 ValueError。

### 3.4 验证结果（全绿）
- 本地 + 远程 `py_compile` 通过。
- 插件加载成功（初始化日志 `main:90`）。
- cron 注册成功（DB 中 `每日日报` 作业 `6f7c1697` enabled，旧作业已清）。
- 钉钉会话字符串经 `MessageSession.from_str` 解析通过。

---

## 4. 上线后仍需用户完成的一步（关键）

> **用户需在钉钉会话里发一次 `/日报`（或 `日报`）**，bot 才会记住钉钉会话（`dingtalk_target.json`）。
> 此后每天 08:00 自动把日报发到钉钉。在此之前，cron 会回退到配置的 QQ 兜底会话。

---

## 5. 相关上下文 / 系统现状（备查）

- **服务器**：腾讯云 `119.91.249.160`，SSH 用户 `ubuntu`（sudo 免密）。
- **运行架构**：`docker` 编排，`astrbot`（主程序）+ `napcat-bili`（QQ 客户端 3906734056）。
- **AstrBot platform 配置**（`/home/ubuntu/astrbot/data/cmd_config.json` 的 `platform` 数组）：
  - `dingtalk_sjca` — type `dingtalk`，启用（本次路由修复对象）。
  - `default_1904741558` — type `qq_official`，已停用。
  - `default` — type `aiocqhttp`（napcat/QQ），启用。
  - **无任何微信适配器**（企业微信 `wecom_ai_bot` 内置但未启用；个人微信需第三方插件，未装）。
- **日志噪音（非本次范围）**：服务器启动偶报 `ModuleNotFoundError: data.plugins.astrbot_plugin_bilibiliobs`，源于此前把 `bilibiliobs` 改名 `.disabled` 后注册表仍引用。不影响日报功能，建议经 AstrBot WebUI 彻底卸载或清理 `plugins.json` 引用。
  - （已于 2026-08-11 修复：目录移出插件目录，见第 7 节。）

---

## 6. 历史改动索引（同一仓库的其他插件）

- `astrbot_plugin_dynamic_push`：B站动态/直播预约推送（v1.2.0 优化：长文完整推送、订阅指令 `/动态订阅`、视频动态去重交 bilivideo）。早于本次修改已推入本仓库。
- `astrbot_plugin_bilivideo`：视频推送 + AI 总结 + 订阅（已覆盖全部 dynamic_push 的 UP）。
- `astrbot_plugin_bilibili_livemonitor`：直播开播提醒。

---

## 7. 2026-08-11 批次：推送链路 / 插件 / 人格维护

### 7.1 修改概览

| 项 | 内容 |
|---|---|
| 修改主题 | bilivideo 推送平台前缀修复、视频总结超时放宽、直播推送带图+时长、bilibiliobs 载入失败清理、QQ 小程序卡片解析增强、如威人格更新、AstrBot WebUI 密码重置 |
| 修改时间 | 2026-08-10 23:45 ~ 2026-08-11 00:30（服务器时间，期间多次 `docker restart astrbot` 生效） |
| 负责人 | Codex（AI 运维助手） |
| 复核人 | 用户（Wzj） |
| 部署方式 | 直接改服务器宿主机插件文件（`/home/ubuntu/astrbot/data/plugins/` 与容器 `/AstrBot/data` 为 bind mount），`docker restart astrbot` 生效 |
| 是否入 Git | 是 — 随本提交推入 GitHub |

### 7.2 各问题根因与改动

1. **bilivideo 视频推送静默失败（最重要）**
   - 现象：AI 总结正常生成（音频/图片产物齐全），但 QQ 私聊与群始终收不到；48 小时日志内出现 42 次 `cannot find platform for session aiocqhttp:..., message not sent`。
   - 根因：`astrbot_plugin_bilivideo` 推送目标平台前缀写死为 `aiocqhttp`，而 AstrBot 该适配器的实例 ID 是 `default`；`send_message` 静默失败且插件仍推进 `last_bvid`，导致不重试。
   - 改动：`astrbot_plugin_bilivideo_config.json` 的 `message.platform_prefix` → `default`；`plugin_data/.../subscriptions.json` 的 `push_targets` 前缀同步改为 `default:`。
2. **视频总结超时**
   - 根因：AstrBot DeepSeek provider 请求超时仅 120s（比插件的 180s 还短），长视频转录总结易超时（实测一次 180s 超时）。
   - 改动：`cmd_config.json` provider timeout 120→300；插件 `LLM_CHAT_TIMEOUT_SECONDS` 180→300；`general.processing_timeout` 300→420。
3. **直播推送不带图**
   - 根因：livemonitor 只取 `user_cover`（主播自定义封面），多数直播间为空。
   - 改动：封面回退链 `user_cover → system_cover → keyframe → cover`。
4. **直播结束推送缺时长**
   - 改动：下播通知追加「本次直播时长 x时x分x秒」（基于 B 站 live_time 与下播时间差，取不到时回退检测时间）。
5. **bilibiliobs 载入失败**
   - 根因：`.disabled` 后缀目录仍被 AstrBot 按普通插件导入（`ModuleNotFoundError`）。
   - 改动：目录移出插件目录至 `data/disabled_plugins_bak/`（未删除，可恢复）。
6. **QQ 小程序卡片无法解析**
   - 根因：B 站小程序卡片 JSON 通常**不含 URL**，只有标题（`prompt`）；且解析器此前拿的是组件 repr 而非原始 JSON，偶发 Share 段也未被处理。
   - 改动：`message_router.py` 直接取 `Json.data` 序列化为干净 JSON；`auto_detect.py` 增加 raw payload URL 扫描、Share 段支持，并新增**标题搜索兜底**（识别为 B 站卡片且无链接时，用标题搜 B 站取首条）。
7. **如威技能/人格更新**
   - 改动：`skills/ruwei/SKILL.md` 与 personas 表同步更新：应激触发词表（张怡/恬豆→「几张/筹集/鸡」；嘉然/乃琳/ASOUL→「acg」/粗口；恨也迷人/恨子→仇视开团），并放开粗口（允许「去你妈的」等），保持群内玩笑式对线基调。仅群 1041495420 生效。
8. **AstrBot WebUI 密码重置**
   - 说明：原密码仅存哈希无法还原，已重置为强随机密码并单独告知用户；明文未入库、未入 Git，建议用户登录后自行修改。

### 7.3 备份清单（服务器插件目录/配置内）

- `astrbot_plugin_dynamic_push/main.py.bak-20260809`、`README.md.bak-20260809`、`_conf_schema.json.bak-20260809`
- `astrbot_plugin_bilivideo/bilivideo/core/constants.py.bak-20260810`
- `cmd_config.json.bak-20260810-timeout`、`astrbot_plugin_bilivideo_config.json.bak-20260810-timeout`
- `astrbot_plugin_bilibili_livemonitor/main.py.bak-20260811`、`main.py.bak-20260811-duration`
- `astrbot_plugin_bilivideo/bilivideo/handlers/auto_detect.py.bak-20260811*`、`parsing/message_router.py.bak-20260811*`、`parsing/url_extractor.py.bak-20260811`
- `astrbot_plugin_bilivideo_config.json.bak-20260811-prefix`、`subscriptions.json.bak-20260811-prefix`
- `data/skills/ruwei/SKILL.md.bak-20260811`

### 7.4 待验证 / 后续

- 下一个新视频 → 验证 bilivideo 推送真正到达 QQ（封面 + AI 总结）。
- 下一个开播/下播 → 验证封面图与时长文案。
- 转发 B 站小程序卡片 → 验证标题搜索兜底是否命中正确视频。
- 知识库 `kb.db` 仍为空，未配置 embedding provider（待用户选定方案：Ollama 本地 / 硅基流动 API 等）。
- 仓库名 `bili-qq-bot` 与内容（AstrBot 插件集）不符，改名待用户确认。

---

## 8. 2026-08-22/23 批次：推送全面中断事故排查与修复

### 8.1 事故概要

| 项 | 内容 |
|---|---|
| 事故时间 | 2026-08-06 ~ 2026-08-22（推送多次/长期中断），2026-08-22 22:00 起彻底中断 |
| 影响范围 | QQ 私聊 943867461 + 群 1041495420 的 bilivideo 视频推送、dynamic_push 动态推送、livemonitor 直播通知 |
| 根因层级 | NapCat 数据目录丢失 → 发送链路多环节连锁故障（图片 ENOENT → 反向 WS 通道断开 → AI 欠费/风控叠加） |
| 修复时间 | 2026-08-22 23:27 ~ 2026-08-23 00:09（含用户两次扫码登录） |
| 负责人 | Codex（AI 运维助手） |
| 复核人 | 用户（Wzj，已完成 DeepSeek 充值） |

### 8.2 根因链（按时间线）

1. **NapCat 数据目录丢失（最根本）**：NapCat 容器挂载源 `/home/ubuntu/bili-qq-bot/napcat/`（含 `qq/` 与 `config/`）随仓库目录消失而丢失。容器内 `/app/.config/QQ` 挂载为空，`/app/.config/QQ/NapCat/temp` 不存在。
2. **8/06 ~ 8/14：带图推送 ENOENT**——NapCat 无法写图片临时文件，所有带图发送报 `ActionFailed retcode=1200: ENOENT ... /app/.config/QQ/NapCat/temp/<uuid>`，全日志累计 2362 次。
3. **8/15 起：反向 WS 通道断开**——NapCat 的 onebot11 配置（含 `websocketClients` → AstrBot 反向 WS）随旧配置丢失，重启后 NapCat 重新生成**空网络配置**，不再连接 AstrBot 的 `0.0.0.0:6199`；AstrBot 发送报**空错误**（实为 aiocqhttp `ApiNotAvailable`，`str()` 为空）。8/15 起动态推送成功数归零，bilivideo 全部失败。
4. **DeepSeek 余额不足**：8/12-13、8/21-22 返回 `402 Insufficient Balance`（8/22 一天 1302 次）→ 视频 AI 总结生成失败。
5. **B 站 BCut ASR 风控**：8/20 起 `412 Precondition Failed`（8/22 达 283 次）→ 无字幕视频转写失败。
6. **bilivideo 死循环重试**：发送失败不推进 `last_bvid` → 每 5 分钟重试同一批视频，且**每轮重新生成总结**，8/15 起每天 1500~3600 条失败日志，进一步放大 API 消耗与日志体积（json 日志涨到 266MB）。
7. **dynamic_push 静默丢动态**：`_send_chain` 失败被吞掉，`last_dyn` 照常推进 → 失败的动态永不重试（8/15~8/22 期间动态全部静默丢失）。

### 8.3 修复动作

1. **重建 NapCat 数据目录**：`/home/ubuntu/bili-qq-bot/napcat/{qq,config}` 由 Docker 自动重建；重启后 NapCat 重新初始化（旧登录态无法恢复，需重新扫码）。
2. **扫码登录 QQ 3906734056**：用户 2026-08-22 23:50 与 23:57 两次扫码完成登录（NapCat 重启后未能从新数据目录自动恢复会话）。
3. **恢复 NapCat → AstrBot 反向 WS 通道**：
   - `docker network connect astrbot-napcat napcat-bili`（两容器原本不在同一 docker 网络，DNS 解析不到 `astrbot`）。
   - 改写 `onebot11_3906734056.json` 的 `network.websocketClients`：
     ```json
     {"name":"astrbot","enable":true,"url":"ws://astrbot:6199/ws",
      "messagePostFormat":"array","reportSelfMessage":false,
      "reconnectInterval":5000,"token":"wzj943867461","debug":false,"heartInterval":30000}
     ```
   - 重启 napcat 生效；AstrBot 日志恢复 `aiocqhttp(OneBot v11) 适配器已连接。`
4. **dynamic_push 修复**（`astrbot_plugin_dynamic_push/main.py`，已随本批次入 Git）：
   - `_send_chain` 改为返回 `bool`（全部目标成功才 True）。
   - 发送未全部成功时**不推进 `last_dyn`**，下轮自动重试，不再静默丢动态。
5. **bilivideo 修复**（`bilivideo/handlers/scheduled_push.py`，第三方插件，补丁留存 `docs/patches/`）：
   - 发送失败退避：同一视频 5 → 10 → 20 → 30 分钟封顶重试，不再每 5 分钟死循环。
   - 缓存已生成推送内容（TTL 2h），重试时**不再重复调用 DeepSeek/BCut**。
6. **验证 DeepSeek 充值生效**：日志恢复 `POST https://api.deepseek.com/v1/chat/completions "HTTP/1.1 200 OK"`，402 消失。

### 8.4 验证结果（全绿）

- AstrBot 重新收到 QQ 群消息（aiocqhttp 事件通道恢复）。
- 00:01 起 NapCat 日志确认：`发送 -> 私聊 (943867461)` 与 `发送 -> 群聊 [推送测试(1041495420)]` 均成功，**带图片**（鸣潮/星瞳/北华念/LPL 等）。
- 订阅 `subscriptions.json` 的 `last_bvid` 正常推进（仅发送成功才更新）。
- 12 分钟窗口内 0 条 `push ... failed` / `not marked as pushed`。
- dynamic_push、daily_report、bilivideo、livemonitor 插件均正常加载。

### 8.5 注意事项 / 遗留

- **8/15~8/22 期间静默丢失的动态无法补推**（旧 bug 已推进状态）；8/23 起新动态/新视频恢复正常推送。
- **NapCat WebUI token 已变化**：旧 `930cea95364e` 失效，新 token `c4ea12c42549`（`/home/ubuntu/bili-qq-bot/napcat/config/webui.json`）。WebUI：`http://119.91.249.160:6098/webui?token=c4ea12c42549`。
- NapCat 重启后若不出二维码，可检查 `napcat_3906734056.json` 的快速登录项（本次新装后需手动扫码）。
- 建议：SSH 密码、NapCat WS token、AstrBot ws_reverse_token 目前均为 `wzj943867461`，仍建议尽快更换并同步三处。
- 备份文件：`onebot11_3906734056.json.bak-20260822-empty`；插件 `.bak-20260822`。
- bilivideo 补丁在 `docs/patches/2026-08-23_bilivideo_scheduled_push_backoff.py`，服务器对应文件带 `.bak-20260822` 原版。

---

*生成方式：由 AI 运维助手根据服务器实际改动与日志整理，经用户复核。*
