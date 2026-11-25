# SPEC — Bob : second brains cloisonnés pour un EM de prestataires

> Statut : brouillon v0.2 — 2026-11-25. Les points marqués **[À VALIDER]** attendent une décision.

## 1. Contexte et objectifs

Romain est prestataire informatique et Engineering Manager d'une équipe de consultants, chacun en mission chez un client (missions longues ou courtes). Il travaille aussi avec ses collègues au sein de l'agence.

Il utilise Claude Code et opencode (installés en local) ainsi que les connecteurs Claude (mail, agenda, Drive). Les données de chaque client doivent rester séparées. Certaines exigent des traitements de sécurité.

**Bob** est une application locale (web UI sur `localhost`) qui :

1. gère un *second brain* par client, isolé des autres ;
2. lance l'agent IA adapté (Claude Code ou opencode) dans le bon brain, avec les bons connecteurs ;
3. applique une politique de sécurité selon le niveau de sensibilité du brain ;
4. couvre quatre usages : suivi des consultants, veille client/mission, briefing quotidien, pipeline commercial.

### Hors périmètre (v1)

- Hébergement distant, multi-utilisateur, synchronisation cloud des brains.
- Développement d'un nouvel agent IA : Bob orchestre Claude Code et opencode, il ne les remplace pas.
- Application desktop native.

## 2. Principes directeurs

- **Local d'abord** : aucune donnée de brain ne quitte la machine, sauf via un moteur autorisé par la politique du brain.
- **Cloisonnement par construction** : un brain actif à la fois par session, jamais de contexte croisé entre clients.
- **Fichiers lisibles** : le contenu reste en Markdown, exploitable sans Bob.
- **Refus par défaut** : en cas de doute sur le niveau ou le moteur, Bob bloque et demande.

## 3. Modèle de données

### 3.1 Brains

| Brain | Rôle | Exemple de contenu |
|---|---|---|
| `client/<slug>` | Un brain par client ; missions en sous-dossiers | contexte, décisions, risques, comptes rendus, consultants affectés |
| `team` | Équipe d'EM (transverse, **données RH**) | 1:1, objectifs, évaluations, compétences, fins de mission |
| `agency` | Vie d'agence et pipeline | staffing, renouvellements, opportunités, collègues EM |
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
engine: claude-code     # claude-code | opencode
opencode:
  provider: local       # utilisé si engine=opencode
  model: <modèle local>
encryption: true
connectors:
  account: client-acme  # profil de compte dédié, ou "agency" (compte agence filtré)
  mail:     { labels: ["ACME"] }
  calendar: { calendars: ["ACME"] }
  drive:    { folders: ["<id dossier>"] }
anonymize:
  rules: [people, emails, secrets, client-name]
