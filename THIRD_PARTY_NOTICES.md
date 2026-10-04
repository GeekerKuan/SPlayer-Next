# 本次新增模块的第三方参考

SPlayer-Next 的 AGPL-3.0 许可保留在 LICENSE。已有依赖声明及其许可不因本文件改变。

新社交通道的 eapi 加密格式、私信 endpoint/参数参考 SPlayer-Next 和 NeteaseCloudMusicApiEnhanced/api-enhanced（a8c781f）。api-enhanced 的 MIT 许可如下。一起听设计参考 zbqbbm/netease-listen-together-mcp（224bc3d，MIT），没有复制其 server.py。UI 仅参考 tacel-chat、nim-uikit-electron、Hyk260/PureChat 的组件职责，没有引入其代码或 SDK。QListenTogether、cmhook 仅用于研究。

来源：[api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)，[一起听 MCP](https://github.com/zbqbbm/netease-listen-together-mcp)。

The MIT License (MIT)

Copyright (c) 2013-2022 Binaryify

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

## Windows CDP 参考与改编

端口归属检查、页面识别思路与 scripts/social/Inspect-CloudMusic.ps1 参考/改编自 [WalterT812/netease-desktop-mcp](https://github.com/WalterT812/netease-desktop-mcp)，固定版本 1e5c2b1。未引入其 MCP 服务依赖，房间 action 白名单根据本机客户端观察独立编写。上游许可如下：

MIT License

Copyright (c) 2026 Walter Tang and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## 分享短链接口参考

`/api/middle/shorturl/generate` 的路径及 url 字段参考 [XiaoMengXinX/Music163Api-Go 的 shortURL.go](https://github.com/XiaoMengXinX/Music163Api-Go/blob/master/api/shortURL.go)，再经本机官方 Windows wrapper 和独立 PC eapi 核验。仅参考协议字段，没有复制其 Go 实现或引入依赖。
