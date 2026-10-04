# 弃用项目复用记录

源聊天：`01a0a0ef-24bf-7bb0-9643-a9ee013f947c`，原工作区 `2026-09-15/splayer-next-x20`。

复用的 Git 基线为 `e2f0ce2261299e599a544f4f332336b258980346`。复制源码 checkout 后应用旧交付的网易云播放同步补丁，保留 NCBL 开始/结束日志、15 秒播放状态同步、自然结束/中断、退出冲刷及原测试。旧功能仍位于原项目音乐网络目录，与新社交通道完全分开。

继续参考旧 `api-enhanced` checkout 的 `a8c781fd64faab17fedfd46e0615a2609307f163`，没有将其完整源码或服务器依赖并入本项目。旧账号库仅在内存中提供本人会话；用户授权的单次私信、接受邀请与独立房间联调使用仓库外 QA profile，不属于源码复用或交付。

未迁移：已安装 app.asar 的解包副本、旧打包产物、smoke/auth profile、账号数据库、日志、截图和缓存。旧安装目录和备份未修改。当前交付压缩包只包含 Git 源码与新文档，不包含 node_modules、native 二进制和账号数据。

清理原则：保留旧项目的唯一原始补丁/说明和本机安装备份；已被当前源码替代的临时 checkout、解包与构建文件可删除，但先核验路径在已弃用工作区内，并排除账号 profile 与跨目录链接。

开发依赖已从旧 repo/node_modules 移到当前源码目录，当前不再通过旧仓库的 junction 访问依赖。迁移前核验 2480 个包管理器链接均为相对链接，移动后类型检查、测试和构建通过。旧的临时链接移到当前 work/retired-dependency-link，未递归删除链接目标。原始未提交补丁另保存在交付根目录 reused-project-changes.patch。

旧产物清理只允许旧 work 下 repo/out（6.4 MiB）、repo/dist（339.9 MiB）、installed-asar-v1（20.1 MiB），本轮已删除，共约 366 MiB。交付根目录 Cleanup-AbandonedProject.ps1 默认预览，-Apply 才删除；检查当前源码/原补丁、绝对路径和所有目录链接，重复运行会显示目录已不存在。完整旧 checkout、verify-patch 工作树、参考源码、auth/smoke profile、安装目录和备份暂时保留，不能整目录一并删除。
