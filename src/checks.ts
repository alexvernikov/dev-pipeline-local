export type CheckResult = { code: number; text: string };

export class CheckLog {
  private evidence: string[] = [];

  checked(command: string, result: CheckResult) {
    this.evidence.push(`Command: ${command}\nExit: ${result.code}\n${result.text}`);
  }

  finish() {
    return this.evidence.join("\n\n");
  }
}
