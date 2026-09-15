import { spawn } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateText, hasToolCall, Output, tool } from "ai";
import { z } from "zod";
import { CheckLog } from "./checks.js";
import { languageModel } from "./providers.js";
import { implementationSchema, resultSchema, reviewSchema, type AgentReport, type Job, type Result, type Setup } from "./protocol.js";

type CommandResult = { code: number; text: string };

export class ExecutionFailure extends Error {
  constructor(message: string, readonly checkpoint?: string) { super(message); }
}

export function failedCommand(label: string, result: CommandResult) {
  const prefix = `${label} (exit ${result.code}).`;
  return result.text.trim() ? `${prefix}\n\n${result.text.trim()}` : prefix;
}

export function repairPrompt(result: CommandResult) {
  return `Continue working on the current repository change. Full project verification failed with exit ${result.code}. Inspect and fix the cause, then run the checks again before finishing.\n\n${result.text}`;
}

export function requiresGreenBaseline(job: Pick<Job, "execution" | "baseCommit" | "headCommit">) {
  return job.execution === "implementation" && job.baseCommit === job.headCommit;
}

export function repositoryFromRemote(remote: string) {
  const match = remote.trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?$/i);
  return match?.[1] ?? null;
}

export function safeCodePath(value: string) {
  const name = value.split("/").at(-1)?.toLowerCase();
  const secret = (name?.startsWith(".env") && name !== ".env.example") || /\.(pem|key)$/i.test(name ?? "");
  if (!value || value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => !part || ["..", ".", ".git", ".ai-pipeline"].includes(part)) || secret) throw new Error("This file is outside the permitted repository context.");
  return value;
}

function run(cwd: string, program: string, args: string[], signal?: AbortSignal, shell = false): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, shell, signal });
    let text = "";
    child.stdout?.on("data", (chunk) => { text += chunk; });
    child.stderr?.on("data", (chunk) => { text += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, text: text.trim() }));
  });
}

async function git(cwd: string, args: string[], signal?: AbortSignal) {
  const result = await run(cwd, "git", args, signal);
  if (result.code) throw new Error(failedCommand(`Git ${args.join(" ")} failed`, result));
  return result.text;
}

function command(cwd: string, value: string, signal?: AbortSignal) {
  return run(cwd, value, [], signal, true);
}

