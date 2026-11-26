import { denyCommands } from "./sandbox/sbx.ts";

// Affiche les commandes de refus explicite à exécuter par Romain : Bob ne modifie jamais la politique globale.
console.log("# Refus explicites des hôtes que le kit opencode de sbx autorise dans chaque sandbox");
for (const command of denyCommands()) console.log(command);
