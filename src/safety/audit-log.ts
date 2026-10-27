// Append-only JSONL record of every write sent to Geni.

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface AuditEntry {
  readonly tool: string;
  readonly target: string;
  readonly request: unknown;
  readonly before?: unknown;
  readonly outcome: "ok" | "error";
  readonly response?: unknown;
  readonly error?: string;
}

export class AuditLog {
  constructor(
    private readonly file: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    const line = JSON.stringify({ at: this.now().toISOString(), ...entry }) + "\n";
    try {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      await appendFile(this.file, line, { mode: 0o600 });
    } catch (err) {
      // The edit already happened on Geni; losing the log line must not hide that.
      console.error(`geni-mcp: failed to write audit log ${this.file}:`, err);
    }
  }
}
