import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit.ts";
import { BrainStore } from "../src/brain/store.ts";
import { createBobServer, type BobServer } from "../src/server.ts";

let dir: string;
let bob: BobServer;
let base: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bob-srv-"));
  const audit = new AuditLog(dir);
  bob = createBobServer({ store: new BrainStore(dir, audit), audit, token: "t".repeat(64) });
  await new Promise<void>((resolve) => bob.server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(bob.server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise((resolve) => bob.server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

const auth = () => ({ "x-bob-token": bob.token, "content-type": "application/json" });

describe("serveur local", () => {
  it("refuse sans jeton et avec un mauvais jeton", async () => {
    expect((await fetch(`${base}/api/brains`)).status).toBe(401);
    expect((await fetch(`${base}/api/brains`, { headers: { "x-bob-token": "x" } })).status).toBe(401);
    expect((await fetch(`${base}/?token=nope`, { redirect: "manual" })).status).toBe(401);
  });

  it("pose un cookie HttpOnly sur /?token= valide", async () => {
    const res = await fetch(`${base}/?token=${bob.token}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Strict/);
  });

  it("refuse un Host inattendu (rebinding DNS) et une origine étrangère", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        `${base}/api/brains`,
        { headers: { "x-bob-token": bob.token, host: "evil.example:80" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
    const origin = await fetch(`${base}/api/brains`, {
      method: "POST",
      headers: { ...auth(), origin: "http://evil.example" },
      body: JSON.stringify({ kind: "team" }),
    });
    expect(origin.status).toBe(403);
  });

  it("crée, liste et change le niveau d'un brain, avec audit", async () => {
    const created = await fetch(`${base}/api/brains`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ kind: "client", slug: "acme" }),
    });
    expect(created.status).toBe(201);
    const list = (await (await fetch(`${base}/api/brains`, { headers: auth() })).json()) as { id: string }[];
    expect(list.map((b) => b.id)).toEqual(["client/acme"]);

    const refused = await fetch(`${base}/api/brains/level`, {
      method: "PATCH",
      headers: auth(),
      body: JSON.stringify({ id: "client/acme", sensitivity: "open", confirmed: false }),
    });
    expect(refused.status).toBe(422);
    const ok = await fetch(`${base}/api/brains/level`, {
      method: "PATCH",
      headers: auth(),
      body: JSON.stringify({ id: "client/acme", sensitivity: "open", confirmed: true }),
    });
    expect(ok.status).toBe(200);

    const audit = (await (await fetch(`${base}/api/audit`, { headers: auth() })).json()) as { event: string }[];
    expect(audit.map((a) => a.event)).toEqual(["brain.level_changed", "brain.created"]);
  });

  it("valide les entrées", async () => {
    const res = await fetch(`${base}/api/brains`, { method: "POST", headers: auth(), body: JSON.stringify({ kind: "nope" }) });
    expect(res.status).toBe(400);
    const bad = await fetch(`${base}/api/brains`, { method: "POST", headers: auth(), body: JSON.stringify({ kind: "client", slug: "../x" }) });
    expect(bad.status).toBe(422);
  });

  it("sert la page avec une CSP", async () => {
    const res = await fetch(`${base}/`, { headers: auth() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await res.text()).toContain("Bob · second brains");
  });

  it("refuse de lancer sans proxy configuré, et lance via le launcher injecté", async () => {
    await fetch(`${base}/api/brains`, { method: "POST", headers: auth(), body: JSON.stringify({ kind: "client", slug: "acme" }) });
    const none = await fetch(`${base}/api/launch`, { method: "POST", headers: auth(), body: JSON.stringify({ id: "client/acme" }) });
    expect(none.status).toBe(422);

    const calls: string[] = [];
    const audit = new AuditLog(dir);
    const withLauncher = createBobServer({
      store: new BrainStore(dir, audit),
      audit,
      token: bob.token,
      launcher: {
        launch: async (id) => {
          calls.push(`launch:${id}`);
          return { sandbox: "bob-client-acme", attach: { cmd: "sbx", args: ["exec", "bob-client-acme"] } };
        },
        stop: async (id) => void calls.push(`stop:${id}`),
      },
    });
    await new Promise<void>((resolve) => withLauncher.server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(withLauncher.server.address() as AddressInfo).port}`;
    const ok = await fetch(`${url}/api/launch`, { method: "POST", headers: auth(), body: JSON.stringify({ id: "client/acme" }) });
    expect(await ok.json()).toEqual({ sandbox: "bob-client-acme", command: "sbx exec bob-client-acme" });
    const stop = await fetch(`${url}/api/stop`, { method: "POST", headers: auth(), body: JSON.stringify({ id: "client/acme" }) });
    expect(stop.status).toBe(200);
    const missing = await fetch(`${url}/api/launch`, { method: "POST", headers: auth(), body: JSON.stringify({ id: "client/ghost" }) });
    expect(missing.status).toBe(422);
    expect(calls).toEqual(["launch:client/acme", "stop:client/acme"]);
    await new Promise((resolve) => withLauncher.server.close(resolve));
  });
});
