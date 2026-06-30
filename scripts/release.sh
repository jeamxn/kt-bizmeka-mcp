#!/usr/bin/env bash
# Local release helper: build all platform binaries, package per-platform plugin
# zips, and publish binaries + zips to a GitHub Release under a calendar tag
# vYYYYMMDD-HHMM (KST) — same scheme CI uses on every push to main.
#
# CI does this automatically (see .github/workflows/release.yml); this script is
# for cutting a release by hand from a local checkout.
#
# Requires: bun, python3, gh (authenticated).
set -euo pipefail

cd "$(dirname "$0")/.."

TAG="$(TZ=Asia/Seoul date +'v%Y%m%d-%H%M')"

echo "==> building all targets for ${TAG}"
bun run scripts/build.ts

echo "==> packaging per-platform plugin zips"
python3 scripts/package.py "${TAG}"

ASSETS=(
  release/kt-bizmeka-plugin-darwin-arm64.zip
  release/kt-bizmeka-plugin-darwin-x64.zip
  release/kt-bizmeka-plugin-linux-x64.zip
  release/kt-bizmeka-plugin-linux-arm64.zip
  release/kt-bizmeka-plugin-windows-x64.zip
)

echo "==> creating/uploading release ${TAG}"
if gh release view "${TAG}" >/dev/null 2>&1; then
  gh release upload "${TAG}" "${ASSETS[@]}" --clobber
else
  gh release create "${TAG}" "${ASSETS[@]}" \
    --title "${TAG}" \
    --generate-notes
fi

echo "==> done. Assets:"
gh release view "${TAG}" --json assets --jq '.assets[].name'
