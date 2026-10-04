const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/** 在打包后的 Electron Node 模式中检查实际原生库与数据库 ABI，不启动音频或读取用户数据。 */
const [resourcesDir, architecture, platform] = process.argv.slice(2);
assert.ok(resourcesDir && architecture && platform, "需要资源目录、目标架构和平台");
assert.ok(process.versions.electron, "必须使用打包后的 Electron 运行检查");
assert.equal(process.arch, architecture, "Electron 架构与构建目标不一致");
assert.equal(process.platform, platform, "Electron 平台与构建目标不一致");
const resources = path.resolve(resourcesDir);
const archive = path.join(resources, "app.asar");
const pkg = require(path.join(archive, "package.json"));
assert.equal(pkg.productName, "SPlayer-Next");
assert.equal(pkg.license, "AGPL-3.0");
assert.ok(fs.existsSync(path.join(archive, pkg.main)), "缺少应用主进程入口");

const nativeDir = path.join(resources, "native");
const files = fs.readdirSync(nativeDir).filter((name) => name.endsWith(".node"));
for (const moduleName of ["audio-engine", "media-ctrl", "opencc"]) {
  assert.ok(files.includes(`${moduleName}.node`), `缺少 ${moduleName} 原生库`);
}
for (const file of files) {
  const module = require(path.join(nativeDir, file));
  assert.ok(Object.keys(module).length > 0, `${file} 原生库没有导出接口`);
}

const Database = require(path.join(archive, "node_modules/better-sqlite3"));
const db = new Database(":memory:");
try {
  assert.equal(db.prepare("select 1 as ok").get().ok, 1);
} finally {
  db.close();
}
console.log(
  JSON.stringify({
    platform,
    architecture,
    version: pkg.version,
    nativeModules: files.length,
    sqlite: true,
  }),
);
