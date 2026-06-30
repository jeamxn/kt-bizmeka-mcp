#!/usr/bin/env bash
# Build all platform binaries and publish them to a GitHub Release whose tag
# matches the package.json version (v<version>). The plugin launcher downloads
# from exactly this release on first run.
#
# Requires: bun, gh (authenticated).
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"

echo "==> building all targets for ${TAG}"
bun run scripts/build.ts

echo "==> creating/uploading release ${TAG}"
if gh release view "${TAG}" >/dev/null 2>&1; then
  gh release upload "${TAG}" dist/kt-bizmeka-mcp-* --clobber
else
  gh release create "${TAG}" dist/kt-bizmeka-mcp-* \
    --title "${TAG}" \
    --notes "kt-bizmeka-mcp ${TAG} — standalone binaries (mac/linux/windows)."
fi

echo "==> done. Assets:"
gh release view "${TAG}" --json assets --jq '.assets[].name'
