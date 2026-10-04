# Windows 与 macOS 测试安装包

根据最新要求，先构建当前源码的测试安装包；其余协议与功能任务继续保留，不将成功打包视为全部需求完成。

进入 [GitHub Actions](https://github.com/GeekerKuan/SPlayer-Next/actions)，打开 **Build social desktop installers** 的本轮记录。成功的平台产物在页面底部 **Artifacts** 中，保留 14 天：

| 产物                        | 用途                                                         |
| --------------------------- | ------------------------------------------------------------ |
| `SPlayer-Next-win32-x64`    | Windows x64；覆盖升级使用 `*-setup.exe`，portable 为便携版本 |
| `SPlayer-Next-darwin-x64`   | Intel Mac 的 DMG/ZIP                                         |
| `SPlayer-Next-darwin-arm64` | Apple Silicon Mac 的 DMG/ZIP                                 |

每份产物包含 `SHA256SUMS.txt` 和 `BUILDINFO.json`，记录源码 commit、版本、平台和架构。流程先运行测试，再按各平台编译 Rust/SQLite 和安装器，并使用打包后的 Electron 检查原生库与 SQLite ABI。应用身份、NSIS GUID、产品名和用户数据目录使用原配置。安装包未签名，Mac 未公证；真实保数据覆盖升级和双端功能由用户验收。

工作流更新推送至 `social-together` 时自动构建，普通源码提交不会自动打包。之后也可手动运行，`source_ref` 填 `social-together` 或已验证的 commit。仅上传 Actions 产物，不创建 Release 或向官方上游发布。

当前修复说明见 [退出、续播与邀请预览](./lifecycle-relay-invites.md)。下载时核对 BUILDINFO.json 的源码提交；前一轮成功产物不包含后续修复。
