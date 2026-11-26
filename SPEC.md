# SPEC — Bob : second brains cloisonnés pour un EM de prestataires

> Statut : brouillon v0.17 — 2026-11-25. Les points marqués **[À VALIDER]** attendent une décision.

## 1. Contexte et objectifs

Romain est prestataire informatique et Engineering Manager d'une équipe de consultants, chacun en mission chez un client (missions longues ou courtes). Il travaille aussi avec ses collègues au sein de l'agence.

Il utilise opencode et Claude Code (installés en local) ainsi que les connecteurs Claude (mail, agenda, Drive). Il a déjà expérimenté un proxy de pseudonymisation, `privacy-llm-proxy`, dont Bob s'inspire (§4.1). Les données de chaque client doivent rester séparées. Certaines exigent des traitements de sécurité.

**Bob** est une application locale (web UI sur `localhost`) qui :

1. gère un *second brain* par client, isolé des autres ;
2. lance l'agent (opencode en v1) dans un sandbox dédié au brain, avec les connecteurs choisis ;
3. fait passer **tout** le trafic LLM par un proxy d'anonymisation local, réglé selon le niveau de sensibilité du brain ;
4. couvre quatre usages : suivi des consultants, veille client/mission, briefing quotidien, pipeline commercial.

### Hors périmètre (v1)

- Hébergement distant, multi-utilisateur, synchronisation cloud des brains.
- Développement d'un nouvel agent IA ou d'un nouveau proxy : Bob orchestre opencode/Claude Code ; le proxy est une brique à choisir (§4.1).
- Modèle de langage local (Ollama) : écarté, remplacé par Claude derrière le proxy d'anonymisation.
- Application desktop native.
- Support hors macOS (cible unique : macOS, Apple Silicon).

## 2. Principes directeurs

- **Local d'abord** : les données restent sur la machine ; seul le trafic LLM sort, **toujours** via le proxy d'anonymisation.
- **Cloisonnement par construction** : un brain actif à la fois par session, jamais de contexte croisé entre clients.
- **Fichiers lisibles** : le contenu reste en Markdown, exploitable sans Bob.
- **Aucun agent hors sandbox** : tout agent (opencode, Claude Code) tourne dans un Docker Sandbox (`sbx`, microVM) dédié au brain.
- **Refus par défaut** : en cas de doute sur le niveau, Bob applique le profil le plus strict et demande.

## 3. Modèle de données

### 3.1 Brains

| Brain | Rôle | Exemple de contenu |
|---|---|---|
| `client/<slug>` | Un brain par client ; missions en sous-dossiers | contexte, décisions, risques, comptes rendus, consultants affectés |
| `team` | Équipe d'EM (transverse, **données RH**) | 1:1, objectifs, évaluations, compétences, fins de mission |
| `agency` | Vue personnelle de Romain au niveau agence (non partagée) | staffing, renouvellements, opportunités, notes d'agence |
| `personal` | Perso/organisation | notes de travail, formation |

Règle : une information RH sur un consultant vit dans `team`, jamais dans `client/*`. Le brain client ne contient que ce qui est utile à la mission (rôle, périmètre, contact).

### 3.2 Structure disque

```
~/bob-data/                         # configurable ; hors dépôt git du code
  brains/
    client/<slug>/
      brain.yaml                    # niveau, moteur, connecteurs, chiffrement
      CLAUDE.md                     # contexte injecté dans la session
      missions/<mission>/*.md
      inbox/                        # imports bruts (mails, notes) à trier
      .index/brain.sqlite           # index de recherche (FTS5, embeddings locaux)
      .git/                         # un dépôt git local par brain
    team/ agency/ personal/
  audit/audit.jsonl                 # journal d'audit (append-only)
  bob.yaml                          # config globale
```

### 3.3 `brain.yaml`

```yaml
name: acme
kind: client            # client | team | agency | personal
sensitivity: restricted # open | restricted | forbidden
engine: opencode        # v1 ; claude-code possible plus tard (§6)
proxy:
  profile: strict       # secrets | standard | strict (dérivé du niveau, ajustable)
sandbox:
  network: deny-all     # sortie LLM uniquement via le proxy ; + destinations des connecteurs activés
  workspace: direct     # direct (rw) | clone (dépôt monté en lecture seule, copie privée)
  extra_mounts: []      # chemins en :ro uniquement
encryption: true
connectors:
  enabled: [mail, calendar, drive]  # choix de Romain, vide par défaut ; rien n'est imposé
  note: "accord client : oui"       # mémo libre, sans effet technique
  account: agency       # compte entreprise Claude (seul compte pour l'instant)
  mail:     { labels: ["ACME"] }
  calendar: { calendars: ["ACME"] }
  drive:    { folders: ["<id dossier>"] }
anonymize:
  rules: [people, emails, secrets, client-name]
  allowlist: []         # termes à ne jamais masquer (technologies, noms publics)
```

## 4. Classification et politique de sécurité

Trois niveaux, appliqués au **brain entier**. Le proxy d'anonymisation est **toujours actif** ; le niveau règle sa sévérité.

| Niveau | Profil du proxy | Traitement |
|---|---|---|
| `open` | `secrets` | Suppression des secrets (clés, tokens, mots de passe) uniquement. |
| `restricted` (défaut) | `standard` ou `strict` | `standard` : secrets, e-mails, téléphones. `strict` : + personnes, noms de client, organisations, pseudonymisés par jetons stables. |
| `forbidden` | — | **Aucun appel LLM.** Agent désactivé ; Bob ne fait que stockage, recherche, transcription locale. |

Décisions : tout brain client démarre en `restricted/strict` jusqu'à classification explicite. `team` (données RH) = `restricted/strict` (confirmé : sans modèle local, `forbidden` voudrait dire aucune IA sur les 1:1). Romain choisit lui-même le bon niveau au bon moment, dans le cadre de son entreprise : Bob n'impose pas de politique client et n'a rien à garantir à un tiers.

