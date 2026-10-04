# 贡献指南

基础开发流程见 [现有贡献指南](docs/contributing.md)，消息/一起听贡献先阅读 [模块设计](docs/social/design.md) 和 [协议验证矩阵](protocols/netease-native/README.md)。派生代码继续采用 AGPL-3.0；改写第三方代码时保留来源和许可证。

跨进程类型放 shared/types，原生社交协议放 services/social/netease-native，不能加入通用音乐 API 入口。注释采用中文 JSDoc，文件使用 Prettier；集合有界，IPC 输入有运行时校验，页面和主进程退出须取消请求与订阅。

每个协议变更提交客户端版本、签名路径、响应 schema、脱敏 fixture、成功/失败复现和验证状态。不要上传 Cookie、账号库、设备标识、真实消息、原始抓包或 debug profile；未知的 Windows 行为明确标注待验证，不以其他平台接口响应代替两端验收。

发送或房间控制没有确认幂等性前不得自动重试。改动需运行类型检查、相关 node/web 测试、lint 和格式检查；渲染/缓存/IPC 变更需附实机内存对比。未验证的回执、邀请或房间激活不得显示为成功或宣称可用。
