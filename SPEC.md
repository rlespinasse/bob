# SPEC — Bob : second brains cloisonnés pour un EM de prestataires

> Statut : brouillon v0.8 — 2026-11-25. Les points marqués **[À VALIDER]** attendent une décision.

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
- **Recommandation du test : adapter, ne pas réécrire.** Priorités : entités personnalisées par brain, profils, secrets élargis, clés JSON préservées, champs de requête, `x-session-id` obligatoire, jeton par brain.

Points à challenger :

| Choix de la référence | Question |
|---|---|
| Python + spaCy, service séparé | Garder (≈445 Mo de RAM par instance, bonne détection du français) ou tout en TypeScript (une seule pile, détection plus faible) ? |
| Format OpenAI uniquement | Ajouter le format Anthropic pour Claude Code, ou passer par une conversion tierce ? |
| ~~Restitution non streamée~~ | Résolu : streaming et `tool_calls` déjà gérés par la référence. |
| Mapping en RAM, TTL 30 min | Convient à la sécurité, mais casse les sessions longues et les reprises. Alternative : mapping persisté dans le volume chiffré du brain. |
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

- **Un sandbox par brain** (microVM). Le brain est le workspace principal ; autres montages en `:ro` seulement. Mode `clone` possible pour travailler sur une copie privée.
- **Politique réseau** par sandbox : `deny-all` par défaut ; `sbx policy allow network localhost:8000` pour le proxy (accessible via `host.docker.internal`) et pour les destinations des connecteurs activés.
- **Secrets** : `UPSTREAM_API_KEY` (clé de la passerelle) reste côté hôte, détenue par le proxy ; elle n'entre jamais dans la VM. L'agent ne reçoit que le jeton local du proxy. `sbx` est déjà installé ; l'interaction avec l'injection de secrets de `sbx` est **à tester** en prototype.
- **Chiffrement** : le volume APFS du brain doit être monté **avant** le lancement du sandbox ; Bob arrête le sandbox avant de démonter/verrouiller.
- Cycle de vie : création au premier lancement, arrêt à la fermeture ou au verrouillage, suppression à l'offboarding du client (avec le brain).
- Pré-requis vérifiés au démarrage : Docker Sandboxes (`sbx`), opencode, proxy opérationnel (`GET /health`), clé de la passerelle présente. Sinon blocage avec message.

### 6.2 Ressources (MacBook Pro M2 16 Go)

Aucun modèle de langage local. La RAM sert à macOS, Docker, au proxy et au modèle spaCy `fr_core_news_lg` (détection d'entités), qui tient largement sur 16 Go.

### 6.3 Transcription vocale (Apple Speech, Anarlog)

- Reconnaissance vocale **sur l'appareil** d'Apple ; qualité jugée suffisante en français (à tester avec Anarlog).
- **Intégration Anarlog** : Anarlog est une app de notes de réunion locale (capture audio système sans bot, transcription en direct, stockage SQLite). Elle expose une CLI : `anarlog meetings export MEETING_ID --format markdown|json --output <fichier>`.
- Flux : tu enregistres dans Anarlog → dans Bob, tu choisis la réunion et le **brain cible** → Bob lance l'export vers `inbox/` du brain → tri et résumé par l'agent (via le proxy).
- Le cloisonnement se fait à l'import, par choix explicite du brain : Anarlog garde une seule base pour tous les clients.
- Réglages Anarlog recommandés : transcription on-device, résumés IA **désactivés** (Bob les fait, via le proxy) pour qu'aucun contenu ne parte hors du contrôle de Bob.
- Apple Speech est déjà supporté par Anarlog et utilisé par Romain.
- Points à vérifier **[À VALIDER]** : chiffrement de la base Anarlog (placer son dossier de données dans un volume chiffré, ou supprimer la réunion après export si la CLI le permet) ; stabilité de la CLI.
- Intégration optionnelle côté agent : Anarlog propose un plugin/skill d'agent ; non retenu en v1 pour ne pas ouvrir au sandbox l'ensemble des réunions de tous les clients.
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
3. Verrou de détection unique : effet sur les sous-agents parallèles d'opencode (à mesurer) ; 445 Mo par instance acceptable si une instance par brain ?
4. Interaction entre l'injection de secrets de `sbx` et le proxy (à tester au prototype).
5. Chiffrement et suppression côté Anarlog après export.
6. Combien de clients et de missions actifs à gérer, et quelle durée de conservation après la fin d'une mission ?
7. Niveau de confiance acceptable pour le filtrage par libellés sur le compte entreprise (§5) ?

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
