import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../audit.ts";
import type { Brain } from "../brain/store.ts";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Runner = (cmd: string, args: string[], options?: { input?: string }) => Promise<RunResult>;

/** Exécute une commande ; `input` passe par stdin (jamais en argument, pour ne pas exposer de secret). */
export const systemRunner: Runner = (cmd, args, options) =>
  new Promise((resolve, reject) => {
    if (options?.input === undefined) {
      execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") return reject(error);
        resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
      });
      return;
    }
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    child.stderr.on("data", (d: Buffer) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(options.input);
  });

/** API LLM qui doivent rester injoignables depuis un sandbox (le trafic passe par le proxy). */
export const DIRECT_LLM_HOSTS = [
  "api.anthropic.com:443",
  "api.openai.com:443",
  "generativelanguage.googleapis.com:443",
];

export interface PolicyCheck {
  ok: boolean;
  problems: string[];
}

/** `sbx policy check network` : ligne `Allowed:` (code 0) ou `Denied:` (code 1) ; le reste est illisible. */
async function isAllowed(run: Runner, target: string): Promise<boolean | undefined> {
  const res = await run("sbx", ["policy", "check", "network", target]);
  if (/^\s*Denied:/m.test(res.stdout)) return false;
  if (/^\s*Allowed:/m.test(res.stdout)) return true;
  return undefined;
}

/** Fail closed : un résultat non reconnu compte comme un échec. */
export async function checkNetworkPolicy(run: Runner, proxyPort: number): Promise<PolicyCheck> {
  const problems: string[] = [];
  for (const host of DIRECT_LLM_HOSTS) {
    const allowed = await isAllowed(run, host);
    if (allowed === undefined) problems.push(`politique illisible pour ${host}`);
    else if (allowed) {
      problems.push(`${host} est joignable directement : lancer \`sbx policy reset\` puis \`sbx policy init deny-all\``);
    }
  }
  const proxy = await isAllowed(run, `localhost:${proxyPort}`);
  if (proxy !== true) {
    problems.push(`le proxy local n'est pas autorisé : \`sbx policy allow network localhost:${proxyPort}\``);
  }
  return { ok: problems.length === 0, problems };
}

export function sandboxName(brainId: string): string {
  return `bob-${brainId.replace("/", "-")}`;
}

export interface OpencodeConfigInput {
  proxyPort: number;
  /** Placeholder du jeton local (jamais le vrai jeton). */
  placeholder: string;
  model: string;
}

export function buildOpencodeConfig(input: OpencodeConfigInput): Record<string, unknown> {
  return {
    $schema: "https://opencode.ai/config.json",
    model: `bobproxy/${input.model}`,
    provider: {
      bobproxy: {
        npm: "@ai-sdk/openai-compatible",
        name: "Bob proxy",
        options: {
          baseURL: `http://host.docker.internal:${input.proxyPort}/v1`,
          apiKey: input.placeholder,
        },
        models: { [input.model]: { name: input.model } },
      },
    },
  };
}

export interface LaunchInput {
  brain: Brain;
  run: Runner;
  audit: AuditLog;
  proxyPort: number;
  /** Jeton local du proxy ; transmis à `sbx` par stdin, jamais écrit sur disque. */
  proxyToken: string;
  model: string;
}

export interface LaunchPlan {
  sandbox: string;
  /** Écarts constatés qui n'empêchent pas le lancement (ex. contournement de politique par sbx). */
  warnings: string[];
  /** Commande à attacher à un terminal pour la session interactive. */
  attach: { cmd: string; args: string[] };
}

export class LaunchBlockedError extends Error {}

/**
 * Sonde comportementale : `sbx policy check` annonce « refusé », mais sbx 0.54.0 laisse passer
 * (« forward-bypass ») le trafic vers les API des fournisseurs IA. On teste donc depuis le sandbox.
 * Retourne les hôtes réellement joignables ; un code HTTP (pas 000/403 proxy) prouve la connexion.
 */
