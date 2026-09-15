import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { failedCommand, initialWorkPrompt, preserveChanges, repairPrompt, repositoryFromRemote, requiresGreenBaseline, runProjectScript, safeCodePath, verifyLocalProject } from "./executor.js";

const execFile = promisify(execFileCallback);

test("recognises GitHub repository remotes", () => {
  assert.equal(repositoryFromRemote("git@github.com:alexvernikov/example.git"), "alexvernikov/example");
  assert.equal(repositoryFromRemote("https://github.com/alexvernikov/example.git"), "alexvernikov/example");
  assert.equal(repositoryFromRemote("https://example.com/alexvernikov/example.git"), null);
});

test("failed commands retain complete verification evidence", () => {
  const evidence = `first relevant line\n${"x".repeat(600)}\nlast relevant line`;
  const message = failedCommand("Full verification failed", { code: 127, text: evidence });
  assert.match(message, /exit 127/);
  assert.match(message, /first relevant line/);
  assert.match(message, /last relevant line/);
});

test("only a first implementation requires a green starting branch", () => {
  assert.equal(requiresGreenBaseline({ execution: "implementation", baseCommit: "base", headCommit: "base" }), true);
  assert.equal(requiresGreenBaseline({ execution: "implementation", baseCommit: "base", headCommit: "pipeline-change" }), false);
  assert.equal(requiresGreenBaseline({ execution: "review", baseCommit: "base", headCommit: "pipeline-change" }), false);
});

test("returns failed verification to the coding agent", () => {
  const prompt = repairPrompt({ code: 1, text: "TypeError: createApp is not a function" });
  assert.match(prompt, /continue working/i);
  assert.match(prompt, /createApp is not a function/);
});

test("tells the coding agent to finish repository work before reporting", () => {
  const prompt = initialWorkPrompt("Implement the work unit", { code: 0, text: "Tests passed" });
  assert.match(prompt, /call finish_work with status ready/i);
  assert.match(prompt, /connector prepares the report/i);
  assert.doesNotMatch(prompt, /do not prepare the final report yet/i);
});

test("runs a declared project script", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dev-pipeline-local-test-"));
  try {
    await writeFile(path.join(directory, "package.json"), `${JSON.stringify({ scripts: { "test:integration": "node -e \"process.stdout.write('integration passed')\"" } })}\n`);
    const result = await runProjectScript(directory, "test:integration");
    assert.equal(result.code, 0);
    assert.match(result.text, /integration passed/);
    await assert.rejects(() => runProjectScript(directory, "missing"), /not defined/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("allows an environment template but rejects actual secrets", () => {
  assert.equal(safeCodePath(".env.example"), ".env.example");
  assert.throws(() => safeCodePath(".env"), /outside the permitted repository context/);
  assert.throws(() => safeCodePath("config/private.key"), /outside the permitted repository context/);
});

test("verifies a JavaScript project in the expected repository", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dev-pipeline-local-test-"));
  try {
    await execFile("git", ["init"], { cwd: directory });
    await execFile("git", ["remote", "add", "origin", "git@github.com:alexvernikov/example.git"], { cwd: directory });
    await writeFile(path.join(directory, "package.json"), "{}\n");
    await execFile("git", ["add", "."], { cwd: directory });
    await execFile("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"], { cwd: directory });
    const result = await verifyLocalProject(directory, { repository: "alexvernikov/example", commands: { setup: "", verify: "node -e \"process.exit(0)\"" } });
    assert.equal(result.code, 0);
    await assert.rejects(() => verifyLocalProject(directory, { repository: "someone/else", commands: { setup: "", verify: "node -e \"process.exit(0)\"" } }), /not someone\/else/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installs npm dependencies when no setup command is configured", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dev-pipeline-local-test-"));
  try {
    await execFile("git", ["init"], { cwd: directory });
    await execFile("git", ["remote", "add", "origin", "git@github.com:alexvernikov/example.git"], { cwd: directory });
    await writeFile(path.join(directory, "package.json"), `${JSON.stringify({ scripts: { preinstall: "node -e \"require('fs').writeFileSync('installed.marker', 'yes')\"" } })}\n`);
    await execFile("git", ["add", "."], { cwd: directory });
    await execFile("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"], { cwd: directory });

    const result = await verifyLocalProject(directory, {
      repository: "alexvernikov/example",
      commands: { setup: "", verify: "node -e \"if (!require('fs').existsSync('installed.marker')) process.exit(1)\"" },
    });

    assert.equal(result.code, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("project readiness commands cannot dirty the selected checkout", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dev-pipeline-local-test-"));
  try {
    await execFile("git", ["init"], { cwd: directory });
    await execFile("git", ["remote", "add", "origin", "git@github.com:alexvernikov/example.git"], { cwd: directory });
    await writeFile(path.join(directory, "package.json"), "{}\n");
    await execFile("git", ["add", "."], { cwd: directory });
    await execFile("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"], { cwd: directory });

    await verifyLocalProject(directory, {
      repository: "alexvernikov/example",
      commands: { setup: "node -e \"require('fs').writeFileSync('generated.txt', 'temporary')\"", verify: "node -e \"process.exit(0)\"" },
    });

    await assert.rejects(readFile(path.join(directory, "generated.txt")), { code: "ENOENT" });
    assert.equal((await execFile("git", ["status", "--porcelain"], { cwd: directory })).stdout, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed work is preserved on its work branch", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dev-pipeline-local-test-"));
  const remote = await mkdtemp(path.join(tmpdir(), "dev-pipeline-local-remote-"));
  try {
    await execFile("git", ["init", "--bare"], { cwd: remote });
    await execFile("git", ["init"], { cwd: directory });
    await execFile("git", ["remote", "add", "origin", remote], { cwd: directory });
    await writeFile(path.join(directory, "package.json"), "{}\n");
    await execFile("git", ["add", "."], { cwd: directory });
    await execFile("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"], { cwd: directory });
    const head = (await execFile("git", ["rev-parse", "HEAD"], { cwd: directory })).stdout.trim();
    await execFile("git", ["push", "origin", `HEAD:refs/heads/work/test`], { cwd: directory });
    await writeFile(path.join(directory, "generated.ts"), "export const generated = true;\n");

    const checkpoint = await preserveChanges(directory, { id: "job_test", branch: "work/test", headCommit: head });

    assert.ok(checkpoint);
    assert.equal((await execFile("git", ["--git-dir", remote, "show", "work/test:generated.ts"])).stdout, "export const generated = true;\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
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
