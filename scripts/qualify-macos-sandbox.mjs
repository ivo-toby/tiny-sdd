import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildMacosSandboxProfile } from "../src/macos-sandbox.mjs";

if (process.platform !== "darwin") throw new Error("This qualification requires real macOS Seatbelt");

const fixture = await mkdtemp(join(await realpath(tmpdir()), "tinysdd-seatbelt-qualification-"));
const workspace = join(fixture, "candidate");
const stateDir = join(fixture, "state");
const sourceRoot = join(fixture, "source");
const sourceAgentDir = join(fixture, "home", ".pi", "agent");
const piRoot = join(fixture, "installed-pi");
const piExecutable = join(piRoot, "pi.mjs");
const sshFile = join(fixture, "home", ".ssh", "id_fixture");
const outsideFile = join(fixture, "outside.txt");
const profilePath = join(fixture, "sandbox.sb");

try {
  for (const path of [workspace, stateDir, sourceRoot, sourceAgentDir, piRoot, join(fixture, "home", ".ssh"), join(stateDir, "home"), join(stateDir, "tmp")]) await mkdir(path, { recursive: true, mode: 0o700 });
  for (const path of [join(workspace, "allowed.txt"), join(sourceRoot, "source.txt"), join(sourceAgentDir, "auth.json"), piExecutable, sshFile, outsideFile]) await writeFile(path, "synthetic fixture\n", { mode: 0o600 });
  await symlink(join(sourceRoot, "source.txt"), join(workspace, "source-link"));
  await symlink(sshFile, join(workspace, "home-link"));
  const profile = buildMacosSandboxProfile({ workspace, stateDir, sourceRoot, sourceAgentDir, nodeExecutable: await realpath(process.execPath), piExecutable, piRoot, inferencePort: 61419 });
  await writeFile(profilePath, profile, { mode: 0o600 });
  const program = `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const { spawnSync } = require("node:child_process");
    const net = require("node:net");
    const checks = [];
    assert.equal(require("node:os").type(), "Darwin"); checks.push("Node OS initialization");
    const deny = (name, action) => {
      assert.throws(action, (error) => ["EPERM", "EACCES"].includes(error.code), name);
      checks.push(name);
    };
    fs.readFileSync(${JSON.stringify(join(workspace, "allowed.txt"))}); checks.push("candidate read");
    fs.writeFileSync(${JSON.stringify(join(workspace, "written.txt"))}, "candidate"); checks.push("candidate write");
    fs.writeFileSync(${JSON.stringify(join(stateDir, "written.txt"))}, "state"); checks.push("state write");
    fs.readFileSync(${JSON.stringify(piExecutable)}); checks.push("trusted Pi read");
    deny("source read denied", () => fs.readFileSync(${JSON.stringify(join(sourceRoot, "source.txt"))}));
    deny("original Pi state denied", () => fs.readFileSync(${JSON.stringify(join(sourceAgentDir, "auth.json"))}));
    deny("home SSH fixture denied", () => fs.readFileSync(${JSON.stringify(sshFile)}));
    deny("outside read denied", () => fs.readFileSync(${JSON.stringify(outsideFile)}));
    deny("outside write denied", () => fs.writeFileSync(${JSON.stringify(outsideFile)}, "escape"));
    deny("symlink escape denied", () => fs.readFileSync(${JSON.stringify(join(workspace, "source-link"))}));
    deny("home symlink escape denied", () => fs.readFileSync(${JSON.stringify(join(workspace, "home-link"))}));
    deny("installed runtime write denied", () => fs.writeFileSync(${JSON.stringify(piExecutable)}, "escape"));
    deny("profile write denied", () => fs.writeFileSync(${JSON.stringify(profilePath)}, "escape"));
    deny("candidate root replacement denied", () => fs.renameSync(${JSON.stringify(workspace)}, ${JSON.stringify(workspace + "-moved")}));
    const shell = spawnSync("/bin/sh", ["-c", "exit 0"]);
    assert.ok(shell.error && ["EPERM", "EACCES"].includes(shell.error.code)); checks.push("shell execution denied");
    const connect = (port) => new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      const finish = (code) => { socket.destroy(); resolve(code); };
      socket.on("connect", () => finish("connected"));
      socket.on("error", (error) => finish(error.code));
      socket.setTimeout(2000, () => finish("timeout"));
    });
    (async () => {
      assert.ok(["connected", "ECONNREFUSED"].includes(await connect(61419))); checks.push("approved loopback port allowed");
      assert.ok(["EPERM", "EACCES"].includes(await connect(61420))); checks.push("other network port denied");
      console.log(JSON.stringify({ checks }));
    })().catch((error) => { console.error(error.message); process.exitCode = 1; });
  `;
  const entryPoint = join(piRoot, "probe.cjs");
  await writeFile(entryPoint, program, { mode: 0o600 });
  const { stdout } = await promisify(execFile)("/usr/bin/sandbox-exec", ["-f", profilePath, process.execPath, entryPoint], {
    cwd: workspace,
    env: { HOME: join(stateDir, "home"), TMPDIR: join(stateDir, "tmp") },
    timeout: 10_000,
  });
  assert.equal(await readFile(outsideFile, "utf8"), "synthetic fixture\n");
  assert.equal(await readFile(piExecutable, "utf8"), "synthetic fixture\n");
  assert.equal(await readFile(profilePath, "utf8"), profile);
  const result = JSON.parse(stdout);
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, passed: result.checks.length, checks: result.checks }));
} finally {
  await rm(fixture, { recursive: true, force: true });
}