export async function probeDirectAccess(run: Runner, sandbox: string): Promise<string[]> {
  const reachable: string[] = [];
  for (const target of DIRECT_LLM_HOSTS) {
    const host = target.split(":")[0] ?? target;
    const res = await run("sbx", [
      "exec", sandbox, "curl", "-s", "-m", "8", "-o", "/dev/null", "-w", "%{http_code}", `https://${host}/`,
    ]);
    const code = res.stdout.trim();
    if (/^[1-5]\d\d$/.test(code) && code !== "403") reachable.push(host);
  }
  return reachable;
}

export async function launchBrain(input: LaunchInput): Promise<LaunchPlan> {
  const { brain, run, audit } = input;
  const sandbox = sandboxName(brain.id);

  const block = async (reason: string, event: "launch.blocked" | "policy.check_failed" = "launch.blocked") => {
    await audit.record(event, brain.id, { reason });
    throw new LaunchBlockedError(reason);
  };

  if (brain.config.sensitivity === "forbidden") return block("brain `forbidden` : aucun agent");
  if (brain.config.engine !== "opencode") return block(`moteur ${brain.config.engine} non pris en charge en v1`);
  if (brain.issues.some((i) => i.level === "error")) return block("configuration du brain invalide");

  const policy = await checkNetworkPolicy(run, input.proxyPort);
  if (!policy.ok) return block(policy.problems.join(" ; "), "policy.check_failed");

  const mounts = [brain.dir, ...brain.config.sandbox.extra_mounts];
  const list = await run("sbx", ["ls"]);
  const exists = new RegExp(`(^|\\s)${sandbox}(\\s|$)`, "m").test(list.stdout);
  if (!exists) {
    const created = await run("sbx", ["create", "--name", sandbox, "opencode", ...mounts]);
    if (created.code !== 0) throw new Error(`sbx create a échoué : ${created.stderr.trim()}`);
  }

  // Le jeton local reste côté hôte : le sandbox ne voit qu'un placeholder, remplacé dans les en-têtes.
  const placeholder = `bobtok-${randomBytes(12).toString("hex")}`;
  const secret = await run(
    "sbx",
    [
      "secret", "set-custom", "--sandbox", sandbox,
      "--host", "localhost", "--host", "host.docker.internal",
      "--placeholder", placeholder, "--value-stdin",
    ],
    { input: input.proxyToken },
  );
  if (secret.code !== 0) throw new Error(`sbx secret set-custom a échoué : ${secret.stderr.trim()}`);

  const tmp = await mkdtemp(join(tmpdir(), "bob-oc-"));
  try {
    const file = join(tmp, "opencode.json");
    await writeFile(file, JSON.stringify(buildOpencodeConfig({ ...input, placeholder }), null, 2), { mode: 0o644 }); // lisible par l'agent dans la VM ; ne contient que le placeholder
    const copied = await run("sbx", ["cp", file, `${sandbox}:/home/agent/.config/opencode/opencode.json`]);
    if (copied.code !== 0) throw new Error(`sbx cp a échoué : ${copied.stderr.trim()}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  const warnings: string[] = [];
  const bypass = await probeDirectAccess(run, sandbox);
  if (bypass.length > 0) {
    warnings.push(
      `sbx laisse joindre directement ${bypass.join(", ")} malgré la politique : ne jamais placer de vraie clé API dans ce sandbox`,
    );
    await audit.record("policy.bypass_observed", brain.id, { hosts: bypass.join(",") });
  }

  await audit.record("launch.started", brain.id, {
    sandbox,
    engine: "opencode",
    proxy_profile: brain.config.proxy.profile,
    connectors: brain.config.connectors.enabled.join(",") || "none",
  });
  return { sandbox, warnings, attach: { cmd: "sbx", args: ["exec", "-it", "-w", brain.dir, sandbox, "opencode", "--model", `bobproxy/${input.model}`] } };
}

export async function stopBrain(run: Runner, audit: AuditLog, brainId: string): Promise<void> {
  const res = await run("sbx", ["stop", sandboxName(brainId)]);
  if (res.code !== 0) throw new Error(`sbx stop a échoué : ${res.stderr.trim()}`);
  await audit.record("brain.closed", brainId, {});
}
