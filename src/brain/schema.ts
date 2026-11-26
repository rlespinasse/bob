import { z } from "zod";

export const BrainKind = z.enum(["client", "team", "agency", "personal"]);
export type BrainKind = z.infer<typeof BrainKind>;

/** Niveau de sensibilité du brain entier (SPEC §4). */
export const Sensitivity = z.enum(["open", "restricted", "forbidden"]);
export type Sensitivity = z.infer<typeof Sensitivity>;

/** Profil de sévérité du proxy d'anonymisation. */
export const ProxyProfile = z.enum(["open", "standard", "strict"]);
export type ProxyProfile = z.infer<typeof ProxyProfile>;

export const Connector = z.enum(["mail", "calendar", "drive"]);
export type Connector = z.infer<typeof Connector>;

export const BrainConfig = z.object({
  name: z.string().min(1),
  kind: BrainKind,
  sensitivity: Sensitivity,
  engine: z.enum(["opencode", "claude-code"]).default("opencode"),
  proxy: z.object({ profile: ProxyProfile }),
  sandbox: z
    .object({
      network: z.literal("deny-all").default("deny-all"),
      workspace: z.enum(["direct", "clone"]).default("direct"),
      extra_mounts: z.array(z.string()).default([]),
    })
    .default({ network: "deny-all", workspace: "direct", extra_mounts: [] }),
  /** Chiffrement du volume : prévu au jalon M3, non implémenté en M1. */
  encryption: z.boolean().default(false),
  connectors: z
    .object({
      enabled: z.array(Connector).default([]),
      note: z.string().optional(),
      account: z.string().default("agency"),
    })
    .default({ enabled: [], account: "agency" }),
  anonymize: z
    .object({ allowlist: z.array(z.string()).default([]) })
    .default({ allowlist: [] }),
});
export type BrainConfig = z.infer<typeof BrainConfig>;

/** Profil du proxy déduit du niveau (SPEC §4). */
export function defaultProxyProfile(sensitivity: Sensitivity): ProxyProfile {
  return sensitivity === "open" ? "open" : "strict";
}

/** Niveau par défaut selon le type de brain : tout démarre en `restricted` (SPEC §4). */
export function defaultSensitivity(_kind: BrainKind): Sensitivity {
  return "restricted";
}

export interface ConfigIssue {
  level: "error" | "warning";
  message: string;
}

/** Cohérence d'une configuration : avertissements, jamais de refus sur les connecteurs (SPEC §5). */
export function checkBrainConfig(config: BrainConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  if (config.sensitivity === "forbidden" && config.connectors.enabled.length > 0) {
    issues.push({
      level: "warning",
      message: "connecteur activé sur un brain `forbidden` (aucun appel LLM prévu) : confirmation requise",
    });
  }
  if (config.sensitivity === "restricted" && config.connectors.enabled.length > 0) {
    issues.push({
      level: "warning",
      message: "les données lues via les connecteurs peuvent contourner le proxy d'anonymisation",
    });
  }
  if (config.sensitivity === "forbidden" && config.engine !== "opencode") {
    issues.push({ level: "warning", message: "`forbidden` : aucun agent ne sera lancé" });
  }
  if (config.sandbox.extra_mounts.some((m) => !m.endsWith(":ro"))) {
    issues.push({ level: "error", message: "les montages supplémentaires doivent se terminer par `:ro`" });
  }
  return issues;
}
