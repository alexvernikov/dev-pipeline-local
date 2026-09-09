import { exec as execCallback, execFile as execFileCallback } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { generateText, Output, stepCountIs, tool } from "ai";
import { z } from "zod";
import { ImplementationChecks } from "./checks.js";
import { languageModel } from "./providers.js";
import { implementationSchema, reviewSchema, type AgentReport, type Job, type Result, type Setup } from "./protocol.js";

const exec = promisify(execCallback);
const execFile = promisify(execFileCallback);
type CommandResult = { code: number; text: string };

export function repositoryFromRemote(remote: string) {
  const match = remote.trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?$/i);
  return match?.[1] ?? null;
}

function safeCodePath(value: string) {
  if (!value || value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => !part || ["..", ".", ".git", ".ai-pipeline"].includes(part)) || /(^|\/)(\.env(?:\.|$)|.*\.(pem|key)$)/i.test(value)) throw new Error("This file is outside the permitted repository context.");
  return value;
}

async function git(cwd: string, args: string[]) {
  try {
    const result = await execFile("git", args, { cwd, timeout: 120_000, maxBuffer: 20_000_000 });
    return `${result.stdout}\n${result.stderr}`.trim();
  } catch { throw new Error(`Git could not ${args[0]}.`); }
}

async function command(cwd: string, value: string): Promise<CommandResult> {
  try {
    const result = await exec(value, { cwd, timeout: 120_000, maxBuffer: 20_000_000 });
    return { code: 0, text: `${result.stdout}\n${result.stderr}`.trim().slice(-20_000) };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === "number" ? failure.code : 1, text: `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`.trim().slice(-20_000) };
  }
}

async function repositoryRoot(sourceDirectory: string, expectedRepository: string) {
  const source = await realpath(sourceDirectory);
  const root = (await git(source, ["rev-parse", "--show-toplevel"])).trim();
  const remote = repositoryFromRemote(await git(root, ["config", "--get", "remote.origin.url"]));
  if (remote?.toLowerCase() !== expectedRepository.toLowerCase()) throw new Error(`The selected directory is not ${expectedRepository}.`);
  return root;
}

async function hasJavaScriptProject(root: string) {
  try {
    JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("The repository has an invalid package.json.");
  }
}

async function scaffoldJavaScriptProject(root: string, repository: string) {
  const files = (await git(root, ["ls-files"])).split("\n").filter(Boolean);
  const codeFiles = files.filter((file) => !file.startsWith("specs/") && !/^(?:README(?:\..*)?|LICENSE(?:\..*)?|\.gitignore|\.gitattributes)$/i.test(file));
  if (codeFiles.length) throw new Error("This connector supports JavaScript projects with a valid package.json.");
  if (await git(root, ["status", "--porcelain"])) throw new Error("Commit or discard local changes before initializing this project.");
  const name = repository.split("/").at(-1)!.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "package.json"), `${JSON.stringify({ name, private: true, type: "module", scripts: { test: "node --test", build: "node --check src/index.js" } }, null, 2)}\n`);
  await writeFile(path.join(root, "src", "index.js"), "export {};\n");
  await git(root, ["add", "package.json", "src/index.js"]);
  await git(root, ["-c", "user.name=Dev Pipeline", "-c", "user.email=dev-pipeline@localhost", "commit", "-m", "chore: initialize JavaScript project"]);
  await git(root, ["push", "origin", "HEAD"]);
}

export async function verifyLocalProject(sourceDirectory: string, setup: Setup) {
  const root = await repositoryRoot(sourceDirectory, setup.repository);
  if (!await hasJavaScriptProject(root)) await scaffoldJavaScriptProject(root, setup.repository);
  if (setup.commands.setup) {
    const installation = await command(root, setup.commands.setup);
    if (installation.code) throw new Error("The setup command failed.");
  }
  const verification = await command(root, setup.commands.verify);
  if (verification.code) throw new Error("The verification command failed.");
  return verification;
}

