import { execFile } from "node:child_process";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { AuditLog } from "../audit.ts";
import {
  BrainConfig,
  type BrainKind,
  type Sensitivity,
  checkBrainConfig,
  defaultProxyProfile,
  defaultSensitivity,
  type ConfigIssue,
} from "./schema.ts";

const run = promisify(execFile);

const SLUG = /^[a-z0-9][a-z0-9-]{0,40}$/;
const SINGLETONS: BrainKind[] = ["team", "agency", "personal"];

export interface Brain {
  /** `client/<slug>`, `team`, `agency` ou `personal`. */
  id: string;
  dir: string;
  config: BrainConfig;
  issues: ConfigIssue[];
}

export interface CreateBrainInput {
  kind: BrainKind;
  /** Obligatoire pour `client`, interdit pour les autres types. */
  slug?: string;
  name?: string;
  sensitivity?: Sensitivity;
}

export class BrainStore {
  readonly dataDir: string;
  readonly root: string;
  private readonly audit: AuditLog;

  constructor(dataDir: string, audit?: AuditLog) {
    this.dataDir = dataDir;
    this.root = join(dataDir, "brains");
    this.audit = audit ?? new AuditLog(dataDir);
  }

  static idOf(kind: BrainKind, slug?: string): string {
    return kind === "client" ? `client/${slug}` : kind;
  }

  /** Résout un identifiant de brain en dossier ; refuse tout chemin hors de `brains/`. */
  dirOf(id: string): string {
    const parts = id.split("/");
    const [kind, slug] = parts;
    if (kind === "client" && parts.length === 2 && slug && SLUG.test(slug)) {
      return join(this.root, "client", slug);
    }
    if (parts.length === 1 && SINGLETONS.includes(kind as BrainKind)) {
      return join(this.root, kind as string);
    }
    throw new Error(`identifiant de brain invalide : ${id}`);
  }

  async create(input: CreateBrainInput): Promise<Brain> {
    if (input.kind === "client") {
      if (!input.slug || !SLUG.test(input.slug)) {
        throw new Error("slug client invalide (a-z, 0-9, tirets, 41 caractères max)");
      }
    } else if (input.slug !== undefined) {
      throw new Error(`le type ${input.kind} n'a pas de slug`);
    }
    const id = BrainStore.idOf(input.kind, input.slug);
    const dir = this.dirOf(id);
    if (await exists(dir)) throw new Error(`le brain ${id} existe déjà`);

    const sensitivity = input.sensitivity ?? defaultSensitivity(input.kind);
    const config = BrainConfig.parse({
      name: input.name ?? input.slug ?? input.kind,
      kind: input.kind,
      sensitivity,
      proxy: { profile: defaultProxyProfile(sensitivity) },
    });

    await mkdir(join(dir, "missions"), { recursive: true });
    await mkdir(join(dir, "inbox"), { recursive: true });
    await writeFile(join(dir, "brain.yaml"), stringify(config));
    await writeFile(join(dir, "glossary.yaml"), stringify({ entries: [] }));
    await writeFile(join(dir, "AGENTS.md"), contextFile(id, config));
    await writeFile(join(dir, "missions", ".gitkeep"), "");
    await writeFile(join(dir, "inbox", ".gitkeep"), "");
    await git(dir, "init", "-q", "-b", "main");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", `chore: crée le brain ${id}`);

    await this.audit.record("brain.created", id, { kind: input.kind, sensitivity });
    return { id, dir, config, issues: checkBrainConfig(config) };
  }

  async load(id: string): Promise<Brain> {
    const dir = this.dirOf(id);
    const raw = await readFile(join(dir, "brain.yaml"), "utf8");
    const config = BrainConfig.parse(parse(raw));
    return { id, dir, config, issues: checkBrainConfig(config) };
  }

  async list(): Promise<Brain[]> {
    const ids: string[] = [];
    for (const kind of SINGLETONS) {
      if (await exists(join(this.root, kind, "brain.yaml"))) ids.push(kind);
    }
    const clientsDir = join(this.root, "client");
    if (await exists(clientsDir)) {
      for (const slug of (await readdir(clientsDir)).sort()) {
        if (SLUG.test(slug) && (await exists(join(clientsDir, slug, "brain.yaml")))) {
          ids.push(`client/${slug}`);
        }
      }
    }
    return Promise.all(ids.map((id) => this.load(id)));
  }

  /** Change le niveau d'un brain ; journalisé, confirmation exigée par l'appelant. */
  async setSensitivity(id: string, sensitivity: Sensitivity, confirmed: boolean): Promise<Brain> {
    if (!confirmed) throw new Error("changement de niveau : confirmation explicite requise");
    const brain = await this.load(id);
    const previous = brain.config.sensitivity;
    const config = BrainConfig.parse({
      ...brain.config,
      sensitivity,
      proxy: { profile: defaultProxyProfile(sensitivity) },
    });
    await writeFile(join(brain.dir, "brain.yaml"), stringify(config));
    await git(brain.dir, "add", "brain.yaml");
    await git(brain.dir, "commit", "-q", "-m", `chore: niveau ${previous} -> ${sensitivity}`);
    await this.audit.record("brain.level_changed", id, { from: previous, to: sensitivity });
    return { id, dir: brain.dir, config, issues: checkBrainConfig(config) };
  }
}

function contextFile(id: string, config: BrainConfig): string {
  return `# Brain ${id}

Niveau : ${config.sensitivity} (proxy : ${config.proxy.profile}).

Règles pour l'agent :
- Ne travaille que dans ce dossier ; ne cherche pas d'autres brains ni de données d'autres clients.
- Les valeurs sensibles peuvent apparaître sous forme de jetons (\`[[PERSON_1]]\`) : ne les « corrige » pas.
- Les imports bruts sont dans \`inbox/\` ; classe-les dans \`missions/\` après validation de Romain.
- N'envoie aucun mail et ne crée aucun événement sans confirmation explicite.
`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await run("git", ["-c", "user.name=Bob", "-c", "user.email=bob@localhost", ...args], { cwd });
}