### 4.1 Proxy d'anonymisation (systématique)

Le proxy est une brique **remplaçable**. `privacy-llm-proxy` (Python, v0.2.0, dépôt local de Romain) sert de **référence et d'inspiration** : Bob peut le réutiliser, le faire évoluer ou écrire le sien. Ses choix sont donc **challengés** ci-dessous, pas repris par défaut. Décision à prendre au prototype (M2).

Ce que la référence fait déjà (testée dans un autre contexte avec opencode) :

- Écoute sur `127.0.0.1:8000`, expose `POST /v1/chat/completions` (format OpenAI) et relaie vers l'amont (`UPSTREAM_BASE_URL`), ici la passerelle LLM de l'entreprise qui relaie vers un modèle Claude.
- Données personnelles : jetons réversibles `[[ENTITY_TYPE_N]]`, stables dans une session ; secrets : `[REDACTED_SECRET]`, irréversible.
- Mapping **en RAM** uniquement, expiration après 30 min d'inactivité ; échec de détection = requête bloquée (jamais d'envoi en clair).
- Détection spaCy `fr_core_news_lg`, liste d'exclusion (`EXCLUDE_TERMS`), blocage optionnel des termes sensibles (`BLOCK_SENSITIVE`), jeton local, tableau de bord à compteurs sans contenu.

Exigences pour Bob, quelle que soit l'implémentation :

