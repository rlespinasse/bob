import { AuditLog } from "./audit.ts";
import { BrainStore } from "./brain/store.ts";
import { loadConfig } from "./config.ts";
import { ProxySupervisor } from "./proxy/supervisor.ts";
import { launchBrain, stopBrain, systemRunner } from "./sandbox/sbx.ts";
import { createBobServer, type ServerOptions } from "./server.ts";

const env = process.env;
const config = loadConfig(env);
const audit = new AuditLog(config.dataDir);
const store = new BrainStore(config.dataDir, audit);

// Le proxy d'anonymisation vit hors de ce dépôt : BOB_PROXY_DIR + UPSTREAM_API_KEY l'activent.
const proxyDir = env.BOB_PROXY_DIR;
const upstreamApiKey = env.UPSTREAM_API_KEY ?? "";
const proxyPort = Number(env.BOB_PROXY_PORT ?? 8000);
const model = env.BOB_MODEL ?? "default";

let launcher: ServerOptions["launcher"];
if (proxyDir && upstreamApiKey) {
  const proxyOptions: ConstructorParameters<typeof ProxySupervisor>[0] = { cwd: proxyDir, port: proxyPort, upstreamApiKey };
  if (env.UPSTREAM_BASE_URL) proxyOptions.upstreamBaseUrl = env.UPSTREAM_BASE_URL;
  const proxy = new ProxySupervisor(proxyOptions);
  launcher = {
    async launch(id) {
      const brain = await store.load(id);
      // Un seul brain actif à la fois : changer de brain redémarre le proxy (mapping effacé).
      const running = await proxy.start(brain);
      return launchBrain({ brain, run: systemRunner, audit, proxyPort: running.port, proxyToken: running.token, model });
    },
    async stop(id) {
      await stopBrain(systemRunner, audit, id);
      if (proxy.running?.brainId === id) await proxy.stop();
    },
  };
  process.on("SIGINT", () => void proxy.stop().finally(() => process.exit(0)));
  process.on("SIGTERM", () => void proxy.stop().finally(() => process.exit(0)));
}

const serverOptions: ServerOptions = { store, audit };
if (launcher) serverOptions.launcher = launcher;
const { server, token } = createBobServer(serverOptions);

server.listen(config.port, "127.0.0.1", () => {
  console.log(`Bob écoute sur http://127.0.0.1:${config.port}`);
  console.log(`Ouvrir : http://127.0.0.1:${config.port}/?token=${token}`);
  console.log(`Données : ${config.dataDir}`);
  console.log(launcher ? `Proxy : ${proxyDir} (port ${proxyPort})` : "Proxy non configuré : lancement des brains désactivé");
});
