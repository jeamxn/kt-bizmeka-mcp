#!/usr/bin/env python3
"""Package per-platform Claude Code plugin zips.

Each zip contains, at its root:
  kt-bizmeka-mcp[.exe]          the standalone binary for that OS/arch
  .claude-plugin/plugin.json    manifest whose local server execs that binary
  .claude-plugin/marketplace.json
  README.md  LICENSE

Because the zip is platform-specific, plugin.json points `command` straight at
the bundled binary (no node launcher, no OS branching at runtime).

Uses Python's stdlib zipfile so there's no dependency on a `zip` binary, and it
preserves the executable permission bit on the binary (mode 0o755) so the
unzipped file is runnable on macOS/Linux.

Usage: scripts/package.py [version-tag]   e.g. scripts/package.py v0.2.0
"""
from __future__ import annotations

import json
import os
import stat
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
OUT = ROOT / "release"

# platform key -> built binary filename in dist/
PLATFORMS = {
    "darwin-arm64": "kt-bizmeka-mcp-darwin-arm64",
    "darwin-x64": "kt-bizmeka-mcp-darwin-x64",
    "linux-x64": "kt-bizmeka-mcp-linux-x64",
    "linux-arm64": "kt-bizmeka-mcp-linux-arm64",
    "windows-x64": "kt-bizmeka-mcp-windows-x64.exe",
}


def version_from_pkg() -> str:
    pkg = json.loads((ROOT / "package.json").read_text())
    return pkg["version"]


def plugin_json(version: str, plat: str, cmd: str, build: str) -> str:
    obj = {
        "name": "kt-bizmeka",
        "version": version,
        "description": (
            "KT 비즈메카 EZ 자동화 — RSA 로그인/SMS 2차인증/SAML SSO + 웹메일. "
            f"Bun standalone 바이너리 ({plat}, build {build})."
        ),
        "author": {"name": "jeamxn"},
        "homepage": "https://github.com/jeamxn/kt-bizmeka-mcp",
        "repository": "https://github.com/jeamxn/kt-bizmeka-mcp",
        "license": "MIT",
        "keywords": ["bizmeka", "kt", "webmail", "saml", "korea"],
        "mcpServers": {
            "kt-bizmeka-local": {
                "command": cmd,
                "env": {"MCP_TRANSPORT": "stdio"},
            },
        },
    }
    return json.dumps(obj, ensure_ascii=False, indent=2) + "\n"


def add_file(zf: zipfile.ZipFile, arcname: str, data: bytes, *, executable: bool = False) -> None:
    zi = zipfile.ZipInfo(arcname)
    zi.compress_type = zipfile.ZIP_DEFLATED
    # rw-r--r-- (0644) or rwxr-xr-x (0755), encoded in the high bits
    mode = 0o755 if executable else 0o644
    zi.external_attr = (stat.S_IFREG | mode) << 16
    zf.writestr(zi, data)


def main() -> int:
    # The optional arg is the build tag (e.g. v20260630-1206 from CI). The
    # plugin.json `version` stays a real semver from package.json so the Claude
    # Code plugin manifest validates; the calendar build tag goes in the
    # description and is what the zips/release are named after.
    build_tag = sys.argv[1] if len(sys.argv) > 1 else f"v{version_from_pkg()}"
    build = build_tag[1:] if build_tag.startswith("v") else build_tag
    version = version_from_pkg()

    OUT.mkdir(exist_ok=True)
    marketplace = (ROOT / ".claude-plugin" / "marketplace.json").read_bytes()
    readme = (ROOT / "README.md").read_bytes() if (ROOT / "README.md").exists() else b""
    license_txt = (ROOT / "LICENSE").read_bytes() if (ROOT / "LICENSE").exists() else b""

    missing = [b for b in PLATFORMS.values() if not (DIST / b).exists()]
    if missing:
        print(
            "!! missing binaries: " + ", ".join(missing) +
            "\n   run 'bun run scripts/build.ts' first",
            file=sys.stderr,
        )
        return 1

    made = []
    for plat, binfile in PLATFORMS.items():
        is_win = plat.startswith("windows-")
        binname = "kt-bizmeka-mcp.exe" if is_win else "kt-bizmeka-mcp"
        cmd = "${CLAUDE_PLUGIN_ROOT}/" + binname

        zip_path = OUT / f"kt-bizmeka-plugin-{plat}.zip"
        if zip_path.exists():
            zip_path.unlink()

        bin_data = (DIST / binfile).read_bytes()
        with zipfile.ZipFile(zip_path, "w") as zf:
            add_file(zf, binname, bin_data, executable=not is_win)
            add_file(zf, ".claude-plugin/plugin.json",
                     plugin_json(version, plat, cmd, build).encode("utf-8"))
            add_file(zf, ".claude-plugin/marketplace.json", marketplace)
            if readme:
                add_file(zf, "README.md", readme)
            if license_txt:
                add_file(zf, "LICENSE", license_txt)
        made.append(zip_path.name)
        print(f"packaged {zip_path.relative_to(ROOT)}")

    print("done ->", OUT.relative_to(ROOT))
    for n in sorted(made):
        print(" ", n)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
