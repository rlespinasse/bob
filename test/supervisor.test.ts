import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrainStore } from "../src/brain/store.ts";
import { ProxySupervisor } from "../src/proxy/supervisor.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-proxy.mjs");

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

let dir: string;
let store: BrainStore;
let proxy: ProxySupervisor;
let port: number;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bob-proxy-"));
  store = new BrainStore(dir);
  port = await freePort();
  proxy = new ProxySupervisor({
    cwd: dir,
    command: ["node", FAKE],
    port,
    upstreamApiKey: "UP-KEY",
    baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME, OTHER_SECRET: "must-not-leak" },
    startTimeoutMs: 10_000,
  });
});
afterEach(async () => {
  await proxy.stop();
  await rm(dir, { recursive: true, force: true });
});

const env = async () => (await (await fetch(`http://127.0.0.1:${port}/env`)).json()) as Record<string, string | null>;

describe("ProxySupervisor", () => {
  it("démarre le proxy avec le profil et le glossaire du brain, sans fuite d'environnement", async () => {
    const brain = await store.create({ kind: "client", slug: "acme" });
    const running = await proxy.start(brain);
    expect(running).toMatchObject({ brainId: "client/acme", port });
    const seen = await env();
    expect(seen.PROFILE).toBe("strict");
    expect(seen.GLOSSARY_PATH).toBe(join(brain.dir, "glossary.yaml"));
    expect(seen.LOCAL_TOKEN).toBe(running.token);
    expect(seen.OTHER_SECRET).toBeNull();
  });

  it("redémarre avec un nouveau jeton quand on change de brain", async () => {
    const a = await store.create({ kind: "client", slug: "acme" });
    const b = await store.create({ kind: "client", slug: "beta", sensitivity: "open" });
    const first = await proxy.start(a);
    expect(await proxy.start(a)).toBe(first); // même brain : pas de redémarrage
    const second = await proxy.start(b);
    expect(second.token).not.toBe(first.token);
    expect((await env()).PROFILE).toBe("open");
  });

  it("refuse un brain forbidden ou une clé amont absente", async () => {
    const forbidden = await store.create({ kind: "team", sensitivity: "forbidden" });
    await expect(proxy.start(forbidden)).rejects.toThrow(/forbidden/);
    const noKey = new ProxySupervisor({ cwd: dir, command: ["node", FAKE], port, upstreamApiKey: "" });
    const brain = await store.create({ kind: "client", slug: "acme" });
    await expect(noKey.start(brain)).rejects.toThrow(/clé amont/);
  });

  it("signale un proxy qui ne démarre pas", async () => {
    const broken = new ProxySupervisor({
      cwd: dir,
      command: ["node", "-e", "console.error('boom'); process.exit(3)"],
      port,
      upstreamApiKey: "k",
      startTimeoutMs: 5000,
    });
    const brain = await store.create({ kind: "client", slug: "acme" });
    await expect(broken.start(brain)).rejects.toThrow(/code 3.*boom/);
  });

  it("arrête le proxy", async () => {
    const brain = await store.create({ kind: "client", slug: "acme" });
    await proxy.start(brain);
    await proxy.stop();
    expect(proxy.running).toBeUndefined();
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });
});
