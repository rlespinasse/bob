// Faux proxy pour les tests du superviseur : /health et /env (renvoie la configuration reçue).
import { createServer } from "node:http";

const port = Number(process.env.BIND_PORT);
createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end('{"status":"ok"}');
  }
  if (req.url === "/env") {
    const keys = ["PROFILE", "GLOSSARY_PATH", "EXCLUDE_TERMS", "LOCAL_TOKEN", "BIND_PORT", "SESSION_HEADERS", "OTHER_SECRET"];
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null]))));
  }
  res.writeHead(404).end();
}).listen(port, "127.0.0.1");
