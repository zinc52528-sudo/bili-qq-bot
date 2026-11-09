# Linux 部署说明

项目根目录为 package.json 所在目录；数据通过 QQ_AGENT_DATA_DIR 独立保存。运行 npm ci --omit=dev --ignore-scripts 后执行 npm run server:linux。使用页面配置 OneBot、API、主人与私聊或群聊目标，社区扩展账号按需重新登录。

默认监听 127.0.0.1:3210，首次管理员令牌按程序生成逻辑和控制台提示获取。不要将生产 config.json、私钥、Cookie、.env、data/ 或记忆备份提交到公开仓库。

systemd 用户服务示例（路径需按本机修改）：

[Service]
WorkingDirectory=/opt/qq-agent
Environment=QQ_AGENT_DATA_DIR=/var/lib/qq-agent
ExecStart=/usr/bin/node /opt/qq-agent/src/server-linux.mjs
Restart=on-failure

记忆导入的自动重启逻辑当前使用 qq-agent-original.service；更换服务名、用户 UID 或主机结构时要核对该接口。QQ 需单独部署并登录，媒体共享路径应能被协议容器读取。备份需同时保留源码版本、插件源码和私有数据；本源码包不包含私人数据。

恢复前停止正在执行的回复，保存私有数据备份，再在管理页预览导入。仓库主分支替换不会更新或重启现有服务器。
