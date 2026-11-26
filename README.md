# Bob

Second brains cloisonnés pour un EM de prestataires : un brain par client, un sandbox `sbx` par brain,
un proxy d'anonymisation devant le LLM. Voir [SPEC.md](SPEC.md).

## Lancer

```bash
npm install
npm test            # tests (vitest)
npm run typecheck
npm start           # web UI sur 127.0.0.1:4173, jeton affiché dans la console
```

Variables : `BOB_DATA_DIR` (défaut `~/bob-data`), `BOB_PORT` (4173).
Lancement des brains (proxy + sandbox) : `BOB_PROXY_DIR` (dossier du proxy d'anonymisation, hors dépôt),
`UPSTREAM_API_KEY`, `UPSTREAM_BASE_URL`, `BOB_PROXY_PORT` (8000), `BOB_MODEL`.

Pré-requis : Node 24+, `sbx` avec une politique réseau `deny-all` qui autorise `localhost:<port du proxy>`.
