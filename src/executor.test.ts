import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createInactivitySignal, dependencyInstallCommand, failedCommand, repositoryFromRemote, verifyLocalProject } from "./executor.js";

const execFile = promisify(execFileCallback);

test("recognises GitHub repository remotes", () => {
  assert.equal(repositoryFromRemote("git@github.com:alexvernikov/example.git"), "alexvernikov/example");
  assert.equal(repositoryFromRemote("https://github.com/alexvernikov/example.git"), "alexvernikov/example");
  assert.equal(repositoryFromRemote("https://example.com/alexvernikov/example.git"), null);
});

test("activity extends execution while inactivity aborts it", async () => {
  const timeout = createInactivitySignal(40);
  await new Promise((resolve) => setTimeout(resolve, 25));
  timeout.touch();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(timeout.signal.aborted, false);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(timeout.signal.aborted, true);
  timeout.stop();
});

test("selects the repository package manager for changed dependencies", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dev-pipeline-local-test-"));
  try {
    await writeFile(path.join(directory, "package.json"), '{"packageManager":"pnpm@10.0.0"}\n');
    assert.equal(await dependencyInstallCommand(directory), "pnpm install");
    await writeFile(path.join(directory, "package.json"), "{}\n");
    assert.equal(await dependencyInstallCommand(directory), "npm install");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed commands retain concise verification evidence", () => {
  const message = failedCommand("Full verification failed", { code: 127, text: "sh: vitest: command not found" });
  assert.match(message, /exit 127/);
  assert.match(message, /vitest: command not found/);
  assert.ok(message.length <= 500);
});

test("verifies a JavaScript project in the expected repository", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dev-pipeline-local-test-"));
  try {
    await execFile("git", ["init"], { cwd: directory });
    await execFile("git", ["remote", "add", "origin", "git@github.com:alexvernikov/example.git"], { cwd: directory });
    await writeFile(path.join(directory, "package.json"), "{}\n");
    const result = await verifyLocalProject(directory, { repository: "alexvernikov/example", commands: { setup: "", verify: "node -e \"process.exit(0)\"" } });
    assert.equal(result.code, 0);
    await assert.rejects(() => verifyLocalProject(directory, { repository: "someone/else", commands: { setup: "", verify: "node -e \"process.exit(0)\"" } }), /not someone\/else/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("connects a new repository before its JavaScript project exists", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dev-pipeline-local-test-"));
  const remote = await mkdtemp(path.join(tmpdir(), "dev-pipeline-local-remote-"));
  try {
    await execFile("git", ["init", "--bare"], { cwd: remote });
    await execFile("git", ["init"], { cwd: directory });
    await execFile("git", ["remote", "add", "origin", "git@github.com:alexvernikov/example.git"], { cwd: directory });
    await execFile("git", ["config", `url.file://${remote}.insteadOf`, "git@github.com:alexvernikov/example.git"], { cwd: directory });
    await mkdir(path.join(directory, "specs"));
    await writeFile(path.join(directory, "specs", ".pipeline.json"), "{}\n");
    await execFile("git", ["add", "."], { cwd: directory });
    await execFile("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "specs"], { cwd: directory });
    await execFile("git", ["branch", "-M", "main"], { cwd: directory });
    await execFile("git", ["push", "-u", "origin", "main"], { cwd: directory });

    const result = await verifyLocalProject(directory, { repository: "alexvernikov/example", commands: { setup: "", verify: "npm test && npm run build" } });
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")).scripts.build, "node --check src/index.js");
    assert.equal((await execFile("git", ["--git-dir", remote, "show", "main:src/index.js"])).stdout, "export {};\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  }
});
