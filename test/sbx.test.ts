import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit.ts";
import { BrainStore } from "../src/brain/store.ts";
import {
  DIRECT_LLM_HOSTS,
  buildOpencodeConfig,
  checkNetworkPolicy,
  denyCommands,
  launchBrain,
  LaunchBlockedError,
  sandboxName,
  type Runner,
} from "../src/sandbox/sbx.ts";

const DENIED = "  Denied:      x:443\n  Context:     global\n  Reason:      no matching allow rule (default deny)\n";
const DENIED_EXPLICIT = '  Denied:      x:443\n  Context:     global\n  Reason:      denied by local rule rule "local:abc"\n';
const ALLOWED = "  Allowed:     x:443\n  Context:     global\n  Rule:        abc\n";

interface Call {
  args: string[];
  input?: string;
}

function fakeRunner(
  policy: (target: string) => string,
  existing = "",
  probe: (host: string) => string = () => "403",
): { run: Runner; calls: Call[] } {
  const calls: Call[] = [];
  const run: Runner = async (_cmd, args, options) => {
    const call: Call = { args };
    if (options?.input !== undefined) call.input = options.input;
    calls.push(call);
    if (args[0] === "policy") {
      const stdout = policy(args[3] ?? "");
      return { code: stdout.includes("Denied:") ? 1 : 0, stdout, stderr: "" }; // comme le vrai sbx
    }
    if (args[0] === "exec" && args.includes("sh")) {
      const stdout = DIRECT_LLM_HOSTS.map((t) => t.split(":")[0] ?? t).map((h) => `${h} ${probe(h)}`).join("\n");
      return { code: 0, stdout, stderr: "" };
    }
    if (args[0] === "ls") return { code: 0, stdout: existing, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

const lockedDown = (target: string) => (target.startsWith("localhost:") ? ALLOWED : DENIED_EXPLICIT);

let dir: string;
let audit: AuditLog;
let store: BrainStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bob-sbx-"));
  audit = new AuditLog(dir);
  store = new BrainStore(dir, audit);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("checkNetworkPolicy", () => {
  it("accepte deny-all + proxy local autorisé", async () => {
    expect((await checkNetworkPolicy(fakeRunner(lockedDown).run, 8000)).ok).toBe(true);
  });

  it("exige un refus explicite : le refus par défaut est contourné par les règles du kit", async () => {
    const result = await checkNetworkPolicy(fakeRunner((x) => (x.startsWith("localhost:") ? ALLOWED : DENIED)).run, 8000);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/refus explicite manquant pour \d+ hôte/);
  });

  it("refuse si une API LLM directe est joignable", async () => {
    const result = await checkNetworkPolicy(fakeRunner(() => ALLOWED).run, 8000);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/api\.anthropic\.com:443 est autorisé/);
  });

  it("échoue fermé si la sortie est illisible ou si le proxy n'est pas autorisé", async () => {
    expect((await checkNetworkPolicy(fakeRunner(() => "???").run, 8000)).ok).toBe(false);
    const noProxy = await checkNetworkPolicy(fakeRunner(() => DENIED_EXPLICIT).run, 8000);
    expect(noProxy.problems.join("\n")).toMatch(/proxy local n'est pas autorisé/);
  });
});

describe("launchBrain", () => {
  it("crée le sandbox, fournit le jeton par stdin et copie la config sans le vrai jeton", async () => {
    const brain = await store.create({ kind: "client", slug: "acme" });
    const { run, calls } = fakeRunner(lockedDown);
    const plan = await launchBrain({ brain, run, audit, proxyPort: 8000, proxyToken: "REAL-TOKEN", model: "m" });

    expect(plan.sandbox).toBe("bob-client-acme");
    expect(plan.attach.args).toEqual(["exec", "-it", "-w", brain.dir, "bob-client-acme", "opencode", "--model", "bobproxy/m"]);
    const create = calls.find((c) => c.args[0] === "create");
    expect(create?.args).toEqual(["create", "--name", "bob-client-acme", "opencode", brain.dir]);
    const secret = calls.find((c) => c.args[0] === "secret");
    expect(secret?.input).toBe("REAL-TOKEN");
    expect(calls.flatMap((c) => c.args).join(" ")).not.toContain("REAL-TOKEN");
    expect(secret?.args).toContain("--value-stdin");

    const events = (await readFile(audit.path, "utf8")).trim().split("\n").map((l) => JSON.parse(l).event);
    expect(events).toEqual(["brain.created", "launch.started"]);
    expect(plan.warnings).toEqual([]);
  });

  it("bloque le lancement si la sonde atteint un hôte malgré la politique", async () => {
    const brain = await store.create({ kind: "client", slug: "acme" });
    const { run } = fakeRunner(lockedDown, "", (host) => (host === "api.anthropic.com" ? "401" : "403"));
    await expect(launchBrain({ brain, run, audit, proxyPort: 8000, proxyToken: "t", model: "m" })).rejects.toThrow(/api\.anthropic\.com/);
    expect(await readFile(audit.path, "utf8")).toContain("policy.bypass_observed");
  });

  it("réutilise un sandbox existant", async () => {
    const brain = await store.create({ kind: "client", slug: "acme" });
    const { run, calls } = fakeRunner(lockedDown, "bob-client-acme  running\n");
    await launchBrain({ brain, run, audit, proxyPort: 8000, proxyToken: "t", model: "m" });
    expect(calls.some((c) => c.args[0] === "create")).toBe(false);
  });

  it("bloque un brain forbidden sans toucher à sbx, et journalise", async () => {
    const brain = await store.create({ kind: "team", sensitivity: "forbidden" });
    const { run, calls } = fakeRunner(lockedDown);
    await expect(launchBrain({ brain, run, audit, proxyPort: 8000, proxyToken: "t", model: "m" })).rejects.toBeInstanceOf(LaunchBlockedError);
    expect(calls).toHaveLength(0);
    expect(await readFile(audit.path, "utf8")).toContain("launch.blocked");
  });

  it("bloque si la politique réseau laisse passer une API LLM", async () => {
    const brain = await store.create({ kind: "client", slug: "acme" });
    const { run, calls } = fakeRunner(() => ALLOWED);
    await expect(launchBrain({ brain, run, audit, proxyPort: 8000, proxyToken: "t", model: "m" })).rejects.toThrow(/est autorisé/);
    expect(calls.some((c) => c.args[0] === "create")).toBe(false);
    expect(await readFile(audit.path, "utf8")).toContain("policy.check_failed");
  });
});

describe("helpers", () => {
  it("génère une commande de refus par règle, jokers inclus", () => {
    const commands = denyCommands();
    expect(commands).toContain("sbx policy deny network 'api.anthropic.com:443'");
    expect(commands).toContain("sbx policy deny network '*.githubusercontent.com:443'");
    expect(commands.every((c) => c.startsWith("sbx policy deny network '"))).toBe(true);
  });

  it("nomme les sandboxes et construit la config opencode", () => {
    expect(sandboxName("client/acme")).toBe("bob-client-acme");
    expect(sandboxName("team")).toBe("bob-team");
    const config = buildOpencodeConfig({ proxyPort: 8000, placeholder: "bobtok-x", model: "m" }) as {
      provider: { bobproxy: { options: { baseURL: string; apiKey: string } } };
    };
    expect(config.provider.bobproxy.options).toEqual({ baseURL: "http://host.docker.internal:8000/v1", apiKey: "bobtok-x" });
  });
});
