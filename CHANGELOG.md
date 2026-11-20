# Changelog

Toutes les évolutions notables de l'application de bureau Halles des Douze sont listées ici.

Le format s'inspire de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/), et le projet suit le [versionnage sémantique](https://semver.org/lang/fr/).

---

## [0.2.0] - 2026-11-20

### Ajouté

- **Notifications personnalisées (overlay)** : une carte s'affiche par-dessus toutes les fenêtres, à la manière de Steam.
  - Emplacement au choix parmi les quatre coins de l'écran, sélectionnable sur un aperçu d'écran.
  - Couleur selon le type de notification (succès, info, avertissement, erreur), appliquée à la bordure et à la barre de progression.
  - Barre de temps restant, mise en pause tant que la souris survole la carte.
  - Un clic sur la carte ouvre la page correspondante sur le site ; une croix permet de la fermer.
  - Quatre cartes affichées au maximum : au-delà, la plus ancienne disparaît.
  - Les clics traversent l'overlay quand aucune notification n'est affichée : il ne gêne jamais l'application en dessous.
- **Choix du type de notification** : personnalisée (overlay) ou notification Windows classique.
- **Son de notification**, dans les deux modes :
  - son par défaut inclus dans l'application, ou fichier personnel `.ogg` ou `.wav` (2 Mo maximum) ;
  - réglage du volume ;
  - coupure du son depuis les paramètres, le bouton 🔊 de la fenêtre, ou le menu de l'icône de la zone de notification (**Couper le son**). Les trois restent synchronisés.
- **Historique des notifications** sur 10 jours, groupé par jour (« Aujourd'hui », « Hier », puis la date), avec un lien vers le site pour chaque notification. L'historique est stocké uniquement sur le PC et vidable à tout moment.
- **Onglets** Accueil, Historique et Paramètres dans la fenêtre principale.
- **Bouton de notification de test**, avec un type tiré au hasard pour prévisualiser chaque couleur.
- Indication à l'écran quand le site est ouvert dans un navigateur (l'application reste alors silencieuse).
- Logo Halles des Douze sur les cartes de notification.

### Modifié

- Les notifications s'affichent **immédiatement** à leur réception, sans délai d'attente.
- Fenêtre principale agrandie (420 × 640) pour accueillir les onglets.

### Supprimé

- Le regroupement des notifications en rafale (« X nouvelles notifications »), qui retardait leur affichage. Les rafales restent maîtrisées par la limite de quatre cartes et par un son joué au plus toutes les 0,8 seconde.

---

## [0.1.4] - 2026-11-18

### Corrigé

- La liaison du compte restait bloquée sur « En attente de validation ». Les requêtes vers `halles-des-douze.fr` étaient redirigées vers `www.halles-des-douze.fr`, et l'en-tête d'authentification était retiré à la redirection. L'application s'adresse désormais directement à `www.halles-des-douze.fr`.

### Modifié

- Les appels HTTP passent par le module HTTP de Tauri, côté Rust, et non plus par le navigateur intégré. Ils ne sont plus soumis aux restrictions CORS.
- La liste des sites que l'application a le droit de contacter est déclarée explicitement dans `capabilities/default.json`.

---

## [0.1.3] - 2026-11-18

### Ajouté

- Première version de l'application de bureau.
- **Liaison sécurisée du compte** : l'application génère un jeton sur le PC, le site n'en connaît que l'empreinte, et un code de vérification s'affiche des deux côtés.
- Réception des notifications en temps réel via Socket.IO.
- Notifications Windows natives.
- **Silence automatique quand le site est ouvert** dans un navigateur, même réduit, pour éviter les doublons avec les notifications du site.
- Icône dans la zone de notification, avec un menu Ouvrir / Quitter.
- Fermer la fenêtre la masque sans quitter l'application.
- Option de lancement au démarrage de Windows (démarrage discret dans la zone de notification).
- Une seule instance de l'application à la fois.
- Déconnexion de l'appareil depuis l'application ou depuis le site.
- Installeur Windows (NSIS) compilé par GitHub Actions, avec empreintes SHA-256 et attestation de provenance.
- Message « Impossible de joindre le serveur » pendant la liaison si le site ne répond pas, au lieu d'une attente sans fin.

[0.2.0]: ../../compare/v0.1.4...v0.2.0
[0.1.4]: ../../compare/v0.1.3...v0.1.4
[0.1.3]: ../../releases/tag/v0.1.3