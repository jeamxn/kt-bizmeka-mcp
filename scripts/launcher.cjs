#!/usr/bin/env node
/*
 * Cross-platform launcher for the kt-bizmeka-mcp standalone binary.
 *
 * Claude Code runs on Node, so `node` is always available when a plugin's MCP
 * server is spawned. This launcher picks the correct platform/arch binary
 * (built by `bun build --compile`) and execs it with stdio inherited — all the
 * real work happens inside the self-contained Bun binary, which needs no
 * runtime installed on the target machine.
 *
 * Binary resolution order:
 *   1. dist/<binary> next to this launcher (source checkout / `bun run build`)
 *   2. a per-user cache, populated on first run by downloading the per-platform
 *      plugin zip from the latest GitHub Release and extracting the binary out
 *      of it (releases ship ONLY the kt-bizmeka-plugin-<plat>.zip bundles).
 *
 * Env: MCP_TRANSPORT / MCP_HOST / MCP_PORT are passed through unchanged.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const zlib = require("node:zlib");
const { spawn } = require("node:child_process");

const REPO = "jeamxn/kt-bizmeka-mcp";
const VERSION = require("../package.json").version;

// platform:arch -> { plat: release zip suffix, distBin: dist/ filename, binName: name inside zip }
function target() {
  const map = {
    "darwin:x64": { plat: "darwin-x64", distBin: "kt-bizmeka-mcp-darwin-x64", binName: "kt-bizmeka-mcp" },
    "darwin:arm64": { plat: "darwin-arm64", distBin: "kt-bizmeka-mcp-darwin-arm64", binName: "kt-bizmeka-mcp" },
    "linux:x64": { plat: "linux-x64", distBin: "kt-bizmeka-mcp-linux-x64", binName: "kt-bizmeka-mcp" },
    "linux:arm64": { plat: "linux-arm64", distBin: "kt-bizmeka-mcp-linux-arm64", binName: "kt-bizmeka-mcp" },
    "win32:x64": { plat: "windows-x64", distBin: "kt-bizmeka-mcp-windows-x64.exe", binName: "kt-bizmeka-mcp.exe" },
  };
  const key = `${process.platform}:${process.arch}`;
  const t = map[key];
  if (!t) {
    fail(`지원하지 않는 플랫폼/아키텍처: ${key}. 지원: ${Object.keys(map).join(", ")}`);
  }
  return t;
}

function fail(msg) {
  process.stderr.write(`[kt-bizmeka launcher] ${msg}\n`);
  process.exit(1);
}

function localBinary(distBin) {
  const p = path.join(__dirname, "..", "dist", distBin);
  return fs.existsSync(p) ? p : null;
}

function cacheDir() {
  // Cache under the package semver; bump package.json version to invalidate.
  return path.join(os.homedir(), ".cache", "kt-bizmeka-mcp", VERSION);
}

function downloadToBuffer(url, redirects = 0) {
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
          return resolve(downloadToBuffer(res.headers.location, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

/**
 * Extract one file by name from an in-memory zip buffer. Reads the End Of
 * Central Directory record, walks the central directory to find the entry,
 * then inflates (or copies) its data from the local file header. Handles the
 * STORE (0) and DEFLATE (8) methods — which is all `python zipfile` emits.
 */
function extractFromZip(buf, wantName) {
  const EOCD_SIG = 0x06054b50;
  // EOCD is at the end; scan backwards (min 22 bytes, up to 64KB comment).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip: EOCD not found");

  const cdCount = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16); // central directory offset

  const CEN_SIG = 0x02014b50;
  for (let n = 0; n < cdCount; n++) {
    if (buf.readUInt32LE(off) !== CEN_SIG) throw new Error("zip: bad central dir entry");
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const fnLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + fnLen);

    if (name === wantName) {
      // Jump to the local file header to find where the data actually starts.
      const LOC_SIG = 0x04034b50;
      if (buf.readUInt32LE(localOff) !== LOC_SIG) throw new Error("zip: bad local header");
      const lFnLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lFnLen + lExtraLen;
      const data = buf.subarray(dataStart, dataStart + compSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`zip: unsupported compression method ${method}`);
    }
    off += 46 + fnLen + extraLen + commentLen;
  }
  throw new Error(`zip: entry not found: ${wantName}`);
}

async function resolveBinary() {
  const t = target();

  const local = localBinary(t.distBin);
  if (local) return local;

  const dir = cacheDir();
  const file = path.join(dir, t.binName);
  if (fs.existsSync(file)) return file;

  // Download the per-platform plugin zip from the latest release and extract
  // the binary out of it. `releases/latest/download/<asset>` redirects to the
  // newest release, so we don't need to know the exact calendar tag.
  const asset = `kt-bizmeka-plugin-${t.plat}.zip`;
  const url = `https://github.com/${REPO}/releases/latest/download/${asset}`;
  process.stderr.write(`[kt-bizmeka launcher] 플러그인 zip을 받는 중: ${url}\n`);

  let bin;
  try {
    const zipBuf = await downloadToBuffer(url);
    bin = extractFromZip(zipBuf, t.binName);
  } catch (e) {
    fail(
      `바이너리 준비 실패 (${e.message}).\n` +
        `소스 체크아웃이라면 'bun run build' 로 dist/${t.distBin} 를 만들거나,\n` +
        `최신 릴리스에 ${asset} 가 올라와 있는지 확인하세요.`,
    );
  }

  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + ".part";
  fs.writeFileSync(tmp, bin);
  if (process.platform !== "win32") fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, file);
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
