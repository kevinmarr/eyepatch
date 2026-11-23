// Build Agent Bridge as a single executable (Bun runtime included) in dist/.
//   bun run build            for this computer
//   bun run build --all      for every platform Eyepatch supports
//   bun run build darwin-arm64 darwin-x64   for those platforms
//   --version 9.9.9          report that version instead of package.json's (for testing updates)
// Cross-compiling downloads Bun's runtime for each target the first time.
import { $ } from "bun";
import path from "node:path";

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
  const out = path.join(root, "dist", target, target.startsWith("windows") ? "agent-bridge.exe" : "agent-bridge");
  console.log(`building ${path.relative(root, out)}`);
  await $`bun build ${path.join(root, "src/main.ts")} --compile --minify --sourcemap --target=bun-${target} --define ${`BUILD_TARGET=${JSON.stringify(target)}`} ${version ? ["--define", `BUILD_VERSION=${JSON.stringify(version)}`] : []} --outfile ${out}`.quiet();
}
