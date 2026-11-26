import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Journal d'audit append-only (SPEC §4.4).
 * Il ne contient jamais le contenu des échanges : seulement des métadonnées scalaires.
 */
export type AuditEvent =
  | "brain.created"
  | "brain.opened"
  | "brain.closed"
  | "brain.level_changed"
  | "launch.blocked"
  | "launch.started"
  | "policy.check_failed"
  | "policy.bypass_observed"
  | "connector.enabled"
  | "export";

export type AuditDetails = Record<string, string | number | boolean | null>;

export interface AuditEntry {
  ts: string;
  event: AuditEvent;
  brain?: string;
  details: AuditDetails;
}

export class AuditLog {
  readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, "audit", "audit.jsonl");
  }

  async record(event: AuditEvent, brain?: string, details: AuditDetails = {}): Promise<AuditEntry> {
    for (const [key, value] of Object.entries(details)) {
      if (value !== null && typeof value === "object") {
        throw new Error(`audit : la valeur de "${key}" doit être scalaire`);
      }
    }
    const entry: AuditEntry = { ts: new Date().toISOString(), event, details };
    if (brain !== undefined) entry.brain = brain;
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return entry;
  }
}
