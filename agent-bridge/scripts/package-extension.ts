// Zip the extension for the Chrome Web Store, into dist/eyepatch-<version>.zip.
//   bun run package:extension                  an update
//   bun run package:extension --key key.pem    the first upload
//
// Leaves out the demo and design-gallery files and the manifest's "key"
// (the store rejects it). For the first upload, --key adds the extension's
// private key as key.pem at the zip's root, so the store keeps the ID that
// manifest.json's key gives (and Agent Bridge's native messaging manifest
// allows). Refuses to package an extension whose BRIDGE_VERSION has no GitHub
// release yet, since its users' Agent Bridge updates would fail.
import { $ } from "bun";
import fs from "node:fs";
import path from "node:path";
import { RELEASES } from "../src/update.ts";

const root = path.resolve(import.meta.dir, "../..");
const ext = path.join(root, "extension");
const DEV_ONLY = ["design.html", "design.js", "demo-chat.js", "demo-settings.js"];

const args = process.argv.slice(2);
const keyAt = args.indexOf("--key");
const keyFile = keyAt >= 0 ? path.resolve(args[keyAt + 1] ?? "") : null;
if (keyFile && !fs.existsSync(keyFile)) throw new Error(`No key at ${keyFile}`);

const manifest = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
const bridgeVersion = /const BRIDGE_VERSION = "([^"]+)"/.exec(fs.readFileSync(path.join(ext, "background.js"), "utf8"))?.[1];
if (!bridgeVersion) throw new Error("No BRIDGE_VERSION in extension/background.js");

if (!args.includes("--skip-release-check")) {
  const url = `${RELEASES}/v${bridgeVersion}/SHA256SUMS`;
  const res = await fetch(url, { method: "HEAD" });
  if (!res.ok) {
    console.error(`Agent Bridge ${bridgeVersion} (BRIDGE_VERSION) has no release yet: ${url} is HTTP ${res.status}.`);
    console.error(`Publish it first (git tag v${bridgeVersion} && git push origin v${bridgeVersion}), or pass --skip-release-check.`);
    process.exit(1);
  }
}

const stage = fs.mkdtempSync(path.join(root, "agent-bridge", "dist", ".package-"));
try {
  fs.cpSync(ext, stage, { recursive: true, filter: (src) => !DEV_ONLY.includes(path.relative(ext, src)) && !path.basename(src).startsWith(".") });
  delete manifest.key;
  fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  if (keyFile) fs.copyFileSync(keyFile, path.join(stage, "key.pem"));

  // Nothing left should point at what was left out.
  for (const file of fs.readdirSync(stage).filter((f) => /\.(html|js)$/.test(f))) {
    const text = fs.readFileSync(path.join(stage, file), "utf8");
    for (const gone of DEV_ONLY) {
      const ref = new RegExp(`["'/]${gone.replace(".", "\\.")}["']`);
      if (ref.test(text) && !/DEMO \? await import/.test(text.split("\n").find((l) => ref.test(l)) ?? "")) {
        throw new Error(`${file} refers to ${gone}, which isn't packaged`);
      }
    }
  }

  const out = path.join(root, "agent-bridge", "dist", `eyepatch-${manifest.version}${keyFile ? "-first-upload" : ""}.zip`);
  fs.rmSync(out, { force: true });
  await $`zip -q -r -X ${out} .`.cwd(stage);
  console.log(`${path.relative(root, out)}: Eyepatch ${manifest.version}, talks to Agent Bridge ${bridgeVersion}${keyFile ? ", with key.pem (first upload only)" : ""}`);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
