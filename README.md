# D’amateur à pro

Application de paris sportifs **100 % gratuite** : on mise avec des jetons fictifs, sans argent réel, sur le football, le rugby et le tennis, du district aux pros.

## Fonctionnalités
- **3 sports et 33 niveaux** : de la Départementale 4 à la Ligue des champions, de la Régionale 3 à la Champions Cup, du tournoi de club à l’ATP/WTA.
- **Paris sur les stats** :
  - foot : cartons jaunes et rouges, penalty, fautes, corners, hors-jeux, tirs cadrés, buts ;
  - rugby : essais, pénalités réussies et ratées, drops, cartons ;
  - tennis : sets, jeux, tie-break, breaks, aces, doubles fautes, raquette cassée.
- **Cotes calculées automatiquement** : chaque match est simulé 1 500 fois (Monte-Carlo).
- **Matchs pros automatiques** : calendrier, scores et stats viennent du flux public ESPN.
- **Matchs amateurs** : ajoutés par un organisateur, qui saisit ensuite le score et les stats. Sinon, des matchs simulés (clairement indiqués) permettent de jouer.
- **Règlement automatique** des paris. Remboursement si le match est reporté ou si la stat n’est jamais publiée.
- **Carrière** de la D4 à la Ligue des champions, badges, bonus quotidien. L’app s’installe sur l’écran d’accueil (PWA).

## Technique
Un seul fichier `index.html`, sans dépendance ni étape de build. Les données sont enregistrées dans le navigateur (`localStorage`).

## À venir
Base de données partagée (comptes, ligues entre amis, classement commun, matchs de l’organisateur visibles par tous).

---
Jeu de divertissement. Les jeux d’argent comportent des risques : Joueurs Info Service, 09 74 75 13 13.
