import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit.ts";
import { BrainConfig, checkBrainConfig } from "../src/brain/schema.ts";
import { BrainStore } from "../src/brain/store.ts";

let dir: string;
let store: BrainStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bob-test-"));
  store = new BrainStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("BrainStore", () => {
  it("crée un brain client restricted/strict avec git, glossaire et inbox", async () => {
    const brain = await store.create({ kind: "client", slug: "acme" });
    expect(brain.id).toBe("client/acme");
    expect(brain.config.sensitivity).toBe("restricted");
    expect(brain.config.proxy.profile).toBe("strict");
    expect(brain.config.engine).toBe("opencode");
    const log = execFileSync("git", ["log", "--oneline"], { cwd: brain.dir }).toString();
    expect(log).toContain("crée le brain client/acme");
    expect(await readFile(join(brain.dir, "glossary.yaml"), "utf8")).toContain("entries");
    // Un exemple de jeton littéral dans le contexte serait lui-même pseudonymisé par le proxy.
    expect(await readFile(join(brain.dir, "AGENTS.md"), "utf8")).not.toMatch(/\[\[[A-Z_]+_\d+\]\]/);
  });

  it("crée les brains singletons et les liste dans l'ordre", async () => {
    await store.create({ kind: "client", slug: "zeta" });
    await store.create({ kind: "client", slug: "acme" });
    await store.create({ kind: "team" });
    await store.create({ kind: "agency" });
    expect((await store.list()).map((b) => b.id)).toEqual(["team", "agency", "client/acme", "client/zeta"]);
  });

  it("refuse les doublons, slugs invalides et traversées de chemin", async () => {
    await store.create({ kind: "client", slug: "acme" });
    await expect(store.create({ kind: "client", slug: "acme" })).rejects.toThrow(/existe déjà/);
    await expect(store.create({ kind: "client", slug: "../evil" })).rejects.toThrow(/slug/);
    await expect(store.create({ kind: "client" })).rejects.toThrow(/slug/);
    await expect(store.create({ kind: "team", slug: "x" })).rejects.toThrow(/pas de slug/);
    expect(() => store.dirOf("client/../../etc")).toThrow(/invalide/);
    expect(() => store.dirOf("..")).toThrow(/invalide/);
  });

  it("change le niveau seulement avec confirmation et journalise sans contenu", async () => {
    const brain = await store.create({ kind: "client", slug: "acme" });
    await expect(store.setSensitivity(brain.id, "open", false)).rejects.toThrow(/confirmation/);
    const updated = await store.setSensitivity(brain.id, "open", true);
    expect(updated.config.proxy.profile).toBe("open");
    const lines = (await readFile(new AuditLog(dir).path, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.event)).toEqual(["brain.created", "brain.level_changed"]);
    expect(lines[1].details).toEqual({ from: "restricted", to: "open" });
  });
});

describe("checkBrainConfig", () => {
  const base = BrainConfig.parse({
    name: "x",
    kind: "client",
    sensitivity: "restricted",
    proxy: { profile: "strict" },
  });

  it("avertit sans refuser pour un connecteur sur restricted/forbidden", () => {
    const restricted = checkBrainConfig({ ...base, connectors: { ...base.connectors, enabled: ["mail"] } });
    expect(restricted.map((i) => i.level)).toEqual(["warning"]);
    const forbidden = checkBrainConfig({
      ...base,
      sensitivity: "forbidden",
      connectors: { ...base.connectors, enabled: ["mail"] },
    });
    expect(forbidden.every((i) => i.level === "warning")).toBe(true);
  });

  it("exige des montages supplémentaires en lecture seule", () => {
    const issues = checkBrainConfig({ ...base, sandbox: { ...base.sandbox, extra_mounts: ["/tmp/a"] } });
    expect(issues).toEqual([expect.objectContaining({ level: "error" })]);
  });
});

describe("AuditLog", () => {
  it("refuse les valeurs non scalaires (pas de contenu dans l'audit)", async () => {
    const audit = new AuditLog(dir);
    await expect(audit.record("export", "team", { x: { secret: "y" } as never })).rejects.toThrow(/scalaire/);
  });
});