async function dependencyCommand(root: string, configured: string) {
  if (configured.trim()) return configured;
  for (const [file, command] of [
    ["pnpm-lock.yaml", "pnpm install"],
    ["yarn.lock", "yarn install"],
    ["bun.lock", "bun install"],
    ["bun.lockb", "bun install"],
  ]) {
    if (await lstat(path.join(root, file)).then(() => true, () => false)) return command;
  }
  return "npm install";
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
  const temporary = await mkdtemp(path.join(tmpdir(), "dev-pipeline-ready-"));
  const workspace = path.join(temporary, "repository");
  await git(root, ["worktree", "add", "--detach", workspace, "HEAD"]);
  try {
    const installation = await command(workspace, await dependencyCommand(workspace, setup.commands.setup));
    if (installation.code) throw new Error(failedCommand("The setup command failed", installation));
    const verification = await command(workspace, setup.commands.verify);
    if (verification.code) throw new Error(failedCommand("The verification command failed", verification));
    return verification;
  } finally {
    await git(root, ["worktree", "remove", "--force", workspace]).catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  }
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

async function checkout(sourceDirectory: string, job: Job, signal?: AbortSignal) {
  const root = await repositoryRoot(sourceDirectory, job.repository);
  await git(root, ["fetch", "origin", `refs/heads/${job.branch}:refs/remotes/origin/${job.branch}`], signal);
  const temporary = await mkdtemp(path.join(tmpdir(), "dev-pipeline-"));
  const workspace = path.join(temporary, "repository");
  await git(root, ["worktree", "add", "--detach", workspace, job.headCommit], signal);
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

export async function preserveChanges(root: string, job: Pick<Job, "id" | "branch" | "headCommit">, signal?: AbortSignal) {
  const changed = await git(root, ["status", "--porcelain"], signal);
  let commit = (await git(root, ["rev-parse", "HEAD"], signal)).trim();
  if (!changed && commit === job.headCommit) return undefined;
  if (changed) {
    await git(root, ["add", "-A"], signal);
    const names = (await git(root, ["diff", "--cached", "--name-only"], signal)).split("\n").filter(Boolean);
    for (const name of names) await safeLocalPath(root, name);
    await git(root, ["-c", "user.name=Dev Pipeline", "-c", "user.email=dev-pipeline@localhost", "commit", "-m", `checkpoint: ${job.id}`], signal);
    commit = (await git(root, ["rev-parse", "HEAD"], signal)).trim();
  }
  await git(root, ["push", "origin", `HEAD:refs/heads/${job.branch}`], signal);
  return commit;
}

export async function executeJob(job: Job, sourceDirectory: string, heartbeat: (progress: string, activity?: string) => Promise<void>, signal?: AbortSignal): Promise<Result> {
  await heartbeat("Preparing the local checkout");
  const worktree = await checkout(sourceDirectory, job, signal);
  const progress = (message: string, activity?: string) => heartbeat(message, activity);
  let removeWorktree = true;
  try {
    await progress("Installing project dependencies");
    const setup = await command(worktree.root, await dependencyCommand(worktree.root, job.commands.setup), signal);
    if (setup.code) throw new Error(failedCommand("The setup command failed", setup));
    const verify = () => command(worktree.root, job.commands.verify, signal);
    if (job.action === "merge") {
      await progress("Running full verification before merge");
      const verification = await verify();
      if (verification.code) throw new Error(failedCommand("Full verification failed; the reviewed change was not merged", verification));
      if (await git(worktree.root, ["status", "--porcelain"], signal)) throw new Error("Setup or verification changed the checkout.");
      return { execution: "merge", commit: job.headCommit, verification };
    }
    if (!job.ai || !job.execution || !job.system || !job.prompt) throw new Error("The repository job is incomplete.");
    const ai = job.ai;
    await progress("Checking the unchanged project");
    const baseline = await verify();
    if (baseline.code && requiresGreenBaseline(job)) throw new Error(failedCommand("The unchanged repository failed verification", baseline));
    if (baseline.code) await progress("Repairing the existing pipeline change");
    const readonly = job.execution === "review";
    const checks = new CheckLog();
    let blocker: string | undefined;
    const runCheck = async (focused: boolean) => {
      await progress(focused ? "Running focused tests" : "Running full verification");
      const selected = focused && job.commands.test ? job.commands.test : job.commands.verify;
      const result = await command(worktree.root, selected, signal);
      checks.checked(selected, result);
      await progress(`${focused ? "Focused tests" : "Full verification"} ${result.code === 0 ? "passed" : "failed"}`);
      return result;
    };
    const tools = {
      delivery_diff: tool({ description: "Inspect committed application changes from the work unit base to its current head", inputSchema: z.object({}), execute: async () => { await progress("Inspecting the committed change"); return git(worktree.root, ["diff", `${job.baseCommit}...${job.headCommit}`, "--", ".", ":(exclude)specs/**"], signal); } }),
      list_files: tool({ description: "List repository files", inputSchema: z.object({}), execute: async () => { await progress("Listing repository files"); return (await git(worktree.root, ["ls-files"], signal)).split("\n").filter((file) => { try { safeCodePath(file); return !file.startsWith("specs/"); } catch { return false; } }).join("\n"); } }),
      read_file: tool({ description: "Read a relevant text file", inputSchema: z.object({ path: z.string() }), execute: async ({ path: relative }) => {
        await progress(`Reading ${relative}`);
        const data = await readFile(await safeLocalPath(worktree.root, relative));
        if (data.includes(0)) throw new Error("Only text files can be read.");
        return data.toString("utf8");
      } }),
      diff: tool({ description: "Show current uncommitted changes", inputSchema: z.object({}), execute: async () => { await progress("Inspecting current changes"); return git(worktree.root, ["diff", "HEAD"], signal); } }),
      run_checks: tool({ description: "Run the configured test or verification command", inputSchema: z.object({ focused: z.boolean() }), execute: async ({ focused }) => runCheck(focused) }),
      run_setup: tool({ description: "Run the project's configured setup command after changing dependencies", inputSchema: z.object({}), execute: async () => {
        await progress("Installing project dependencies");
        const result = await command(worktree.root, await dependencyCommand(worktree.root, job.commands.setup), signal);
        if (result.code) throw new Error(failedCommand("The setup command failed", result));
        return result.text || "Setup completed.";
      } }),
      finish_work: tool({ description: "Finish repository work, or stop with a concrete blocker that needs human direction", inputSchema: z.object({ status: z.enum(["ready", "blocked"]), reason: z.string().optional() }), execute: async ({ status, reason }) => {
        blocker = status === "blocked" ? reason || "The agent needs human direction before it can continue." : undefined;
        return status === "blocked" ? "Work stopped for human direction." : "Work finished.";
      } }),
      ...(!readonly ? {
        write_file: tool({ description: "Write a changed text file and classify the edit", inputSchema: z.object({ path: z.string(), kind: z.enum(["test", "implementation", "refactor"]), content: z.string() }), execute: async ({ path: relative, kind, content }) => {
          await progress(`${kind === "test" ? "Writing test" : kind === "implementation" ? "Writing code" : "Refining code"}: ${relative}`);
          const filename = await safeLocalPath(worktree.root, relative);
          await mkdir(path.dirname(filename), { recursive: true });
          await writeFile(filename, content, "utf8");
          return "Saved.";
        } }),
        delete_file: tool({ description: "Delete an obsolete repository file", inputSchema: z.object({ path: z.string() }), execute: async ({ path: relative }) => {
          await progress(`Deleting obsolete file: ${relative}`);
          await rm(await safeLocalPath(worktree.root, relative));
          return "Deleted.";
        } }),
        move_file: tool({ description: "Move or rename a repository file", inputSchema: z.object({ from: z.string(), to: z.string() }), execute: async ({ from, to }) => {
          await progress(`Moving ${from} to ${to}`);
          const source = await safeLocalPath(worktree.root, from);
          const destination = await safeLocalPath(worktree.root, to);
          await mkdir(path.dirname(destination), { recursive: true });
          await rename(source, destination);
          return "Moved.";
        } }),
      } : {}),
    };
    const schema: z.ZodType<AgentReport> = job.execution === "implementation" ? implementationSchema : reviewSchema;
    await progress(job.execution === "implementation" ? "Planning the first test-first change" : "Reviewing the implementation");
    const work = async (prompt: string) => {
      blocker = undefined;
      const response = await generateText({
        model: languageModel(ai), system: job.system, prompt, tools,
        stopWhen: hasToolCall("finish_work"), abortSignal: signal,
        onStepFinish: async ({ text }) => { if (text.trim()) await progress("Agent response", text.trim()); },
      });
      if (blocker) throw new Error(blocker);
      return response;
    };
    let agentNotes = (await work(`${job.prompt}\n\n# Unchanged baseline\nExit: ${baseline.code}\n${baseline.text}\n\nWork on the repository with the available tools. Do not prepare the final report yet.`)).text;
    let finalCommand = "";
    let verification: CommandResult = baseline;
    for (;;) {
      await progress("Running final verification");
      finalCommand = job.commands.verify;
      verification = await command(worktree.root, finalCommand, signal);
      checks.checked(finalCommand, verification);
      await progress(`Final verification ${verification.code === 0 ? "passed" : "failed"}`);
      if (!verification.code || readonly) break;
      await progress("Repairing the failed verification");
      const diff = await git(worktree.root, ["diff", "HEAD"], signal);
      const repair = await work(`${job.prompt}\n\n${repairPrompt(verification)}\n\n# Current change\n${diff}`);
      agentNotes = `${agentNotes}\n\n${repair.text}`;
    }
    const evidence = readonly ? "" : checks.finish();
    await progress("Preparing the verified report");
    const diff = readonly
      ? await git(worktree.root, ["diff", `${job.baseCommit}...${job.headCommit}`, "--", ".", ":(exclude)specs/**"], signal)
      : `${await git(worktree.root, ["diff", `${job.baseCommit}...HEAD`, "--", ".", ":(exclude)specs/**"], signal)}\n${await git(worktree.root, ["diff", "HEAD"], signal)}`.trim();
    const summary = await generateText({
      model: languageModel(ai),
      system: job.system,
      prompt: `${job.prompt}\n\nThe repository work is complete${verification.code ? " with failing verification" : " and final verification passed"}. Return only the required structured ${job.execution} report from the evidence below. Do not perform more repository work.\n\n# Agent notes\n${agentNotes}\n\n# Change\n${diff}\n\n# Final verification\nCommand: ${finalCommand}\nExit: ${verification.code}\n${verification.text}\n\n${evidence ? `# Check evidence\n${evidence}` : ""}`,
      output: Output.object({ schema }),
      abortSignal: signal,
      onStepFinish: async ({ text }) => { if (text.trim()) await progress("Preparing the report", text.trim()); },
    });
    const report = readonly && verification.code && summary.output.kind === "review" && summary.output.recommendation === "Accept"
      ? { ...summary.output, recommendation: "Revise" as const }
      : summary.output;
    if (report.kind !== job.execution) throw new Error("The model returned the wrong execution report.");
    if (readonly) {
      if (await git(worktree.root, ["status", "--porcelain"], signal)) throw new Error("Review changed the checkout.");
      return { execution: "review", commit: job.headCommit, report: reviewSchema.parse(report), verification };
    }
    await progress("Preparing the verified commit");
    await git(worktree.root, ["add", "-A"], signal);
    const names = (await git(worktree.root, ["diff", "--cached", "--name-only"], signal)).split("\n").filter(Boolean);
    if (!names.length) {
      if (job.headCommit === job.baseCommit) throw new Error("No repository changes were produced.");
      return resultSchema.parse({ execution: "implementation", commit: job.headCommit, report: implementationSchema.parse(report), evidence, verification });
    }
    for (const name of names) await safeLocalPath(worktree.root, name);
    await git(worktree.root, ["-c", "user.name=Dev Pipeline", "-c", "user.email=dev-pipeline@localhost", "commit", "-m", `implementation: ${job.id}`], signal);
    const commit = (await git(worktree.root, ["rev-parse", "HEAD"], signal)).trim();
    const result = resultSchema.parse({ execution: "implementation", commit, report: implementationSchema.parse(report), evidence, verification });
    await progress("Pushing the verified work branch");
    await git(worktree.root, ["push", "origin", `HEAD:refs/heads/${job.branch}`], signal);
    return result;
  } catch (error) {
    if (job.execution !== "implementation") throw error;
    try {
      const saved = await preserveChanges(worktree.root, job);
      if (!saved) throw error;
      throw new ExecutionFailure(`${error instanceof Error ? error.message : "Implementation failed."}\n\nUnverified work was preserved on ${job.branch} at ${saved}.`, saved);
    } catch (checkpointError) {
      if (checkpointError instanceof ExecutionFailure || checkpointError === error) throw checkpointError;
      removeWorktree = false;
      throw new ExecutionFailure(`${error instanceof Error ? error.message : "Implementation failed."}\n\nThe checkpoint could not be pushed. The generated files remain at ${worktree.root}.\n${checkpointError instanceof Error ? checkpointError.message : checkpointError}`);
    }
  } finally {
    if (removeWorktree) await worktree.cleanup();
  }
}