```

## 4. Classification et politique de sécurité

Trois niveaux, appliqués au **brain entier**.

| Niveau | Moteur autorisé | Traitement |
|---|---|---|
| `open` | Claude Code ou opencode | Aucun traitement spécial. Audit actif. |
| `restricted` | Claude Code **après anonymisation**, ou opencode | Pseudonymisation avant envoi au LLM, réhydratation locale de la réponse. |
| `forbidden` | opencode + **modèle local uniquement** | Aucun appel réseau vers un LLM. Connecteurs cloud désactivés (ou lecture seule locale **[À VALIDER]**). |

Décisions : `team` = `forbidden` (données RH). Aucun client n'interdit formellement l'IA externe aujourd'hui, mais par prudence tout brain client démarre en `restricted` jusqu'à classification explicite.

### 4.1 Routage des moteurs

Bob choisit le moteur d'après `sensitivity`. L'utilisateur ne peut pas lancer Claude Code sur un brain `forbidden` : Bob refuse et l'indique. Un changement de niveau est journalisé et demande une confirmation explicite.

### 4.2 Anonymisation / masquage

- Détection locale : personnes (liste des consultants et contacts du brain), e-mails, téléphones, noms de client, secrets (clés, tokens, mots de passe, motifs `.env`).
- Remplacement par des jetons stables (`[PERSONNE_3]`, `[CLIENT]`) ; table de correspondance stockée dans le brain, chiffrée avec lui.
- Réhydratation locale de la réponse avant affichage.
- Les secrets sont **supprimés** (non pseudonymisés) et ne sont jamais réhydratés.
- Limite connue : l'anonymisation de texte libre est imparfaite ; elle réduit le risque, elle ne remplace pas l'autorisation contractuelle du client **[À VALIDER : la politique des clients exige-t-elle plus ?]**.

### 4.3 Chiffrement au repos

- Décision : un volume APFS chiffré (image disque) par brain, monté à la demande, mot de passe dans le Keychain macOS. Transparent pour les agents une fois monté.
- Déverrouillage à la demande (mot de passe ou Keychain macOS), verrouillage automatique après inactivité (défaut 30 min).
- L'index SQLite et la table d'anonymisation sont dans le brain chiffré.

### 4.4 Audit et cloisonnement

- **Un seul brain monté par session agent.** L'agent reçoit le brain courant comme répertoire de travail, sans accès aux autres chemins (sandbox : permissions Claude Code `deny` hors du brain, équivalent côté opencode).
- Journal `audit.jsonl` (append-only) : ouverture/fermeture de brain, moteur utilisé, connecteurs activés, changements de niveau, appels bloqués, exports. Le journal ne contient **pas** le contenu des échanges.
- Anti-fuite : un brain `forbidden` ne peut pas être cité ni copié dans un brain d'un niveau inférieur (contrôle sur export/copie).

## 5. Connecteurs (mail, agenda, Drive)

Mode **mixte** :

- **Compte agence** : brains `agency`, `team`, `personal` et clients tolérants. Bob filtre par libellés (mail), calendriers dédiés et dossiers Drive.
- **Comptes/profils dédiés** : clients stricts ; connecteurs activés uniquement quand ce brain est actif.

Règles :

- À l'ouverture d'un brain, Bob n'active que les connecteurs déclarés dans `brain.yaml`, et désactive les autres de la session.
- Les connecteurs cloud sont coupés pour les brains `forbidden`. Pour eux, import manuel dans `inbox/` (export mail, ICS, fichiers).
- Le filtrage par libellé ne vaut pas isolation forte : une requête mal cadrée peut lire hors périmètre. Mitigation : consigne dans `CLAUDE.md` du brain et vérification dans l'audit. **[À VALIDER : niveau de confiance acceptable pour les clients tolérants]**
- Écriture (envoi de mail, création d'événement) : confirmation explicite à chaque action.

## 6. Moteurs IA

| Moteur | Usage | Lancement par Bob |
|---|---|---|
| Claude Code | Brains `open`/`restricted` | `claude` dans le répertoire du brain, avec `CLAUDE.md`, permissions et connecteurs du brain |
| opencode | Brains `forbidden` (modèle local), ou `restricted` sans cloud | `opencode` dans le répertoire du brain, provider/modèle de `brain.yaml` |

Pré-requis détectés au démarrage : binaires installés, version, modèle local disponible. Sinon Bob affiche une alerte et bloque les brains concernés.

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
- Recherche transverse : métadonnées uniquement (titres, dates, étiquettes), brains `forbidden` exclus.

## 8. Web UI locale

- Serveur lié à `127.0.0.1`, jeton de session aléatoire, pas d'accès réseau externe.
- Écrans : liste des brains (niveau, verrou, moteur), tableau de bord/briefing, brain (notes, inbox, recherche), lancement de session agent (terminal intégré), journal d'audit, réglages.
- Bandeau de contexte permanent : brain actif, niveau, moteur, connecteurs activés.
- Verrouillage visuel et déconnexion des sessions à l'inactivité.

## 9. Architecture (proposition)

- **Backend local** : service unique en TypeScript (décision) exposant l'API de la UI, gérant brains, index SQLite, audit, anonymisation, politique de routage.
- **Lanceur d'agents** : processus enfant dans un pty, avec variables d'environnement, répertoire de travail et permissions du brain.
- **Politique** : module central qui décide moteur, connecteurs et anonymisation ; tous les chemins (UI, planificateur, CLI) passent par lui.
- **Index** : SQLite par brain (FTS5 + embeddings locaux), reconstruit depuis les fichiers.
- **Frontend** : SPA légère servie par le backend.

## 10. Exigences non fonctionnelles

- Fonctionne hors-ligne pour les brains `forbidden`.
- Aucune télémétrie.
- Sauvegarde : dépôts git locaux par brain ; export chiffré possible. Aucune sauvegarde cloud par défaut.
- Offboarding d'un client : suppression ou archivage chiffré d'un brain en une commande, avec trace d'audit.
- macOS en priorité (Keychain, volumes chiffrés).

## 11. Critères d'acceptation (v1)

1. Créer un brain client avec niveau, moteur et connecteurs ; refus si la configuration est incohérente (ex. `forbidden` + Claude Code).
2. Ouvrir une session Claude Code sur un brain `open` : seuls ses connecteurs sont actifs, aucun accès aux autres brains.
3. Sur un brain `restricted`, un texte contenant un nom de consultant et un secret arrive au LLM pseudonymisé/purgé et revient réhydraté (hors secrets).
4. Sur un brain `forbidden`, aucun appel réseau LLM ni connecteur cloud (vérifié par test).
5. Un brain chiffré verrouillé est illisible (fichiers, index, table d'anonymisation) et se verrouille après inactivité.
6. L'audit enregistre chaque ouverture, changement de niveau et blocage, sans contenu.
7. Le briefing quotidien n'affiche aucun contenu croisé entre brains.

## 12. Jalons proposés

1. **M1 — Socle** : structure des brains, `brain.yaml`, git par brain, UI de liste, audit.
2. **M2 — Lanceur et routage** : Claude Code/opencode, politique, cloisonnement des connecteurs.
3. **M3 — Sécurité** : chiffrement, verrouillage, anonymisation.
4. **M4 — Usages** : suivi consultants, veille, inbox, index/recherche.
5. **M5 — Briefing et pipeline** : briefing planifié, vue agence.

## 13. Questions ouvertes

1. Modèle local pour opencode : lequel, et sur quelle machine (Apple Silicon, RAM) ?
2. Les collègues EM ont-ils accès à une partie de `agency` (partage entre personnes) ?
3. Combien de clients et de missions actifs à gérer, et quelle durée de conservation après la fin d'une mission ?
4. Les comptes dédiés par client existent-ils déjà (mail/agenda/Drive), ou seulement le compte agence ?
5. Niveau de confiance acceptable pour le filtrage par libellés sur le compte agence (§5) ?
6. Les clients exigent-ils plus que l'anonymisation pour `restricted` (§4.2) ?

## 14. Décisions prises

- Un brain par client ; `team`, `agency`, `personal` à part.
- Trois niveaux : `open`, `restricted`, `forbidden` ; `team` = `forbidden`.
- Aucun client n'interdit l'IA externe aujourd'hui : départ en `restricted`.
- Web UI locale ; backend TypeScript.
- Markdown + SQLite par brain ; chiffrement par volume APFS.
- Connecteurs en mode mixte.