async function safeLocalPath(root: string, relative: string) {
  safeCodePath(relative);
  const rootPath = await realpath(root);
  const filename = path.resolve(rootPath, relative);
  if (!filename.startsWith(`${rootPath}${path.sep}`)) throw new Error("This file is outside the repository.");
  let current = rootPath;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    const entry = await lstat(current).catch(() => null);
    if (entry?.isSymbolicLink()) throw new Error("Symbolic links are not permitted.");
  }
  if (relative.startsWith("specs/") || relative.startsWith(".github/")) throw new Error("Pipeline records and automation configuration are not editable through code tools.");
  return filename;
}

async function checkout(sourceDirectory: string, job: Job) {
  const root = await repositoryRoot(sourceDirectory, job.repository);
  await git(root, ["fetch", "origin", `refs/heads/${job.branch}:refs/remotes/origin/${job.branch}`]);
  const temporary = await mkdtemp(path.join(tmpdir(), "dev-pipeline-"));
  const workspace = path.join(temporary, "repository");
  await git(root, ["worktree", "add", "--detach", workspace, job.headCommit]);
  if ((await git(workspace, ["rev-parse", "HEAD"])).trim() !== job.headCommit) {
    await git(root, ["worktree", "remove", "--force", workspace]).catch(() => {});
    await rm(temporary, { recursive: true, force: true });
    throw new Error("The local checkout does not match the queued work branch.");
  }
  return { root: workspace, cleanup: async () => {
    await git(root, ["worktree", "remove", "--force", workspace]).catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  } };
}

