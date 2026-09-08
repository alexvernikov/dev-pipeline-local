import { z } from "zod";

export const implementationSchema = z.object({
  kind: z.literal("implementation"),
  result: z.string(),
  architecture: z.string(),
  remainingRisks: z.string(),
});

export const reviewSchema = z.object({
  kind: z.literal("review"),
  findings: z.string(),
  testResult: z.string(),
  architectureResult: z.string(),
  remainingRisks: z.string(),
  recommendation: z.enum(["Accept", "Revise", "Escalate"]),
});

const commandResultSchema = z.object({ code: z.number().int(), text: z.string().max(20_000) });

export const setupSchema = z.object({
  repository: z.string().regex(/^[^/]+\/[^/]+$/),
  commands: z.object({ setup: z.string(), verify: z.string().min(1) }),
});

export const jobSchema = z.object({
  id: z.string(),
  action: z.enum(["run", "merge"]),
  execution: z.enum(["implementation", "review"]).optional(),
  repository: z.string(),
  branch: z.string(),
  baseCommit: z.string(),
  headCommit: z.string(),
  ai: z.object({ provider: z.string(), model: z.string(), apiKey: z.string() }).optional(),
  commands: z.object({ setup: z.string(), test: z.string(), verify: z.string() }),
  system: z.string().optional(),
  prompt: z.string().optional(),
  testPlan: z.string().optional(),
});

export const resultSchema = z.discriminatedUnion("execution", [
  z.object({ execution: z.literal("implementation"), commit: z.string(), report: implementationSchema, evidence: z.string().max(100_000), verification: commandResultSchema }),
  z.object({ execution: z.literal("review"), commit: z.string(), report: reviewSchema, verification: commandResultSchema }),
  z.object({ execution: z.literal("merge"), commit: z.string(), verification: commandResultSchema }),
]);

export type Job = z.infer<typeof jobSchema>;
export type Result = z.infer<typeof resultSchema>;
export type Setup = z.infer<typeof setupSchema>;
export type AgentReport = z.infer<typeof implementationSchema> | z.infer<typeof reviewSchema>;
