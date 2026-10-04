# 用 GitHub Actions 构建 Mac 版本

GitHub Actions 使用云端 Mac 编译，Windows 开发电脑不需要安装 macOS。Intel 和 Apple Silicon 分别构建；runner 选择参考 [GitHub 官方 runner 文档](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。

## 本项目的分支安排

目标仓库为 [GeekerKuan/SPlayer-Next](https://github.com/GeekerKuan/SPlayer-Next)。`dev` 默认分支注册 `.github/workflows/build-macos.yml`，修改后的源码位于 `social-together` 分支。工作流输入 `source_ref` 默认指向这个分支，可改为明确的标签或 commit。整个源码和脚本必须存在于选定分支；单独上传 YAML 不会把本地修改自动带入构建。

工作流只有手动触发，没有提交即构建的触发器。源码分支不是上游自动构建所用的 `dev` 分支，从而避免提前编译 Windows 安装器和重复消耗构建时间。

## 操作步骤

1. 登录 GitHub，打开目标仓库，进入 **Actions**。如果 Fork 的工作流尚未启用，先启用该仓库的 Actions。
2. 在左侧选择 **Build macOS installers**，点击 **Run workflow**。
3. 保留工作流分支 `dev`，`source_ref` 填 `social-together`。这是选择实际构建源码的输入，不是要求本地改分支。
4. 首次保持 **package_installers** 未勾选。会执行测试、类型检查、原生编译、应用打包，以及打包后 Electron、原生库和 SQLite 检查；不会生成安装包。
5. 功能验收完成后，再运行一次并勾选 **package_installers**。完成后打开此次运行，按自己的 Mac 架构下载 **Artifacts** 中的 `SPlayer-Next-macos-x64` 或 `SPlayer-Next-macos-arm64`，其中包含 DMG、ZIP 和 SHA-256 清单。产物保留 14 天，参见 [GitHub 官方下载说明](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)。

无需在聊天中提供密码或 Token。当前工作流不需要网易云登录态、Cookie、测试账号或抓包，也不将安装包发布到官方 Releases。

## 检查范围与失败处理

两个 runner 从选定源码分别编译 Rust 模块；`verify-packaged.cjs` 用包内 Electron 的 Node 模式检查原生库可加载，并使用内存 SQLite，不读取用户数据或打开播放器。任意架构失败不会取消另一架构；失败在对应步骤日志中查看。只有完整检查成功才上传安装包，不能用旧产物代替失败的新版本。

当前包未经过 Developer ID 签名和公证。云端构建成功不能替代 Mac 上的播放、系统通知、权限、快捷键、一起听和保数据升级实测。最终源码状态见 [剩余工作计划](./remaining-work.md)。
