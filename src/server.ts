import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import { AuditLog } from "./audit.ts";
import { BrainKind, Sensitivity } from "./brain/schema.ts";
import { BrainStore } from "./brain/store.ts";
import type { LaunchPlan } from "./sandbox/sbx.ts";
import { page } from "./ui.ts";

export interface ServerOptions {
  store: BrainStore;
  audit: AuditLog;
  /** Jeton de session ; généré aléatoirement s'il est absent. */
  token?: string;
  /** Lancement et arrêt d'un brain (proxy + sandbox) ; absent si le proxy n'est pas configuré. */
  launcher?: {
    launch: (brainId: string) => Promise<LaunchPlan>;
    stop: (brainId: string) => Promise<void>;
  };
}

export interface BobServer {
  server: Server;
  token: string;
}

const COOKIE = "bob_session";
const CreateBody = z.object({ kind: BrainKind, slug: z.string().optional(), sensitivity: Sensitivity.optional() });
const IdBody = z.object({ id: z.string() });
const LevelBody = z.object({ id: z.string(), sensitivity: Sensitivity, confirmed: z.boolean() });

export function createBobServer(options: ServerOptions): BobServer {
  const token = options.token ?? randomBytes(32).toString("hex");
  const { store, audit, launcher } = options;

  const server = createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (error) {
      const message = error instanceof Error ? error.message : "erreur interne";
      const status = error instanceof z.ZodError ? 400 : 422;
      send(res, status, { error: error instanceof z.ZodError ? "requête invalide" : message });
    }
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const port = (server.address() as { port: number } | null)?.port;
    if (!allowedHost(req.headers.host, port)) return send(res, 403, { error: "hôte refusé" });
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    // Connexion initiale : /?token=... pose le cookie puis redirige.
    if (req.method === "GET" && url.pathname === "/" && url.searchParams.has("token")) {
      if (!safeEqual(url.searchParams.get("token") ?? "", token)) return send(res, 401, { error: "jeton invalide" });
      res.writeHead(302, {
        "set-cookie": `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        location: "/",
      });
      return void res.end();
    }

    if (!authenticated(req, token)) return send(res, 401, { error: "non authentifié" });

    if (req.method === "POST" || req.method === "PATCH") {
      const origin = req.headers.origin;
      if (origin !== undefined && !allowedHost(new URL(origin).host, port)) {
        return send(res, 403, { error: "origine refusée" });
      }
    }

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
        "cache-control": "no-store",
      });
      return void res.end(page());
    }
    if (req.method === "GET" && url.pathname === "/api/brains") {
      const brains = await store.list();
      return send(res, 200, brains.map((b) => ({ id: b.id, ...b.config, issues: b.issues })));
    }
    if (req.method === "POST" && url.pathname === "/api/brains") {
      const body = CreateBody.parse(await json(req));
      const brain = await store.create(body);
      return send(res, 201, { id: brain.id, ...brain.config, issues: brain.issues });
    }
    if (req.method === "PATCH" && url.pathname === "/api/brains/level") {
      const body = LevelBody.parse(await json(req));
      const brain = await store.setSensitivity(body.id, body.sensitivity, body.confirmed);
      return send(res, 200, { id: brain.id, ...brain.config, issues: brain.issues });
    }
    if (req.method === "POST" && (url.pathname === "/api/launch" || url.pathname === "/api/stop")) {
      if (!launcher) return send(res, 422, { error: "proxy non configuré (BOB_PROXY_DIR, UPSTREAM_API_KEY)" });
      const { id } = IdBody.parse(await json(req));
      await store.load(id); // erreur si l'identifiant est invalide ou le brain inexistant
      if (url.pathname === "/api/stop") {
        await launcher.stop(id);
        return send(res, 200, { stopped: id });
      }
      const plan = await launcher.launch(id);
      return send(res, 200, { sandbox: plan.sandbox, warnings: plan.warnings, command: [plan.attach.cmd, ...plan.attach.args].join(" ") });
    }
    if (req.method === "GET" && url.pathname === "/api/audit") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 500);
      return send(res, 200, await tailAudit(audit, limit));
    }
    return send(res, 404, { error: "introuvable" });
  }

  return { server, token };
}

async function tailAudit(audit: AuditLog, limit: number): Promise<unknown[]> {
  let raw: string;
  try {
    raw = await readFile(audit.path, "utf8");
  } catch {
    return [];
  }
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .map((line) => JSON.parse(line) as unknown)
    .reverse();
}

function allowedHost(host: string | undefined, port: number | undefined): boolean {
  if (!host || port === undefined) return false;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function authenticated(req: IncomingMessage, token: string): boolean {
  const cookie = req.headers.cookie
    ?.split(";")
    .map((c) => c.trim().split("="))
    .find(([name]) => name === COOKIE)?.[1];
  const header = req.headers["x-bob-token"];
  const candidate = cookie ?? (typeof header === "string" ? header : "");
  return safeEqual(candidate, token);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function json(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error("corps trop volumineux");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
