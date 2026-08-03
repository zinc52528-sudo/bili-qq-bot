# Architecture


## 总体结构


QQ
 |
 v
消息适配层
 |
 v
Agent
 |
 +------ Skill
 |
 +------ Memory
 |
 +------ Database


## 模块说明


### Adapter

负责接收和发送消息。

例如:
- QQ
- AstrBot


### Agent

负责理解用户需求。

职责:
- 判断意图
- 调用Skill
- 组织回复


### Skill

具体能力模块。

例如:

bilibili:
- 登录
- 动态检测
- 视频信息

weather:
- 天气查询


### Memory

保存长期信息。

例如:
- 用户偏好
- 历史任务


### Database

保存结构化数据。

例如:
- 订阅列表
- 配置
- 日志