- **Session = brain** : l'en-tête `x-session-id` (`SESSION_HEADERS`) porte l'identifiant du brain, pour que le mapping d'un client ne serve jamais à un autre. Une instance par brain actif est préférable (isolation de la RAM) **[À VALIDER : instance par brain ou unique]**.
- **Profils** : `open` (secrets), `restricted/standard`, `restricted/strict` à traduire en configuration du proxy (types d'entités, `EXCLUDE_TERMS`) ; à confirmer ce que le proxy permet déjà.
- **Accès depuis le sandbox** : `host.docker.internal:8000`, autorisé par `sbx policy allow network localhost:8000` ; le jeton local sert d'authentification côté agent.
- **Compteurs** : le tableau de bord du proxy alimente l'audit de Bob (volumes masqués, blocages), sans valeurs.
- Le mapping n'étant qu'en RAM, il n'y a pas de table de jetons à chiffrer sur disque. Après expiration (30 min), les jetons d'un tour ancien ne sont plus restituables : à gérer dans les sessions longues **[À VALIDER : TTL configurable, `TTL_SESSION`]**.

Résultats du test de la référence (sous-agent, faux amont local, données fictives) :

- **Acquis** : 95 tests passés ; pseudonymisation FR (personne, e-mail, téléphone, IBAN, lieu) ; secrets AWS/JWT/`password` masqués ; jetons stables dans une session et **mappings isolés entre sessions** ; **streaming et `tool_calls` fonctionnels** (arguments d'outils réhydratés) ; échec de détection ou timeout = blocage (fail-closed) ; latence ajoutée faible (+4 ms sur un texte court, environ 10 ms/ko) ; tableau de bord sans valeurs ; environ 445 Mo de RAM par instance (démarrage environ 10 s).
- **Écarts à combler** :
  1. aucune **entité personnalisée** (clients, consultants, projets) : un nom d'entreprise rare n'est pas détecté ;
  2. aucun **profil** `open`/`standard`/`strict` : le comportement est unique ;
  3. **secrets** trop peu couverts : `api_key=`, `Bearer`, `sk-…`, `ghp_…`, blocs PEM, `aws_secret_access_key` passent en clair ;
  4. détection limitée au **français** (et partiellement l'anglais) : texte dans une autre langue envoyé en clair, sans alerte ;
  5. les **clés JSON** des arguments d'outils de l'historique sont pseudonymisées (peut dérouter le modèle) ; faux positifs du NER (« OK », « Réunion ») ;
  6. liste blanche de champs de requête : `response_format`, `reasoning_effort`, `parallel_tool_calls`, `seed`, `n` supprimés silencieusement ;
  7. sans `x-session-id`, repli sur un hash du premier message (deux conversations similaires partagent un mapping) ;
  8. chemin amont fixe, jeton local unique, un seul verrou de détection (sous-agents parallèles sérialisés, non mesuré) ;
  9. format OpenAI uniquement (Claude Code non pris en charge) ;
  10. mapping en RAM avec TTL : un jeton émis après expiration devient inconnu.
- **Recommandation du test : adapter, ne pas réécrire.** Priorités : entités personnalisées par brain (glossaire, §4.5a), profils, secrets élargis (§4.5b), clés JSON préservées (§4.5d), champs de requête, `x-session-id` obligatoire, jeton par brain.

Points à challenger :

| Choix de la référence | Question |
|---|---|
| Python + spaCy, service séparé | Garder (environ 1,7 Go de RAM par instance `strict` fr+en, bonne détection) ou tout en TypeScript (une seule pile, détection plus faible) ? |
| Format OpenAI uniquement | Ajouter le format Anthropic pour Claude Code, ou passer par une conversion tierce ? |
| ~~Restitution non streamée~~ | Résolu : streaming et `tool_calls` déjà gérés par la référence. |
| Mapping en RAM, TTL 30 min | Garder le mapping jetable par run (§4.5e) ; régler le TTL au-delà de la durée de session. |
| Jeton local fixe | Un jeton par brain et par session, éventuellement lié au sandbox. |
| Détection par modèle NER seul | Compléter par des listes propres au brain (consultants, client, projets) : **indispensable**, le NER rate les noms d'entreprise rares. |
| Proxy générique | Intégrer l'audit, les profils par niveau et la session = brain en natif. |

### 4.2 Règles d'anonymisation

- Détection locale (spaCy français + règles) : personnes, lieux, e-mails, téléphones, IBAN, secrets (clés, tokens, mots de passe). Noms de client et consultants du brain à ajouter via la configuration **[À VALIDER : mécanisme d'entités personnalisées]**.
- Jetons stables par session (`[[PERSON_3]]`), table en RAM dans le proxy.
- Les secrets sont **supprimés** (non pseudonymisés) et jamais réhydratés.
- `allowlist` (= `EXCLUDE_TERMS`) pour éviter de masquer des termes publics (technologies, produits).
- Limites connues (voir aussi §4.1) : l'anonymisation de texte libre est imparfaite (contexte déductible, noms non listés) ; elle réduit le risque sans remplacer l'accord du client. Les jetons peuvent dégrader la qualité (noms dans des chemins, jeux de mots) : à mesurer.
- **Angle mort : les connecteurs.** Les données lues via les connecteurs Claude peuvent être récupérées côté Anthropic sans traverser le proxy local. C'est à Romain de décider, brain par brain, s'il active un connecteur ; Bob se contente de le lui rappeler.

### 4.3 Chiffrement au repos

- Décision : un volume APFS chiffré (image disque) par brain, monté à la demande, mot de passe dans le Keychain macOS. Transparent pour les agents une fois monté.
- Déverrouillage à la demande (mot de passe ou Keychain macOS), verrouillage automatique après inactivité (défaut 30 min).
- L'index SQLite et la table d'anonymisation sont dans le brain chiffré.

### 4.4 Audit et cloisonnement

- **Un sandbox par brain, un seul brain monté par sandbox** (voir §6.1). L'agent ne voit que le brain courant ; le reste du disque hôte, le daemon Docker de l'hôte et le réseau non autorisé sont inaccessibles. Les sandboxes ne communiquent pas entre eux.
- Permissions Claude Code `deny` hors du brain en défense en profondeur.
- Journal `audit.jsonl` (append-only) : ouverture/fermeture de brain, profil du proxy, connecteurs activés, changements de niveau, appels bloqués, exports, volumes de jetons masqués (sans valeurs). Le journal ne contient **pas** le contenu des échanges.
- Anti-fuite : un contenu d'un brain ne peut pas être copié vers un brain de niveau moins strict sans confirmation (contrôle sur export/copie).

### 4.5 Pistes à étudier pour le proxy

**a) Glossaire / référentiel par brain (entités personnalisées)**
- Fichier `glossary.yaml` dans le brain (donc chiffré avec lui) : entrées `{valeur, alias[], type}` avec types `PERSON`, `ORG`/`CLIENT`, `PROJECT`, `PLACE`, `TERM_PUBLIC`.
- Correspondance exacte, insensible à la casse et aux accents, sur mots entiers, indépendante de la langue ; elle s'applique **avant** le NER et **prime** sur lui.
- Alimentation (décision : **les deux**) : saisie manuelle dans la web UI, et proposition automatique à partir des notes du brain (noms propres récurrents, fiches consultants du brain `team`), toujours **validée par Romain** avant entrée dans le glossaire.
- `TERM_PUBLIC` remplace `EXCLUDE_TERMS` (technologies, produits, mots qui donnent des faux positifs).
- Glossaire global (`agency`, noms de ton entreprise) fusionné avec celui du brain, sans que le glossaire d'un client soit visible d'un autre.
- Sécurité : le glossaire contient justement les noms sensibles ; il vit dans le volume chiffré et n'est chargé qu'en RAM dans le proxy.

**b) Système pour les secrets**
- Trois couches : (1) règles par motifs étendues (clés API usuelles, `Bearer`, `sk-`, `ghp_`, PEM, `*_secret_*`, URL avec identifiants), à tirer d'un jeu de règles maintenu (type gitleaks) plutôt qu'à écrire à la main ; (2) détection par entropie sur les valeurs affectées à des clés suspectes ; (3) **registre de valeurs connues** : les secrets réellement présents (fichiers `.env`, Keychain, secrets du sandbox) sont enregistrés et masqués par correspondance exacte.
- Les secrets sont toujours supprimés (`[REDACTED_SECRET]`), non réversibles, quel que soit le profil, **y compris en `open`**.
- Prévention : ne pas monter les `.env` réels dans le sandbox, injecter les identifiants par le proxy du sandbox.
- Rapport dans l'audit : nombre de secrets masqués par type, sans valeur.

**c) Anglais et autres langues**
- Cause : la référence n'embarque que le modèle spaCy `fr_core_news_lg` et fixe la langue à `fr` partout. L'anglais n'est donc détecté qu'en partie (noms de personnes, règles e-mail/IBAN/téléphone), pas les lieux ni les organisations ; l'arabe, le japonais, etc. ne sont pas couverts, sans alerte.
- Décision : ajouter le modèle spaCy anglais équivalent, `en_core_web_lg`, à côté de `fr_core_news_lg`, avec des recognizers Presidio déclarés pour `fr` et `en`.
- Détection de la langue **par fragment** de texte (message ou bloc), puis analyse avec le modèle correspondant. Texte mixte : analyse par les deux modèles et fusion des entités (le plus protecteur gagne).
- Langue non couverte (ni `fr` ni `en`) : alerte, et blocage en profil `strict`.
- Les règles par motifs et le glossaire restent indépendants de la langue.
- Mesuré sur prototype : voir §4.6 (RAM environ 1,7 Go avec les deux modèles, rappel anglais de 36 % à 94 %).

**d) Clés JSON pseudonymisées**
- Le proxy parcourt les structures JSON (arguments d'outils, résultats d'outils en JSON) et ne transforme que les **valeurs** de type chaîne ; les clés, les noms de champs et la ponctuation JSON restent intacts.
- Un faux positif NER sur une clé (`path` détecté comme lieu) ne peut donc plus altérer la structure.
- Test d'acceptation : l'historique `tool_calls` renvoyé à l'amont conserve des clés identiques à l'original.

