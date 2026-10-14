// An auditable development package from the staged checkout, not a public release.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { goBuildEnvironment } from "./app-package-targets.mjs";
import { tarExecutable } from "./archive-tool.mjs";
import { writeServerLicenseNotices } from "./package-licenses.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = (command, args, cwd = root, env = process.env) =>
  execFileSync(command, args, { cwd, env, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
run("git", ["diff", "--quiet"]);
assert.equal(run("git", ["ls-files", "--others", "--exclude-standard"]).toString().trim(),
  "", "Stage all non-ignored new files before packaging");
const head = run("git", ["rev-parse", "HEAD"]).toString().trim();
const patch = run("git", ["diff", "--cached", "--binary", "HEAD"]);
const patchHash = digest(patch);
const revision = `development-${head.slice(0, 12)}-${patchHash.slice(0, 12)}`;
const createdAt = new Date().toISOString();
const output = join(root, "build", "multi-screen-docker", createdAt.replace(/[-:.]/g, ""));
mkdirSync(output, { recursive: true });
console.log("Building the current Browser assets...");
const webEnvironment = { ...process.env, VITE_PIIK_VERSION: "development", VITE_PIIK_REVISION: revision };
if (process.platform === "win32") {
  run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm run build:web"], root, webEnvironment);
} else {
  run("npm", ["run", "build:web"], root, webEnvironment);
}

const archiveSums = [];
for (const [goarch, machine] of [["amd64", 62], ["arm64", 183]]) {
  console.log(`Building and verifying Linux ${goarch}...`);
  const name = `piik-multi-screen-linux-${goarch}-dev`;
  const directory = join(output, name);
  mkdirSync(directory);
  const binary = join(directory, "piik-server");
  const target = { goos: "linux", goarch };
  run("go", ["build", "-p", "2", "-trimpath", "-buildvcs=false", "-ldflags",
    `-s -w -X main.BuildRevision=${revision}`, "-o", binary, "./cmd/piik-server"],
    root, goBuildEnvironment(target));
  const elf = readFileSync(binary);
  assert.equal(elf.subarray(0, 4).toString("hex"), "7f454c46");
  assert.equal(elf[4], 2, "64-bit ELF required");
  assert.equal(elf[5], 1, "little-endian ELF required");
  assert.equal(elf.readUInt16LE(18), machine, "incorrect target architecture");
  const programHeaders = Number(elf.readBigUInt64LE(32));
  for (let index = 0; index < elf.readUInt16LE(56); index++) {
    const type = elf.readUInt32LE(programHeaders + index * elf.readUInt16LE(54));
    assert.ok(type !== 2 && type !== 3, "distroless requires a static binary without a dynamic loader");
  }
  assert.match(run("go", ["version", "-m", binary]).toString(), /CGO_ENABLED=0/);
  copyFileSync(join(root, "LICENSE"), join(directory, "LICENSE"));
  copyFileSync(join(root, "deploy", "container", "Dockerfile"), join(directory, "Dockerfile"));
  const templates = ["compose.yaml", ".env.example", "nginx.conf.example", "README.zh-CN.md"];
  for (const file of templates) copyFileSync(join(root, "deploy", "multi-screen", file), join(directory, file));
  writeServerLicenseNotices(root, join(directory, "THIRD-PARTY-NOTICES.txt"), "go", target);
  writeFileSync(join(directory, "REVISION"), revision + "\n");
  writeFileSync(join(directory, "worktree.patch"), patch);
  writeFileSync(join(directory, ".dockerignore"),
    "*\n!Dockerfile\n!piik-server\n!LICENSE\n!THIRD-PARTY-NOTICES.txt\n!REVISION\n");
  const inputs = ["piik-server", "LICENSE", "Dockerfile", ...templates,
    "THIRD-PARTY-NOTICES.txt", "REVISION", "worktree.patch", ".dockerignore"].sort();
  const files = inputs.map(path => {
    const bytes = readFileSync(join(directory, path));
    return { path, size: bytes.length, sha256: digest(bytes) };
  });
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({
    kind: "multi-screen-development", createdAt, revision, goos: "linux", goarch,
    source: { head, stagedPatchSha256: patchHash, dirty: patch.length > 0 }, files,
  }, null, 2) + "\n");
  const checksummed = [...inputs, "manifest.json"].sort();
  writeFileSync(join(directory, "SHA256SUMS"), checksummed.map(file =>
    `${digest(readFileSync(join(directory, file)))}  ${file}\n`).join(""));
  const entries = [...checksummed, "SHA256SUMS"].sort();
  const archive = `${name}.tar.gz`;
  run(tarExecutable(), ["-czf", join(output, archive), "-C", output, "--",
    ...entries.map(file => `${name}/${file}`)]);
  const listed = run(tarExecutable(), ["-tzf", join(output, archive)]).toString()
    .trim().split(/\r?\n/).sort();
  assert.deepEqual(listed, entries.map(file => `${name}/${file}`).sort());
  const verified = join(output, `verified-${goarch}`);
  mkdirSync(verified);
  run(tarExecutable(), ["-xzf", join(output, archive), "-C", verified]);
  for (const file of entries) {
    assert.equal(digest(readFileSync(join(verified, name, file))),
      digest(readFileSync(join(directory, file))), `archive corruption: ${file}`);
  }
  archiveSums.push(`${digest(readFileSync(join(output, archive)))}  ${archive}\n`);
  console.log(`Verified: ${join(output, archive)}`);
}
// Fail if tracked inputs changed during packaging; retain the evidence for inspection.
run("git", ["diff", "--quiet"]);
assert.equal(run("git", ["ls-files", "--others", "--exclude-standard"]).toString().trim(), "");
assert.equal(digest(run("git", ["diff", "--cached", "--binary", "HEAD"])), patchHash);
assert.equal(run("git", ["rev-parse", "HEAD"]).toString().trim(), head);
writeFileSync(join(output, "SHA256SUMS"), archiveSums.join(""));
console.log(`Development deployment packages: ${output}`);
