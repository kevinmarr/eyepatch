// Build Agent Bridge as a single executable (Bun runtime included) in dist/.
//   bun run build            for this computer
//   bun run build --all      for every platform Eyepatch supports
//   bun run build darwin-arm64 darwin-x64   for those platforms
//   --version 9.9.9          report that version instead of package.json's (for testing updates)
// Cross-compiling downloads Bun's runtime for each target the first time.
// The Windows build's file details (the name Task Manager shows) can only be
// set when building on Windows; elsewhere it's built without them.
import { $ } from "bun";
import path from "node:path";
import pkg from "../package.json" with { type: "json" };

const NAME = "Eyepatch Agent Bridge";

const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "linux-x64-musl", "linux-arm64-musl", "windows-x64"];
const here = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const args = process.argv.slice(2);
const versionAt = args.indexOf("--version");
const version = versionAt >= 0 ? args.splice(versionAt, 2)[1] : null;
const named = args.filter((a) => !a.startsWith("--"));
for (const t of named) if (!TARGETS.includes(t)) throw new Error(`unknown target ${t}; one of ${TARGETS.join(", ")}`);
const targets = process.argv.includes("--all") ? TARGETS : named.length ? named : [here];
const root = path.resolve(import.meta.dir, "..");

for (const target of targets) {
  const windows = target.startsWith("windows");
  const out = path.join(root, "dist", target, windows ? "eyepatch-agent-bridge.exe" : "eyepatch-agent-bridge");
  console.log(`building ${path.relative(root, out)}`);
  const defines = ["--define", `BUILD_TARGET=${JSON.stringify(target)}`, ...(version ? ["--define", `BUILD_VERSION=${JSON.stringify(version)}`] : [])];
  let details: string[] = [];
  if (windows && process.platform === "win32") {
    const v = (version ?? pkg.version).split("-")[0];
    details = ["--windows-title", NAME, "--windows-description", NAME, "--windows-publisher", "Kevin Marr", "--windows-version", `${v}.0`, "--windows-copyright", "Copyright (c) 2026 Kevin Marr"];
  } else if (windows) {
    console.log("  (without Windows file details: those need building on Windows)");
  }
  await $`bun build ${path.join(root, "src/main.ts")} --compile --minify --sourcemap --target=bun-${target} ${defines} ${details} --outfile ${out}`.quiet();
}
