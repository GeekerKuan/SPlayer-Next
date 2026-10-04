# 网易云原生社交通道协议资料

实现：`electron/main/services/social/netease-native/`。新消息/房间协议与原音乐 API、旧听歌打卡协议分开。这里只保存字段、枚举、脱敏 fixture、版本与验证结果；Cookie、账号 profile、流量原件和官方客户端完整脚本不能提交。

## 路径与证据

| 能力                       | 签名路径                                      | 当前证据                                                                                 |
| -------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 账号                       | /api/w/nuser/account/get                      | PC eapi 真实账号成功                                                                     |
| 会话                       | /api/msg/private/users                        | PC eapi 拉取与未读样本成功                                                               |
| 历史                       | /api/msg/private/history                      | time=-1 最新页；取历史有隐式已读副作用                                                   |
| 文本发送                   | /api/msg/private/send                         | 用户授权单次回发，手机确认收到；type 6                                                   |
| 通知                       | /api/msg/notices                              | 空数组成功，非空样本待验收                                                               |
| 提及                       | /api/forwards/get                             | 空数组成功，游标 lasttime                                                                |
| 评论                       | /api/v1/user/comments/{uid}                   | 空数组成功，非空样本待验收                                                               |
| 每日推荐                   | /api/v3/discovery/recommend/songs             | 独立 PC eapi，31 首去重候选                                                              |
| 房间状态                   | /api/listen/together/status/get               | 独立读取，按成员数和 creatorId 派生状态                                                  |
| 房间检查                   | /api/listen/together/room/check               | 独立只读响应已核验                                                                       |
| 队列与指令                 | /api/listen/together/sync/playlist/get        | displayList / randomList / version / playCommand / rcmdSongIds                           |
| 接受邀请                   | /api/listen/together/play/invitation/accept   | 官方客户端关闭，SPlayer 独立加入，手机确认双方及暂停/切歌同步                            |
| 创建房间                   | /api/listen/together/room/create              | 独立创建、初始化歌曲、心跳成功；好友收到邀请并确认加入                                   |
| 原生邀请                   | /api/listen/together/invite/message/send      | 独立主机发送一次原生邀请，手机确认接受并加入                                             |
| 心跳                       | /api/listen/together/heartbeat                | SPlayer 每 20 秒上报本机实际播放，检查 data.result；不由官方客户端代维持                 |
| 播放控制                   | /api/listen/together/play/command/report      | commandInfo JSON 字符串；PLAY / PAUSE / PROGRESS / NEXT / PREVIOUS / GOTO，毫秒 progress |
| 队列更新                   | /api/listen/together/sync/list/command/report | Windows 使用 playlistParam JSON 字符串；ADD 增量及自身版本递增，独立加歌实测通过         |
| 退出房间                   | /api/listen/together/end/v2                   | 实测返回 data.success / shareInfo 等；再次查状态确认离开，不能套用心跳 data.result       |
| 官方分享短链               | /api/middle/shorturl/generate                 | url 为受控一起听 H5；data.shortUrl 为 163cn.tv；官方 wrapper 与独立 eapi 及 302 参数核验 |
| 跨设备最近播放             | /api/play-record/song/list                    | limit 300，真实 Unix 毫秒 playTime；本轮 299 条含 Android 来源                           |
| 跨端配置                   | /api/relay/config/get                         | enable、snapshotSize；只读已核验                                                         |
| 跨端入口                   | /api/link/position/show/resource              | multi_terminal_reconnect_info / extJson；读取成功，本次未得到续播 offer                  |
| 领取续播                   | /api/relay/play/pull                          | 完整 offer 透传并附 targetDeviceId；参数依据官方逻辑，真实领取待验收                     |
| 续播歌单                   | /api/v6/playlist/detail                       | 仅处理已核验的 playlist 来源，最多 1000 首；参数测试通过                                 |
| 跨端源列表                 | /api/relay/songlist/submit                    | songListSubmitReq 为序列化 JSON；独立提交成功                                            |
| 跨端状态                   | /api/relay/play/state/submit                  | playStateSubmitReq 为序列化 JSON；曲目/模式变化提交，歌曲 progress 为 0                  |
| 在线可见性隐私             | /api/user/setting                             | 只读见 mutualFollowSeeOnline；不是在线上报，未据此写入                                   |
| 在线上报                   | 未确认                                        | 认证、续期、ACK 与离线撤销缺证据；未加入空开关或猜测请求                                 |
| WS 推送                    | wss://im.music.163.com                        | 应用 socket 已见，认证 / ACK / 续传未完整逆向；生产采用 eapi 轮询                        |
| 撤回 / 远端拒绝 / 对方已读 | 未确认                                        | 不开放；忽略仅是本机操作，未伪造远端回执                                                 |

