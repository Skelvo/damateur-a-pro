# Notes de reprise (pour une nouvelle session Claude)

Dernière mise à jour : 15 novembre 2026, version **v3.16**.

## Le projet
- **Tribune** : appli web installable (PWA) de pronostics sportifs entre potes, 100 % gratuite, jetons fictifs, 18+. Tout en français.
- En ligne : https://damateur-a-pro.vercel.app (projet Vercel `damateur-a-pro`, déploiement automatique à chaque push sur `main`).
- Fichiers : `index.html`, `app.js` (appli), `engine.js` (moteur partagé appli/serveur : cotes, marchés, règlement), `app.css`, `sw.js` (service worker), `api/game.js` (serveur, une seule fonction Vercel, `POST {action}`), `api/_db.js` (schéma Postgres Neon, `SCHEMA_VERSION`), `api/_bets.js` (règlement serveur), `api/_social.js` (publication Insta/Facebook), `programme/` (tableau de bord des publications, protégé par code).
- Données des matchs : flux public ESPN.

## Routine de mise en ligne (à chaque modif de l'appli)
1. `const VERSION="x.yz"` dans `app.js`
2. `?v=x.yz` dans `index.html` et dans la liste `SHELL` de `sw.js`
3. `version.txt`
4. nom du cache `dap-vNNN` dans `sw.js` (+1)
Puis commit + push sur `main`, et vérifier `https://damateur-a-pro.vercel.app/version.txt`.

## Administration
- Les actions `admin_*` du serveur demandent la clé `ADMIN_KEY` (variable d'environnement Vercel du projet). **Ne jamais la mettre dans le dépôt** (dépôt public). La demander à l'utilisateur ou la lire dans Vercel avec son accord.
- Utiles : `admin_audit` (soldes), `admin_ledger` (un joueur : registre, paris serveur et téléphone), `admin_bets`, `admin_void`, `admin_adjust` (correction de solde), `admin_cos_all` (tout débloquer), `admin_tv` (chaîne télé d'un match), `admin_push_diag` (notifications, réveils du serveur), `admin_social_list/add/run/nets/set` (publications), `admin_backup` (copie complète).
- Réveil du serveur : cron-job.org toutes les minutes + Vercel Schedules toutes les 15 min + GitHub Actions (secours) + les applis ouvertes. Route : `/api/game?cron=1&slot=tick`.

## Où on en est
- **15/11 : bascule « serveur maître des soldes » (v3.16)**. Chaque compte bascule à la prochaine ouverture de l'appli à jour (`players.master = true`). Ensuite le serveur fait tous les mouvements (mises, gains, roue, défis, duels, récompenses) via `credit()` / `masterCredit()`, et le téléphone affiche le solde renvoyé par `sync`. Une sauvegarde complète a été faite juste avant (fichier temporaire de l'ancienne session, pas dans le dépôt).
- À vérifier : que les comptes basculés ont des soldes cohérents (`admin_audit`, champ `master`).
- Récompenses : guilde au mois (+1000/+500/+250/+25), semaine dans chaque guilde (+200/+100/+50, le lundi), général du mois (+1500/+750/+400, le 1er). Seuls les joueurs avec au moins un pari terminé sur la période sont classés.

## Règles à respecter
- Réponses à l'utilisateur **en français**, simples et claires.
- **Supabase** : ne jamais toucher aux projets « Axoo64's Project » et « scanette ».
- Publicités et posts : vocabulaire « pronos / ticket / jetons », jamais « pari / cote / mise / argent » ; **aucun logo de club ni de compétition** ; émojis Apple sur les visuels ; chaque étiquette de lien soignée avec au moins un émoji ; vérifier l'horaire du match sur ESPN (heure de Paris) avant une publication.
- Pas d'usage des logos de clubs dans des bannières ou styles (marques déposées).
- Ne jamais committer de secret (clés Meta, clé admin…).

## Idées en attente
- Paris sur un joueur : les ajouter à « Parier pareil » et leur donner un état en direct.
- Bilan de la guilde le dimanche soir ; mini-classements (le plus précis, le plus fou, le chat noir).
- Pro D2 : pas dans ESPN (TheSportsDB payant, ou matchs ajoutés par les joueurs).
- Découper `app.js` pour accélérer le tout premier lancement.
