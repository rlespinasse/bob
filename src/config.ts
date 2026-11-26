import { homedir } from "node:os";
import { join } from "node:path";

export interface BobConfig {
  /** Racine des données (brains, audit). Hors du dépôt de code. */
  dataDir: string;
  /** Port de la web UI (liée à 127.0.0.1 uniquement). */
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BobConfig {
  const port = Number(env.BOB_PORT ?? 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`BOB_PORT invalide : ${env.BOB_PORT}`);
  }
  return {
    dataDir: env.BOB_DATA_DIR ?? join(homedir(), "bob-data"),
    port,
  };
}
