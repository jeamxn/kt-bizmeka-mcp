#!/usr/bin/env node
/*
 * Cross-platform launcher for the kt-bizmeka-mcp standalone binaries.
 *
 * Claude Code runs on Node, so `node` is always available when a plugin's MCP
 * server is spawned. This launcher does nothing but pick the correct
 * platform/arch binary (built by `bun build --compile`) and exec it with stdio
 * inherited — all the real work happens inside the self-contained Bun binary,
 * which needs no runtime installed on the target machine.
 *
 * Binary resolution order:
 *   1. dist/<binary> next to this launcher (source checkout / `bun run build`)
 *   2. a per-user cache, downloading from the GitHub Release matching this
 *      version on first run (marketplace installs with nothing pre-built)
 *
 * Env: MCP_TRANSPORT / MCP_HOST / MCP_PORT are passed through unchanged.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const { spawn } = require("node:child_process");

const REPO = "jeamxn/kt-bizmeka-mcp";
const VERSION = require("../package.json").version;

function targetName() {
  const platform = process.platform; // 'darwin' | 'linux' | 'win32'
  const arch = process.arch; // 'x64' | 'arm64'
  const map = {
    "darwin:x64": "kt-bizmeka-mcp-darwin-x64",
    "darwin:arm64": "kt-bizmeka-mcp-darwin-arm64",
    "linux:x64": "kt-bizmeka-mcp-linux-x64",
    "linux:arm64": "kt-bizmeka-mcp-linux-arm64",
    "win32:x64": "kt-bizmeka-mcp-windows-x64.exe",
  };
  const key = `${platform}:${arch}`;
  const name = map[key];
  if (!name) {
    fail(
      `지원하지 않는 플랫폼/아키텍처: ${key}. ` +
        `지원: ${Object.keys(map).join(", ")}`,
    );
  }
  return name;
}

function fail(msg) {
  process.stderr.write(`[kt-bizmeka launcher] ${msg}\n`);
  process.exit(1);
}

function localBinary(name) {
  const p = path.join(__dirname, "..", "dist", name);
  return fs.existsSync(p) ? p : null;
}

function cachePath(name) {
  const dir = path.join(
    os.homedir(),
    ".cache",
    "kt-bizmeka-mcp",
    VERSION,
  );
  return { dir, file: path.join(dir, name) };
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("too many redirects"));
    https
      .get(url, { headers: { "User-Agent": "kt-bizmeka-launcher" } }, (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          return resolve(download(res.headers.location, dest, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const tmp = dest + ".part";
        const out = fs.createWriteStream(tmp);
        res.pipe(out);
        out.on("finish", () => out.close(() => {
          fs.renameSync(tmp, dest);
          resolve(dest);
        }));
        out.on("error", reject);
      })
      .on("error", reject);
  });
}

async function resolveBinary() {
  const name = targetName();

  const local = localBinary(name);
  if (local) return local;

  const { dir, file } = cachePath(name);
  if (fs.existsSync(file)) return file;

  // Download from the GitHub Release for this version.
  fs.mkdirSync(dir, { recursive: true });
  const url = `https://github.com/${REPO}/releases/download/v${VERSION}/${name}`;
  process.stderr.write(
    `[kt-bizmeka launcher] 바이너리를 받는 중: ${url}\n`,
  );
  try {
    await download(url, file);
  } catch (e) {
    fail(
      `바이너리 다운로드 실패 (${e.message}).\n` +
        `소스 체크아웃이라면 'bun run build' 로 dist/${name} 를 만들거나,\n` +
        `릴리스(v${VERSION})에 바이너리가 올라와 있는지 확인하세요.`,
    );
  }
  if (process.platform !== "win32") {
    fs.chmodSync(file, 0o755);
  }
  return file;
}

(async () => {
  const bin = await resolveBinary();
  const child = spawn(bin, process.argv.slice(2), {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
  child.on("error", (e) => fail(`바이너리 실행 실패: ${e.message}`));
})();
