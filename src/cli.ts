#!/usr/bin/env node

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { retryConnection } from "./connection.js";
import { executeJob, ExecutionFailure, verifyLocalProject } from "./executor.js";
import { jobSchema, setupSchema, type Result } from "./protocol.js";

function option(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const command = process.argv[2];
const url = (option("url") ?? process.env.DEV_PIPELINE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const directory = resolve(option("directory") ?? process.cwd());

const usage = "Usage: dev-pipeline-local connect [--url=https://pipeline.example] [--directory=/path/to/project]";

async function request(path: string, body?: object, token?: string) {
  const response = await fetch(`${url}${path}`, {
    method: body ? "POST" : "GET",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  return { response, data };
}

function openBrowser(target: string) {
  const [program, args] = process.platform === "darwin" ? ["open", [target]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", target]] : ["xdg-open", [target]];
  spawn(program, args, { detached: true, stdio: "ignore" }).unref();
}

function safeFailure(error: unknown) {
  const message = error instanceof Error ? error.message : "Local repository execution failed.";
  return message
    .replace(/(authorization:\s*bearer\s+)\S+/gi, "$1[redacted]")
    .replace(/(api[_ -]?key\s*[=:]\s*)\S+/gi, "$1[redacted]");
}

class TaskCancelled extends Error {}
class ReportRejected extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function pair() {
  const { response, data } = await request("/api/connectors", { action: "start" });
  if (!response.ok) throw new Error(data?.error ?? "Could not start browser pairing.");
  console.log(`Opening ${data.verificationUrl}`);
  openBrowser(data.verificationUrl);
  console.log(`Confirm code ${data.userCode} in your browser.`);
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const poll = await request("/api/connectors", { action: "poll", deviceCode: data.deviceCode });
    if (poll.response.status === 202) continue;
    if (!poll.response.ok) throw new Error(poll.data?.error ?? "Browser pairing failed.");
    return poll.data.token as string;
  }
}

async function report(token: string, body: object) {
  const result = await request("/api/runner", body, token);
  if (result.response.status === 409 && result.data?.active === false) return false;
  if (!result.response.ok) throw new ReportRejected(result.response.status, result.data?.error ?? `The pipeline rejected the result (${result.response.status}).`);
  return true;
}

async function reportEventually(token: string, body: object) {
  for (;;) {
    try { return await report(token, body); }
    catch (error) {
      if (error instanceof ReportRejected && error.status < 500) throw error;
      console.error("Could not reach the pipeline to save the task result. Retrying…");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function verifySetup(token: string) {
  const setup = await request("/api/runner?setup=1", undefined, token);
  if (!setup.response.ok) throw new Error(setup.data?.error ?? "Could not load project setup.");
  try {
    await verifyLocalProject(directory, setupSchema.parse(setup.data));
    await report(token, { action: "readiness", error: null });
    console.log("Repository and project checks are ready.");
  } catch (error) {
    await report(token, { action: "readiness", error: safeFailure(error) });
    throw error;
  }
}

async function run() {
  if (command !== "connect") throw new Error(usage);
  if (!url.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url)) throw new Error("The pipeline URL must use HTTPS unless it is localhost.");
  const token = await pair();
  await verifySetup(token);
  console.log("Connected. Leave this terminal open while Dev Pipeline is working.");
  for (;;) {
    const next = await retryConnection(() => request("/api/runner", undefined, token));
    if (next.response.status === 204) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    if (next.response.status === 428) {
      await verifySetup(token);
      continue;
    }
    if (!next.response.ok) throw new Error(next.data?.error ?? `Connection failed (${next.response.status}).`);
    const job = jobSchema.parse(next.data);
    console.log(`Working on ${job.branch}…`);
    let progress = "Preparing the local checkout";
    const cancellation = new AbortController();
    const pulse = setInterval(() => void report(token, { action: "heartbeat", jobId: job.id, progress }).then((active) => {
      if (!active) cancellation.abort();
    }).catch(() => {}), 15_000);
    let completed: Result | undefined;
    try {
      completed = await executeJob(job, directory, async (message, activity) => {
        progress = message;
        if (!await report(token, { action: "heartbeat", jobId: job.id, progress, ...(activity ? { activity } : {}) })) {
          cancellation.abort();
          throw new TaskCancelled("Task cancelled.");
        }
      }, cancellation.signal);
      if (!await reportEventually(token, { action: "completed", jobId: job.id, result: completed })) throw new TaskCancelled("Task cancelled.");
      console.log(`Finished ${job.branch} at ${completed.commit.slice(0, 8)}.`);
    } catch (error) {
      console.error(error);
      const checkpoint = error instanceof ExecutionFailure ? error.checkpoint : completed?.execution === "implementation" ? completed.commit : undefined;
      await reportEventually(token, { action: "failed", jobId: job.id, error: cancellation.signal.aborted ? "Cancelled by a project participant." : safeFailure(error), ...(checkpoint ? { checkpoint } : {}) });
    } finally {
      clearInterval(pulse);
    }
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