export async function executeJob(job: Job, sourceDirectory: string, heartbeat: () => Promise<void>): Promise<Result> {
  const worktree = await checkout(sourceDirectory, job);
  try {
    if (job.commands.setup) {
      const setup = await command(worktree.root, job.commands.setup);
      if (setup.code) throw new Error("The configured setup command failed.");
    }
    const verify = () => command(worktree.root, job.commands.verify);
    if (job.action === "merge") {
      const verification = await verify();
      if (verification.code) throw new Error("Full verification failed. The reviewed change was not merged.");
      if (await git(worktree.root, ["status", "--porcelain"])) throw new Error("Setup or verification changed the checkout.");
      return { execution: "merge", commit: job.headCommit, verification };
    }
    if (!job.ai || !job.execution || !job.system || !job.prompt) throw new Error("The repository job is incomplete.");
    const baseline = await verify();
    if (job.execution === "implementation" && baseline.code) throw new Error("The unchanged repository must pass verification before implementation.");
    const readonly = job.execution === "review";
    const checks = new ImplementationChecks(job.testPlan ?? "");
    const runCheck = async (focused: boolean) => {
      await heartbeat();
      const selected = focused ? job.commands.test || job.commands.verify : job.commands.verify;
      const result = await command(worktree.root, selected);
      checks.checked(selected, result);
      return result;
    };
    const tools = {
      delivery_diff: tool({ description: "Inspect committed application changes from the work unit base to its current head", inputSchema: z.object({}), execute: async () => (await git(worktree.root, ["diff", `${job.baseCommit}...${job.headCommit}`, "--", ".", ":(exclude)specs/**"])).slice(-100_000) }),
      list_files: tool({ description: "List repository files", inputSchema: z.object({}), execute: async () => (await git(worktree.root, ["ls-files"])).split("\n").filter((file) => { try { safeCodePath(file); return !file.startsWith("specs/"); } catch { return false; } }).slice(0, 2000).join("\n") }),
      read_file: tool({ description: "Read a relevant text file", inputSchema: z.object({ path: z.string() }), execute: async ({ path: relative }) => {
        await heartbeat();
        const data = await readFile(await safeLocalPath(worktree.root, relative));
        if (data.length > 100_000 || data.includes(0)) throw new Error("Read text files under 100 KB.");
        return data.toString("utf8");
      } }),
      diff: tool({ description: "Show current uncommitted changes", inputSchema: z.object({}), execute: async () => (await git(worktree.root, ["diff", "HEAD"])).slice(-100_000) }),
      run_checks: tool({ description: "Run the configured test or verification command", inputSchema: z.object({ focused: z.boolean() }), execute: async ({ focused }) => runCheck(focused) }),
      ...(!readonly ? {
        begin_behavior: tool({ description: "Start the next approved behaviour's test and implementation cycle", inputSchema: z.object({ behavior: z.string().min(1) }), execute: async ({ behavior }) => { checks.begin(behavior); return "Write its test, then run checks."; } }),
        confirm_red: tool({ description: "Record why the observed assertion failure proves missing behaviour", inputSchema: z.object({ assertionExcerpt: z.string().min(1), reason: z.string().min(1) }), execute: async ({ assertionExcerpt, reason }) => { checks.confirmRed(assertionExcerpt, reason); return "Red assessment recorded."; } }),
        use_existing_checks: tool({ description: "Cite the approved reason to use existing verification instead of TDD", inputSchema: z.object({ planExcerpt: z.string().min(1) }), execute: async ({ planExcerpt }) => { checks.useExistingChecks(planExcerpt); return "Exception recorded."; } }),
        write_file: tool({ description: "Write a changed text file and classify the edit", inputSchema: z.object({ path: z.string(), kind: z.enum(["test", "implementation", "refactor"]), content: z.string().max(100_000) }), execute: async ({ path: relative, kind, content }) => {
          await heartbeat();
          const filename = await safeLocalPath(worktree.root, relative);
          checks.beforeWrite(kind);
          await mkdir(path.dirname(filename), { recursive: true });
          await writeFile(filename, content, "utf8");
          return "Saved.";
        } }),
      } : {}),
    };
    const schema: z.ZodType<AgentReport> = job.execution === "implementation" ? implementationSchema : reviewSchema;
    const result = await generateText({ model: languageModel(job.ai), system: job.system, prompt: `${job.prompt}\n\n# Unchanged baseline\nExit: ${baseline.code}\n${baseline.text}`, tools, stopWhen: stepCountIs(60), output: Output.object({ schema }), abortSignal: AbortSignal.timeout(240_000) });
    if (result.output.kind !== job.execution) throw new Error("The model returned the wrong execution report.");
    const verification = await verify();
    checks.checked(job.commands.verify, verification);
    if (verification.code) throw new Error("Full verification failed. The change was not published.");
    if (readonly) {
      if (await git(worktree.root, ["status", "--porcelain"])) throw new Error("Review changed the checkout.");
      return { execution: "review", commit: job.headCommit, report: reviewSchema.parse(result.output), verification };
    }
    const evidence = checks.finish();
    await git(worktree.root, ["add", "-A"]);
    const names = (await git(worktree.root, ["diff", "--cached", "--name-only"])).split("\n").filter(Boolean);
    if (!names.length) throw new Error("No repository changes were produced.");
    for (const name of names) {
      const data = await readFile(await safeLocalPath(worktree.root, name)).catch(() => null);
      if (data && (data.length > 100_000 || data.includes(0))) throw new Error("Only text source changes under 100 KB per file are supported.");
    }
    await git(worktree.root, ["-c", "user.name=Dev Pipeline", "-c", "user.email=dev-pipeline@localhost", "commit", "-m", `implementation: ${job.id}`]);
    const commit = (await git(worktree.root, ["rev-parse", "HEAD"])).trim();
    await heartbeat();
    await git(worktree.root, ["push", "origin", `HEAD:refs/heads/${job.branch}`]);
    return { execution: "implementation", commit, report: implementationSchema.parse(result.output), evidence, verification };
  } finally {
    await worktree.cleanup();
  }
}
