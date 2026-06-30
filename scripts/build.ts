/**
 * Cross-compile standalone executables for every supported platform via
 * `bun build --compile`. The resulting binaries embed the Bun runtime, so the
 * target machine needs nothing installed (no node, no bun, no python).
 *
 *   bun run scripts/build.ts            # all targets
 *   bun run scripts/build.ts current    # only the host platform
 */

import { $ } from "bun";

interface Target {
  /** bun --target value */
  bunTarget: string;
  /** output filename under dist/ */
  outfile: string;
}

const TARGETS: Target[] = [
  { bunTarget: "bun-linux-x64", outfile: "kt-bizmeka-mcp-linux-x64" },
  { bunTarget: "bun-linux-arm64", outfile: "kt-bizmeka-mcp-linux-arm64" },
  { bunTarget: "bun-darwin-x64", outfile: "kt-bizmeka-mcp-darwin-x64" },
  { bunTarget: "bun-darwin-arm64", outfile: "kt-bizmeka-mcp-darwin-arm64" },
  { bunTarget: "bun-windows-x64", outfile: "kt-bizmeka-mcp-windows-x64.exe" },
];

const ENTRY = "src/server.ts";
const OUTDIR = "dist";

async function build(t: Target) {
  const out = `${OUTDIR}/${t.outfile}`;
  process.stderr.write(`\n=== building ${t.bunTarget} -> ${out} ===\n`);
  await $`bun build ${ENTRY} --compile --minify --sourcemap=none --target=${t.bunTarget} --outfile ${out}`;
}

const arg = process.argv[2];

if (arg === "current") {
  // Let bun pick the host target automatically.
  const out = `${OUTDIR}/kt-bizmeka-mcp`;
  await $`bun build ${ENTRY} --compile --minify --outfile ${out}`;
  process.stderr.write(`built host binary -> ${out}\n`);
} else {
  for (const t of TARGETS) {
    await build(t);
  }
  process.stderr.write("\nAll targets built into dist/.\n");
}
