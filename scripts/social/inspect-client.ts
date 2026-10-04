import { connectDesktopCdp } from "./desktopCdp";

const port = Number(process.argv[2] || 9229);
const executable = process.argv[3];
if (!executable)
  throw new Error("用法：tsx scripts/social/inspect-client.ts <端口> <cloudmusic.exe 完整路径>");
connectDesktopCdp(port, executable)
  .then(({ cdp, metadata }) => {
    process.stdout.write(JSON.stringify(metadata, null, 2) + "\n");
    cdp.close();
  })
  .catch(() => {
    process.stderr.write("客户端未就绪：检查端口、进程归属与界面兼容性。\n");
    process.exitCode = 1;
  });