PC eapi 域名 `https://interfacepc.music.163.com`；签名 `/api/...`，HTTP `/eapi/...`，表单外层 params，内层加密 JSON 含 PC header、CSRF、e_r=false。参考的明文 HTTP 表单不能混称 eapi。

新建房间的队列响应可能为 `data:{}` 或 `playlist:null`，首次 ADD 前规范化为空队列。ORDER_LOOP 的 `randomList:null` 是有效响应。serverSeq 处理远端顺序，playbackRevision 处理本机成功写入后的即时播放；position 刷新不取消正在进行的音源解析。写操作结果未知不重放，先只读对账。

房间队列可返回 20 个 rcmdSongIds，优先作为推荐候选，没有时读取当前账号每日推荐。已只读观察到 heart 模式及动态增长的房间列表；开启/关闭、关闭恢复和权限请求仍缺证据。生成规则未确认，不能声称已复刻双方共同偏好算法，也不能把普通推荐读取当作队列替换。

独立模式只恢复本机加密记录中已验证加入的同账号同房间；没有本机归属证据的现有房间保持只读。可选 CDP 模式继续保留，无自动回退。现有证据足以实现这里列出的消息与房间 HTTP 能力，**不足以宣称完整复刻 Windows 客户端私有协议或实现私有 IM/RTC**。

固定来源：SPlayer-Next 当前 4c60335（最初迁移 e2f0ce2）；api-enhanced a8c781f；zbqbbm 一起听 MCP 224bc3d；WalterT812 桌面 MCP 1e5c2b1。客户端 3.1.40.205461 / d4d4312 与桌面 MCP 的已测构建不同，操作按本机观察重新核验。详情见 [前期验证](./validation-2026-10-03.md)、[本轮分享与跨端验证](./validation-2026-10-04.md) 和 [设计](../../docs/social/design.md)。

## 跨端与邀请的数据边界

跨端业务位于 `electron/main/services/social/crossDeviceService.ts`，使用同目录的独立 PC transport，不混入原有音乐 API 或听歌打卡协议。源列表与状态使用各自的 JSON 字符串字段；普通歌曲不新增周期进度上报。服务端明确返回 10001 时按官方快照逻辑补传一次新会话，其他失败不重放。主进程只缓存当前账号、最多 300 条远端记录和一个最多 16 KiB 的 offer，取消时全部清空。

短链生成单次请求，拒绝任意 host、带凭证或非法路径的响应；失败回退已经构造并校验的 H5。解码短链最多三次重定向、八秒，随主窗口失焦或销毁中止。成功 HTTP 响应、字段测试和双端用户体验分别列证据，不能互相替代。

协议示例和脱敏成功码见 [fixtures/iteration-2026-10-04.json](./fixtures/iteration-2026-10-04.json)。仅含合成 ID，不含账号、设备标识、Cookie 或真实房间链接。短链字段的开源参考见 [Music163Api-Go 接口定义](https://github.com/XiaoMengXinX/Music163Api-Go/blob/master/api/shortURL.go)，实际响应经本机重新验证。