**e) Pseudonymisation unique ou jetable à chaque run ?**
- Elle n'a **pas** besoin d'être unique dans le temps. La stabilité n'est requise que **dans une conversation** : l'historique est renvoyé à chaque tour, et le modèle doit voir le même jeton pour la même entité.
- Un mapping **jetable par run**, en RAM, supprimé à la fin de session, est donc le choix par défaut : rien à persister, rien à chiffrer, et moins de corrélation d'un run à l'autre côté fournisseur.
- Impacts : (1) la numérotation change d'un run à l'autre (`PERSON_1` n'est pas la même personne), sans conséquence si le modèle ne voit que la conversation courante ; (2) si une session est reprise avec un historique en clair, le proxy reconstruit un nouveau mapping et tout reste cohérent ; (3) le cache de prompt du fournisseur ne sert pas d'un run à l'autre, ce qui est un coût mineur ; (4) un jeton émis par le modèle après expiration du TTL devient inconnu : le TTL doit dépasser la durée de session (voire expirer à la fermeture du sandbox) ; (5) les fichiers écrits par l'agent contiennent les vraies valeurs, car la réhydratation a lieu avant leur écriture.
- Alternative écartée par défaut : jetons déterministes par brain (même entité, même jeton à chaque run). Avantage : stabilité entre runs. Inconvénients : table à persister et chiffrer, corrélation possible. À reconsidérer seulement si les sessions longues posent problème.

### 4.6 Résultats du prototype du proxy (copie adaptée, hors dépôt)

Un sous-agent a implémenté les adaptations §4.5 dans une copie du proxy de référence, avec un faux amont et des données fictives.

- **Tests** : 95 → 151 passent, sans régression.
- **Anglais** : `fr_core_news_lg` + `en_core_web_lg`, détection de langue par fragment (bibliothèque légère, environ 2 Mo, déterministe, langues restreintes à fr/en/de/es/it/pt/nl), fusion des entités, alerte une fois par session sur langue non couverte, blocage optionnel.
- **Glossaire** : `glossary.yaml` (valeur, alias, type), correspondance exacte insensible à la casse et aux accents, priorité secrets > glossaire > NER, rechargement à chaud, démarrage refusé si invalide.
- **Secrets** : motifs étendus (`api_key`, `Bearer`, `sk-`, `ghp_`, PEM, `*_secret_*`, etc.) avec 11 cas de faux positifs testés ; détection par entropie ajoutée (valeur d'une clé suspecte, ≥ 20 caractères, entropie ≥ 3,5), seuil à valider sur du vrai trafic.
- **Clés JSON** : seules les valeurs chaîne sont transformées (arguments et résultats d'outils JSON) ; clés identiques dans l'historique renvoyé à l'amont ; une valeur est aussi masquée quand le nom de sa clé est sensible.
- **Profils** (`PROFILE`) : `open` (secrets), `standard` (secrets, e-mail, téléphone), `strict` (tout, défaut). En `open`/`standard`, aucun modèle spaCy n'est chargé.

| Mesure | Référence | `strict` (fr+en) | `standard` / `open` |
|---|---|---|---|
| RAM au repos | 1 082 Mo | **1 705 Mo** | 70 Mo |
| Démarrage | 3,3 s | 3,8 s | 0,6 s |
| Latence 4,5 ko FR | 35 ms | 38 ms | 5 ms |
| Latence 4,5 ko mixte FR/EN | 34 ms | 99 ms | 5 ms |

| Rappel (140 entités, corpus fictif facile) | Référence | Adapté | Adapté + glossaire |
|---|---|---|---|
| Total | 54 % | 92 % | **96 %** |
| Anglais | 36 % | 94 % | 96 % |
| Organisations | 25 % | 88 % | 88 % |
| Clients | 25 % | 83 % | 92 % |
| Entités du glossaire | 22 % | 84 % | 100 % |

Réserves : corpus écrit à la main (ordre de grandeur, pas une performance réelle), une seule exécution par mesure. La RAM de référence mesurée ici (1 082 Mo) diffère du test précédent (≈445 Mo) : à clarifier avant de dimensionner les instances.

Décisions à prendre :
- **RAM** : environ 1,7 Go par instance `strict` avec les deux modèles. Une instance par brain actif devient coûteuse sur 16 Go : préférer **une instance partagée** avec sessions isolées par `x-session-id`, ou un profil `standard` (70 Mo) quand il suffit.
- Glossaire actif seulement en `standard` et `strict` (choix du prototype) : à trancher pour `open`.
- IBAN en `strict` seulement (le SPEC le met en `standard`) : à trancher.
- Alias d'une même entité (« Acme », « Acme Industries ») : jetons différents ; la restitution reste correcte mais la corrélation est perdue.
- Texte mixte FR/EN : latence et risque de langue erronée sur les fragments courts ou le code.
- Non rejoués : tests opencode, e2e et PII de la référence.

## 5. Connecteurs (mail, agenda, Drive)

Mode **mixte** :

- **Compte entreprise Claude** (seul compte aujourd'hui) : connecteurs mail, agenda et Drive utilisables depuis les agents dans `sbx`. Bob filtre par libellés (mail), calendriers dédiés et dossiers Drive.
- **Configuration par client, à ta main** : Bob n'impose aucun connecteur et n'en bloque aucun. Tu choisis par brain lesquels sont activés (`enabled`) et notes l'accord du client si besoin (`note`, mémo libre). Sans connecteur, l'import manuel dans `inbox/` reste possible.
- Seul garde-fou : activer un connecteur sur un brain `forbidden` déclenche un avertissement avec confirmation (le niveau implique zéro appel LLM), et sur un brain `restricted/strict` un rappel de l'angle mort du proxy (§4.2). Aucun refus : la responsabilité du bon niveau est celle de Romain, dans le cadre de son entreprise.
- **Comptes/profils dédiés** : possibles plus tard pour des clients exigeant un compte séparé ; hors v1.

Règles :

- À l'ouverture d'un brain, Bob n'active que les connecteurs déclarés dans `brain.yaml`, et désactive les autres de la session.
- Le filtrage par libellé ne vaut pas isolation forte : une requête mal cadrée peut lire hors périmètre. Mitigation : consigne dans `CLAUDE.md` du brain et vérification dans l'audit. **[À VALIDER : niveau de confiance acceptable pour les clients tolérants]**
- Dans un sandbox, les serveurs MCP passent par la passerelle MCP de l'hôte (les serveurs stdio locaux tournent sur l'hôte, donc hors sandbox : à traiter comme intégrations de confiance). Les connecteurs Claude sont utilisables depuis un agent dans `sbx` avec le compte entreprise (confirmé par Romain).
- La politique réseau du sandbox autorise les destinations des connecteurs uniquement pour les connecteurs activés sur ce brain.
- Écriture (envoi de mail, création d'événement) : confirmation explicite à chaque action.

## 6. Moteur IA et sandboxes

- **v1 : opencode**, configuré avec `baseURL = http://host.docker.internal:8000/v1` et le jeton local du proxy, dans le sandbox du brain ; contexte via `AGENTS.md`/instructions du brain. C'est le chemin déjà testé avec la référence.
- **Claude Code** : possible une fois le proxy capable du format Anthropic (`/v1/messages`) ou d'une conversion en amont. Jalon dédié, après le prototype **[À VALIDER : conversion dans le proxy ou passerelle tierce]**.
- Les connecteurs Claude (mail, agenda, Drive) sont fournis par Claude Code avec le compte entreprise ; avec opencode, ils ne sont pas disponibles tels quels. Équivalent en v1 : import manuel dans `inbox/` ou serveurs MCP côté opencode **[À VALIDER]**.

### 6.1 Docker Sandboxes (`sbx`)

Validé par prototype (sbx 0.54.0, opencode 2.4.1, faux proxy et faux amont locaux, sans clé réelle) :

- **Un sandbox par brain** (microVM) : `sbx create --name brain-<x> opencode <workspace> [<docs>:ro]`, exécution non interactive par `sbx exec -w <workspace> brain-<x> opencode run "<prompt>"`. Le premier `create` prend environ 85 s (image), les suivants environ 3 s.
- **Cloisonnement vérifié** : un second sandbox ne voit pas le workspace du premier ; un montage `:ro` est réellement en lecture seule (même avec `sudo`) ; aucun accès au disque hôte hors des dossiers montés. Le workspace est monté au **même chemin** que sur l'hôte (un `:CIBLE` explicite est possible).
- **Réseau** : `sbx policy allow network localhost:<port>` (règle sur `localhost`, pas sur `host.docker.internal`) ; l'agent joint alors `host.docker.internal:<port>`. Toute autre destination répond 403 « Approval required » et crée une approbation en attente que l'agent ne peut pas valider.
- **Secrets** : les secrets de service `sbx` (anthropic, openai…) ne sont injectés que vers les hôtes de leur fournisseur ; vers le proxy local, seule une sentinelle (`proxy-managed`) transite, donc **pas de fuite vers le proxy**. Le jeton local du proxy est fourni sans être exposé à la VM : `sbx secret set-custom --sandbox brain-<x> --host localhost --host host.docker.internal --placeholder 'bobtok-{rand}' --value-stdin`, la VM ne voit que le placeholder, remplacé par le vrai jeton dans les **en-têtes** (pas dans le corps). La clé amont n'existe que dans le processus du proxy sur l'hôte.
- **Configuration opencode** : fournisseur `@ai-sdk/openai-compatible` avec `baseURL = http://host.docker.internal:<port>/v1` et `apiKey` = le placeholder, copiée par `sbx cp opencode.json brain-<x>:/home/agent/.config/opencode/opencode.json`. Le proxy doit répondre en **SSE** quand `stream: true`. Les en-têtes `X-Opencode-Session`, `X-Opencode-Project` et `Traceparent` sont utilisables pour la session du proxy et l'audit.
- **Cycle de vie** : `sbx stop` conserve workspace et config dans la VM ; `sbx rm -f` (le `--force` est obligatoire en non interactif) supprime VM, volumes, secrets et règles scopés au sandbox. Restent sur l'hôte : les fichiers du workspace (y compris ceux écrits par l'agent) et l'image (environ 1,25 Go, récupérable).
- Audit : `sbx policy log <sandbox>` (connexions autorisées et refusées), `sbx policy check network <hôte:port>`.

Écarts avec la politique réseau décrite plus haut :

1. **Le « deny-all par défaut » n'est pas garanti.** La politique **globale** de l'hôte, qui appartient à Romain, est permissive (nombreuses autorisations, dont les API des fournisseurs IA). Un `--deny-network '**'` par sandbox est inutilisable : un deny l'emporte toujours et masque l'autorisation du proxy. **Décision finale : `deny-all` global**, mis en place sur le Mac de Romain après `sbx policy reset` puis `sbx policy init deny-all`, avec seulement deux autorisations explicites : `localhost:8000` (le proxy d'anonymisation) et `models.dev:443` (catalogue de modèles d'opencode, sans contenu). `Balanced` a été écarté : il autorise les services IA par défaut (règle `default-ai-services`), et un deny global ne peut pas la contredire pour tous les hôtes (`sbx` refuse un deny en conflit avec cette règle pour `api.anthropic.com`). Vérifié après mise en place : `api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`, `example.com` et `github.com` sont refusés ; le proxy local et `models.dev` sont autorisés. Les autres destinations (registres, destinations des connecteurs activés) s'ajoutent à la demande par `sbx policy allow network <hôte>:<port>`. Bob **ne modifie jamais** la politique globale lui-même : il documente les commandes (`sbx policy deny network <hôte>:443`), la politique appartient à Romain. Au démarrage et avant chaque lancement de brain, Bob vérifie (`sbx policy check network`) que les API LLM directes sont refusées et bloque sinon, avec le message et la commande à exécuter.
2. Au démarrage, opencode contacte un service externe de catalogue de modèles : à neutraliser (option à identifier) ou à autoriser en connaissance de cause.
3. `--env` ne s'applique pas à un sandbox déjà créé : fournir le placeholder à la création (`-e`) ou le mettre en dur dans `opencode.json`.

Risques :
- L'utilisateur de la VM est `sudo` : l'agent est root dans sa VM (sans effet sur les montages `:ro`), et peut modifier sa propre config opencode.
- Politique globale permissive : un agent compromis pourrait exfiltrer vers une API IA autorisée, avec un secret de service injecté. D'où l'écart 1.
- Les approbations réseau en attente peuvent être validées par erreur par Romain : afficher et auditer chaque demande dans la web UI de Bob.
- Les fichiers écrits par l'agent dans le workspace sont des données non fiables côté hôte.
- Mises à jour de `sbx` : épingler la version testée.
- **Chiffrement** : le volume APFS du brain doit être monté **avant** le lancement du sandbox ; Bob arrête le sandbox avant de démonter/verrouiller.
- Pré-requis vérifiés au démarrage : `sbx`, opencode, proxy opérationnel (`GET /health`), clé de la passerelle présente, politique globale conforme.

### 6.1 bis Résultats du prototype de bout en bout (M1 + M2)

Bob (backend TypeScript) → proxy adapté → faux amont, avec opencode dans un vrai sandbox `sbx`, sur ce Mac :

- **Chaîne validée** : création du brain, lancement par l'API (démarrage du proxy avec le profil et le glossaire du brain, création du sandbox, jeton fourni par stdin, config opencode copiée), puis `opencode run` dans le sandbox. L'amont a reçu `[[PERSON_1]]`, `[[CLIENT_1]]` (glossaire), `[[EMAIL_ADDRESS_1]]` et `[REDACTED_SECRET]` ; aucune valeur brute (nom, client, e-mail, clé) n'a atteint l'amont ; la réponse a été restituée côté agent ; la clé amont n'existe que dans le proxy ; l'audit enregistre le lancement sans contenu.
- **Constat majeur : `sbx` contourne la politique réseau pour les API IA.** Avec un `deny-all` global, `sbx policy check` annonce « Denied » pour `api.anthropic.com`, mais depuis le sandbox ces hôtes (ainsi que `api.openai.com` et le catalogue d'opencode) répondent (HTTP 401/404/421) ; `sbx policy log` les classe `forward-bypass`, sans règle. Les autres hôtes (ex. `example.com`) sont bien bloqués (403). Observé sur sbx 0.54.0.
  - Conséquence : le « sandbox n'a aucune autre route vers un LLM » du §4.1 **n'est pas garanti au niveau réseau**. Le sandbox ne détient pas de vraie clé (sentinelles), donc les appels directs échouent en 401, mais un agent compromis pourrait utiliser une clé fournie par un attaquant vers ces hôtes (exfiltration possible).
  - Mesures : Bob ne se fie plus à `sbx policy check` seul ; il **sonde depuis le sandbox** après création et journalise un événement `policy.bypass_observed` avec avertissement (le lancement n'est pas bloqué, car le contournement est inévitable) ; ne jamais placer de vraie clé API dans un sandbox ; à signaler à Docker et à retester à chaque mise à jour de `sbx`. Le blocage strict n'est possible qu'avec un autre mécanisme (par ex. filtrage au niveau de l'hôte) **[À étudier]**.
- **Constat majeur : le prompt système d'opencode est massivement pseudonymisé** (31 ko, une trentaine de jetons `ORG` et plusieurs `PERSON`, ex. un nom de champ de code pris pour une personne) : qualité de l'agent dégradée et coût inutile. À traiter dans le proxy : ne pas analyser les messages `system` ni les schémas d'outils, ou analyser uniquement les messages `user` et les résultats d'outils **[priorité M3]**.
- Détails d'intégration opencode : `sbx` impose `OPENCODE_MODEL` et sa propre config ; il faut passer `--model bobproxy/<modèle>` à opencode ; le fichier de config copié doit être lisible par l'agent (0644) ; un `sbx exec` sur un sandbox arrêté le redémarre.
- **Limites actuelles de Bob** : une instance de proxy à la fois (changer de brain la redémarre) ; le port est fixe (8000) car la règle `sbx policy allow network localhost:8000` appartient à Romain ; la session interactive s'ouvre dans un terminal par la commande affichée (pas de terminal intégré) ; chiffrement, anonymisation du glossaire par import et briefing non faits.

### 6.2 Ressources (MacBook Pro M2 16 Go)

Aucun modèle de langage local. La RAM sert à macOS, Docker, au proxy et au modèle spaCy `fr_core_news_lg` (détection d'entités), qui tient largement sur 16 Go.

### 6.3 Transcription vocale (Apple Speech, Anarlog)

- Reconnaissance vocale **sur l'appareil** d'Apple ; qualité jugée suffisante en français (à tester avec Anarlog).
- **Intégration Anarlog** : Anarlog est une app de notes de réunion locale (capture audio système sans bot, transcription en direct, stockage SQLite). Elle expose une CLI : `anarlog meetings export MEETING_ID --format markdown|json --output <fichier>`.
- Flux : tu enregistres dans Anarlog → dans Bob, tu choisis la réunion et le **brain cible** → Bob lance l'export vers `inbox/` du brain → tri et résumé par l'agent (via le proxy).
- Le cloisonnement se fait à l'import, par choix explicite du brain : Anarlog garde une seule base pour tous les clients.
- Réglages Anarlog recommandés : transcription on-device (Apple Speech, déjà utilisé), résumés IA **désactivés** (Bob les fait, via le proxy), webhooks et connecteurs Cloud **désactivés**.
- Apple Speech est déjà supporté par Anarlog et utilisé par Romain.

**Vérifié sur la CLI `anarlog` 1.4.35 (test en lecture seule)**

| Besoin de Bob | Commande / constat |
|---|---|
| Lister | `anarlog --json --source local meetings list [-q TEXTE] [--folder CHEMIN] [--limit N]` ; pas de filtre par date ni par tag, tri côté Bob sur `created_at` |
| Dossiers | `anarlog --json meetings folders` ; un dossier Anarlog par client est une bonne piste de correspondance avec les brains |
| Exporter | `anarlog --source local meetings export ID --format json -o <fichier>` (et `--format markdown`) ; refuse d'écraser sans `--force` (code 4) |
| Codes de sortie | 0 ok, 1 erreur, 2 réunion introuvable, 3 base introuvable, 4 fichier existant |
| App fermée | Lectures possibles (base ouverte en lecture seule, déduit de la doc) ; `import` exige l'app ouverte, `delete` exige l'app fermée |
| Supprimer après export | `anarlog meetings delete ID --if-export-sha256 <SHA> --require-transcription-complete` : SHA-256 de l'export JSON (calculer sur le fichier `-o`), transcript terminé, app fermée ; suppression définitive |

Contenu des exports :
- **JSON** : identifiants, dates ISO 8601, `folder_path`, note, résumés, participants, actions, transcript avec mots horodatés (canal micro ou système), `attachments` (références, pas l'audio). C'est le format de référence : il porte les horodatages.
- **Markdown** : titre, notes, résumé IA s'il existe, participants, transcript par paragraphes `Speaker N:`, sans frontmatter ni horodatage. Les locuteurs distants ne sont pas nommés.
- Bob exporte en JSON puis génère le markdown de l'inbox (avec frontmatter, sans les résumés IA d'Anarlog).

Sécurité des données d'Anarlog :
- La base SQLite et les enregistrements audio sont **en clair** sur disque (permissions 644), pour tous les clients ; le chiffrement de bout en bout d'Anarlog ne concerne que sa synchronisation Cloud.
- Mitigations : FileVault ; réduire la rétention audio (réglage de l'app) ; déplacer le dossier de données dans un volume chiffré avec lien symbolique (**à tester**, car `delete` et `hold-*` refusent de suivre les liens dans `sessions/`) ; supprimer la réunion après export.
- **Le dossier de données d'Anarlog doit être invisible des sandboxes de Bob** (ne jamais monter le `$HOME`).
- Le plugin/skill d'agent d'Anarlog et son serveur MCP donnent accès à **toutes** les réunions sans filtre par client : non retenus en v1. Webhooks et import audio : non retenus (fuite possible hors du contrôle de Bob).
- Épingler la version de la CLI et vérifier `schema_version` dans les sorties JSON.
- Hors périmètre v1 : import automatique sans choix du brain.

## 7. Fonctionnalités par cas d'usage

### 7.1 Suivi des consultants (brain `team`)
- Fiche consultant : mission en cours, client, dates, compétences, objectifs.
- 1:1 : modèle de note, historique, actions ouvertes.
- Alertes : fin de mission proche, 1:1 en retard, objectif sans mise à jour.
- Vue d'ensemble de l'équipe sans afficher le contenu des brains clients.

### 7.2 Veille client et mission (brains `client/*`)
- Capture : compte rendu, décision, risque, contact, contexte technique.
- Tri de `inbox/` assisté par l'agent, avec validation avant écriture.
- Résumé de mission et journal des décisions.
- Recherche plein texte et sémantique **dans un brain**, jamais transverse (voir 7.5).

### 7.3 Briefing quotidien
- Par brain : mails non traités, réunions du jour, actions échues.
- Vue agrégée : uniquement des **titres génériques** (« 3 actions chez acme ») tirés des métadonnées, sans contenu, pour ne pas mélanger les contextes.
- Option de planification locale (ex. 9h) ; les brains verrouillés sont ignorés avec une mention.

### 7.4 Pipeline commercial (brain `agency`)
- Opportunités, renouvellements, besoins de staffing, lien avec les fins de mission.
- Les données client entrent dans `agency` via des fiches **volontairement rédigées** (champ nom, besoin, échéance), pas par copie de contenu d'un brain client.

### 7.5 Recherche
- Recherche limitée au brain actif.
- Recherche transverse : métadonnées uniquement (titres, dates, étiquettes), contenu jamais agrégé.

## 8. Web UI locale

- Serveur lié à `127.0.0.1`, jeton de session aléatoire, pas d'accès réseau externe.
- Écrans : liste des brains (niveau, profil du proxy, verrou), tableau de bord/briefing, brain (notes, inbox, recherche), lancement de session agent (terminal intégré), journal d'audit, réglages.
- Bandeau de contexte permanent : brain actif, niveau, profil du proxy, connecteurs activés.
- Verrouillage visuel et déconnexion des sessions à l'inactivité.

## 9. Architecture (proposition)

- **Backend local** : service unique en TypeScript (décision) exposant l'API de la UI, gérant brains, index SQLite, audit et politique.
- **Proxy d'anonymisation** : service séparé lancé et supervisé par le backend TypeScript ; implémentation à choisir (voir §4.1, référence : `privacy-llm-proxy`) ; un profil et une session par brain ; seul à détenir le mapping, en RAM.
- **Lanceur d'agents** : pilote la CLI `sbx` et le proxy (création, politique réseau, run, arrêt) et attache un pty au sandbox du brain.
- **Politique** : module central qui décide profil du proxy, connecteurs et réseau ; tous les chemins (UI, planificateur, CLI) passent par lui.
- **Index** : SQLite par brain (FTS5 + embeddings locaux), reconstruit depuis les fichiers.
- **Frontend** : SPA légère servie par le backend.
- **Transcription** : import via la CLI `anarlog` (Apple Speech on-device côté Anarlog), résultat écrit dans le brain choisi.

## 10. Exigences non fonctionnelles

- Les brains `forbidden` fonctionnent hors-ligne (aucun appel LLM). Les autres exigent le réseau.
- Latence ajoutée par le proxy : à mesurer (objectif : négligeable devant l'appel LLM).
- Aucune télémétrie.
- Sauvegarde : dépôts git locaux par brain ; export chiffré possible. Aucune sauvegarde cloud par défaut.
- Offboarding d'un client : suppression ou archivage chiffré d'un brain en une commande, avec trace d'audit.
- macOS en priorité (Keychain, volumes chiffrés).

## 11. Critères d'acceptation (v1)

1. Créer un brain client avec niveau, profil du proxy et connecteurs ; avertissement si la configuration est incohérente (ex. connecteur sur `forbidden`).
2. Ouvrir une session Claude Code sur un brain `open` : elle tourne dans un sandbox `sbx` dédié, seuls ses connecteurs sont actifs, aucun accès aux autres brains ni au reste du disque.
3. Sur un brain `restricted/strict`, un texte contenant un nom de consultant et un secret arrive à l'amont pseudonymisé/purgé (vérifié en capturant le trafic sortant du proxy) et revient réhydraté, y compris dans les appels d'outils ; les secrets ne reviennent jamais. Le mapping d'un brain n'est jamais utilisé par un autre.
4. Depuis un sandbox, toute connexion directe vers un fournisseur LLM échoue ; seule la route via le proxy fonctionne. Sur un brain `forbidden`, aucun agent ne démarre.
5. Un brain chiffré verrouillé est illisible (fichiers, index, table d'anonymisation) et se verrouille après inactivité.
6. L'audit enregistre chaque ouverture, changement de niveau et blocage, sans contenu.
7. Le briefing quotidien n'affiche aucun contenu croisé entre brains.
8. Une réunion exportée depuis Anarlog arrive dans `inbox/` du brain choisi, et dans aucun autre.

## 12. Jalons proposés

1. **M1 — Socle** : structure des brains, `brain.yaml`, git par brain, UI de liste, audit.
2. **M2 — Prototype proxy + sandbox (en premier)** : opencode dans `sbx` → proxy (référence existante pour démarrer) → passerelle LLM ; trancher réutiliser / adapter / réécrire ; tester secrets `sbx`, session par brain, `tool_calls`, latence, TTL.
3. **M3 — Sécurité** : profils du proxy, chiffrement des brains, verrouillage, audit depuis les compteurs du proxy.
4. **M4 — Usages** : suivi consultants, veille, inbox, import Anarlog, index/recherche.
5. **M5 — Briefing et pipeline** : briefing planifié, vue agence.
6. **M6 — Claude Code** : format Anthropic (conversion ou extension du proxy), connecteurs Claude.

## 13. Questions ouvertes

1. Claude Code vs opencode : v1 en opencode (chemin éprouvé) te convient-il, avec les connecteurs Claude reportés à M6 ?
2. Proxy : réutiliser, adapter ou réécrire (tableau §4.1) ? Instance par brain ou unique ? Profils `open`/`standard`/`strict` et entités personnalisées (noms de client, consultants) : ce que le proxy permet déjà ?
3. Verrou de détection unique : effet sur les sous-agents parallèles d'opencode (à mesurer).
4. Proxy (§4.6) : instance partagée ou par brain vu la RAM ; glossaire en `open` ; IBAN en `standard` ; alias d'une même entité.
5. Neutralisation de l'appel de catalogue de modèles d'opencode (option de désactivation à identifier) ? Autorisations à ajouter au fil de l'eau (registres de paquets, connecteurs) et port définitif du proxy (8000 supposé) ?
6. Dossier de données d'Anarlog : volume chiffré avec lien symbolique, ou FileVault et rétention courte suffisent ? Un dossier Anarlog par client ?
7. Combien de clients et de missions actifs à gérer, et quelle durée de conservation après la fin d'une mission ?
8. Niveau de confiance acceptable pour le filtrage par libellés sur le compte entreprise (§5) ?

## 14. Décisions prises

- macOS uniquement ; agents dans Docker Sandboxes (un sandbox par brain).
- Pas de modèle local : Claude (via la passerelle LLM de l'entreprise) derrière un proxy d'anonymisation systématique, dont `privacy-llm-proxy` sert d'inspiration (réutiliser, adapter ou réécrire : tranché au prototype).
- v1 : opencode ; Claude Code en M6.
- `team` en `restricted/strict`. Romain choisit lui-même le bon niveau, dans le cadre de son entreprise ; Bob n'impose ni ne promet rien à un tiers.
- Apple Speech supporté par Anarlog (déjà utilisé).
- Un brain par client ; `team`, `agency`, `personal` à part.
- Trois niveaux qui règlent le proxy : `open` (secrets), `restricted` (standard/strict), `forbidden` (aucun LLM).
- Aucun client n'interdit l'IA externe aujourd'hui : départ en `restricted`.
- Web UI locale ; backend TypeScript.
- Markdown + SQLite par brain ; chiffrement par volume APFS.
- Connecteurs en mode mixte.
- Connecteurs Claude utilisables dans `sbx` via le compte entreprise ; configurés par brain à ta main, rien d'imposé.
- `agency` est personnel à Romain, non partagé.
- Cible : MacBook Pro M2 16 Go.
- Apple Speech on-device (qualité française jugée ok) ; capture via Anarlog, import par sa CLI vers le brain choisi.
- Anglais supporté via `en_core_web_lg` en plus de `fr_core_news_lg`, détection de langue par fragment.
- Glossaire par brain alimenté à la main et par propositions automatiques validées.
- Pseudonymisation jetable par run (mapping en RAM) ; clés JSON jamais modifiées ; secrets toujours supprimés.
- Secrets : jeton du proxy fourni par `sbx secret set-custom` (placeholder), clé amont uniquement dans le proxy hôte ; validé par prototype.
- Politique réseau `sbx` : `deny-all` global (en place) + autorisations `localhost:8000` et `models.dev:443` ; Bob ne modifie jamais la politique globale. `sbx` contourne la politique pour les API IA (§6.1 bis) : Bob sonde depuis le sandbox et avertit.
