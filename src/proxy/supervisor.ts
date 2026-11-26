import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Brain } from "../brain/store.ts";

export interface ProxyOptions {
  /** Dossier du proxy d'anonymisation (hors de ce dépôt). */
  cwd: string;
  /** Commande de lancement ; par défaut `uv run --frozen privacy-llm-proxy`. */
  command?: string[];
  port?: number;
  /** Clé amont : lue dans l'environnement de Bob, jamais écrite sur disque ni journalisée. */
  upstreamApiKey: string;
  upstreamBaseUrl?: string;
  /** Variables d'environnement transmises en plus de PATH et HOME (liste blanche). */
  baseEnv?: NodeJS.ProcessEnv;
  startTimeoutMs?: number;
}

export interface RunningProxy {
  brainId: string;
  port: number;
  /** Jeton local généré par Bob pour ce démarrage ; à fournir à `sbx secret set-custom`. */
  token: string;
}

/**
 * Une instance du proxy à la fois, liée au brain actif (SPEC §2 : un seul brain actif).
 * Changer de brain redémarre le proxy : mapping en RAM effacé, glossaire et profil du nouveau brain.
 */
export class ProxySupervisor {
  private child: ChildProcess | undefined;
  private current: RunningProxy | undefined;
  private readonly options: ProxyOptions;

  constructor(options: ProxyOptions) {
    this.options = options;
  }

  get running(): RunningProxy | undefined {
    return this.current;
  }

  async start(brain: Brain): Promise<RunningProxy> {
    if (brain.config.sensitivity === "forbidden") throw new Error("brain `forbidden` : pas de proxy");
    if (!this.options.upstreamApiKey) throw new Error("clé amont absente (UPSTREAM_API_KEY)");
    if (this.current?.brainId === brain.id && this.child && this.child.exitCode === null) return this.current;
    await this.stop();

    const port = this.options.port ?? 8000;
    const token = randomBytes(32).toString("hex");
    const base = this.options.baseEnv ?? process.env;
    const env: NodeJS.ProcessEnv = {
      PATH: base.PATH ?? "",
      HOME: base.HOME ?? "",
      UPSTREAM_API_KEY: this.options.upstreamApiKey,
      LOCAL_TOKEN: token,
      BIND_PORT: String(port),
      PROFILE: brain.config.proxy.profile,
      GLOSSARY_PATH: join(brain.dir, "glossary.yaml"),
      EXCLUDE_TERMS: brain.config.anonymize.allowlist.join(","),
      SESSION_HEADERS: "x-opencode-session,x-session-id",
      BLOCK_UNSUPPORTED_LANGUAGE: String(brain.config.proxy.profile === "strict"),
    };
    if (this.options.upstreamBaseUrl) env.UPSTREAM_BASE_URL = this.options.upstreamBaseUrl;

    const [cmd = "uv", ...args] = this.options.command ?? ["uv", "run", "--frozen", "privacy-llm-proxy"];
    const child = spawn(cmd, args, { cwd: this.options.cwd, env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => (stderr = (stderr + d).slice(-2000)));
    this.child = child;

    try {
      await waitHealthy(port, child, this.options.startTimeoutMs ?? 60_000);
    } catch (error) {
      await this.stop();
      const detail = stderr.trim().split("\n").slice(-3).join(" | ");
      throw new Error(`${error instanceof Error ? error.message : "démarrage du proxy échoué"}${detail ? ` : ${detail}` : ""}`);
    }
    this.current = { brainId: brain.id, port, token };
    return this.current;
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.current = undefined;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
}

async function waitHealthy(port: number, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`le proxy s'est arrêté (code ${child.exitCode})`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // pas encore prêt
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("le proxy n'a pas répondu à /health dans le délai imparti");
}
