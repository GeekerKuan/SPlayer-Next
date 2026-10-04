# 2026-10-05 列表报告与双人口味推荐

本篇更新早期记录中“缺开关参数”的结论。原始安装包、反编译输出、账号凭据和测试房间信息仅保存于仓库外私有工作目录。

## 原版 Windows 加歌

官方 Windows `3.1.40.205461 / d4d4312` 的列表模块先响应本机队列事件，再报告服务端。ADD/DELETE 传增量 ID，REPLACE/PLAYMODE_CHANGE 传完整列表。ADD 的锚点是当前曲目及其在已变更 displayList 中的下标；其他命令默认空锚点、-1。报告前更新本账号的消息版本；随机顺序和展示顺序分别保留。

原列表报告的成功判定为 `code === 200` 或 `data.result` 为真。它没有等待三次读取确认再执行本地播放的门槛。当前 SPlayer 对交互 ADD 沿用该接受规则，再由既有轮询确认；未知写入不重放。心跳和播放控制仍要求各自已有的明确结果，不把列表规则推广过去。

这是官方 bundle 的调用逻辑证据；不能将其声称为本轮捕获了所有底层网络报文。既有 CDP 只读观测已限时结束并回收。

## 官方 Android 开关及实际服务端验证

应用宝 VM：Android 13，网易云 `9.6.05 / 9006005`，普通 shell、非 debuggable 应用。安装包 SHA-256：`6efecd9a422a0660504241026ef0e801bfa07c33b6ba1e5ed3ba0cf5b7853ba7`。

原版 classes17.dex 的推荐请求提交：

- 签名路径：`/api/listen/together/heart/rcmd/change`。
- 业务字段：`status` 数字 1（开启）/0（关闭），以及当前 `roomId`。
- 原响应模型：`success`、`refreshPlaylist`、`toast`。原调用方仅在 success 为 true 时更新本机意愿；refreshPlaylist 为 true 时通知播放器重新取列表，不用本地 REPLACE 模拟切换。

使用已授权的两测试账号，通过原版 Windows 创建并邀请，SPlayer 接受后核对两人、房主及同一房间。受控验证沿用当前 PC eapi 传输，用上述 Android 业务字段各发送一次开启和关闭，未重放：

| 状态   | success | refreshPlaylist | roomInfo.openHeartRcmd | 房间曲目数 |
| ------ | ------- | --------------- | ---------------------- | ---------- |
| 开启前 | —       | —               | false                  | 2          |
| 开启   | true    | true            | true                   | 20         |
| 关闭   | true    | true            | false                  | 2          |

关闭后的展示 ID 顺序与开启前完全一致。服务端本轮 `listMode` 始终为空，因此仅依赖 `listMode=heart` 会漏判，并可能误把个人自动续歌加入心动列表。当前同时识别已核验的 openHeartRcmd；模式改变时取消旧队列投影、播放意图及末曲续歌，列表恢复完全使用服务端响应。

本轮测试成功仅覆盖有权限的房主。非会员、不同角色及服务端拒绝由 success=false 的自动测试和文案兜底，不能称为实测了非会员账号。开启/关闭请求结果未知时不重试，后续只读轮询以服务端状态为准。未改变 eapi 加密、PC 请求身份、单位或登录管理。

## 在线状态与聊天载荷的边界

Android `listen/together/user/state/get/set` 操作的是一起听个性状态（state 对象），不是聊天在线认证或在线心跳。不会把它接成“本机在线上报”。聊天在线的认证、续期、离线期限及退出撤销仍未核验。

当前 release VM 没有 root、应用不可 run-as 调试，logcat 样本没有可用的明文请求。安装包静态调用有助于定位端点，但不能替代 TLS 内实际载荷。Android 默认 CA 信任及非 root 动态观测限制见 [Android 网络安全配置](https://developer.android.com/privacy-and-security/security-config) 和 [Frida Android 说明](https://frida.re/docs/android/)。本轮没有安装代理证书、重签或替换已登录 APK、修改手机系统、伪造聊天总结时长。

更多聊天和总结卡的有效原始载荷仍需可观测的调试环境或用户提供受控明文样本。未知 PC 消息保留安全文字兜底。

本轮受控测试结束后，SPlayer 已退出并恢复原普通队列；再次只读核对官方账号已无房间，没有重复发送退出请求。新增回归覆盖推荐读取期间远端开启心动模式，旧候选不得追加到新列表。
