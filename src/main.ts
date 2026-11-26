import { AuditLog } from "./audit.ts";
import { BrainStore } from "./brain/store.ts";
import { loadConfig } from "./config.ts";
import { createBobServer } from "./server.ts";

const config = loadConfig();
const audit = new AuditLog(config.dataDir);
const store = new BrainStore(config.dataDir, audit);
const { server, token } = createBobServer({ store, audit });

server.listen(config.port, "127.0.0.1", () => {
  console.log(`Bob écoute sur http://127.0.0.1:${config.port}`);
  console.log(`Ouvrir : http://127.0.0.1:${config.port}/?token=${token}`);
  console.log(`Données : ${config.dataDir}`);
});
