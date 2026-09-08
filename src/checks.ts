export type CheckResult = { code: number; text: string };

export class ImplementationChecks {
  private behavior = "";
  private red = false;
  private green = false;
  private testChanged = false;
  private refactoring = false;
  private latest?: CheckResult;
  private exception = false;
  private evidence: string[] = [];

  constructor(private readonly approvedPlan: string) {}

  begin(behavior: string) {
    if (this.exception || (this.behavior && !this.green)) throw new Error("Finish the current verification approach before starting another behaviour.");
    this.behavior = behavior;
    this.red = this.green = this.testChanged = this.refactoring = false;
    this.latest = undefined;
    this.evidence.push(`Behaviour: ${behavior}`);
  }

  useExistingChecks(planExcerpt: string) {
    if (this.behavior || this.exception) throw new Error("Choose the verification approach before changing files.");
    if (!planExcerpt.trim() || !this.approvedPlan.includes(planExcerpt)) throw new Error("Cite the approved test plan's reason for using existing checks instead of new behaviour tests.");
    this.exception = true;
    this.evidence.push(`Existing-checks exception, cited by the implementer for human review:\n${planExcerpt}`);
  }

  beforeWrite(kind: "test" | "implementation" | "refactor") {
    if (this.exception) {
      if (kind === "test") throw new Error("New tests require a behaviour-by-behaviour run.");
    } else {
      if (!this.behavior) throw new Error("Begin one behaviour before changing files.");
      if (kind === "test" && this.red) throw new Error("Keep this behaviour's test fixed after red.");
      if (kind === "implementation" && !this.red) throw new Error("Confirm the intended assertion failure before implementation.");
      if (kind === "refactor" && !this.green && !this.refactoring) throw new Error("Refactor only after green.");
    }
    if (kind === "refactor") this.refactoring = true;
    this.green = false;
    this.latest = undefined;
    if (kind === "test") this.testChanged = true;
  }

  checked(command: string, result: CheckResult) {
    this.latest = result;
    this.green = result.code === 0 && (this.red || this.exception);
    this.evidence.push(`Command: ${command}\nExit: ${result.code}\n${result.text}`);
  }

  confirmRed(assertion: string, reason: string) {
    if (!this.behavior || !this.testChanged || !this.latest || this.latest.code === 0 || this.red) throw new Error("Run the new test and inspect its failure before confirming red.");
    if (!assertion.trim() || !this.latest.text.includes(assertion)) throw new Error("The assertion excerpt must occur in the last command output.");
    this.red = true;
    this.evidence.push(`Implementer's red assessment: ${reason}\nAssertion excerpt: ${assertion}`);
  }

  finish() {
    if (!this.green || (!this.red && !this.exception)) throw new Error("Complete the current behaviour through green, or use the approved existing-checks approach.");
    return this.evidence.join("\n\n");
  }
}
