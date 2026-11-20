# Halles des Douze : notifications de bureau

Application Windows légère qui affiche les notifications de [Halles des Douze](https://halles-des-douze.fr) **même quand le navigateur est fermé**.

Elle se place dans la zone de notification, à côté de l'horloge, et affiche une notification Windows dès qu'un événement vous concerne : nouvelle commande, message, etc.

> Le code source est public pour que chacun puisse vérifier ce que fait l'application. Elle ne contient aucune publicité ni aucun traceur, et ne collecte rien d'autre que ce qui est décrit ci-dessous.

---

## Sommaire

- [Pourquoi cette application ?](#pourquoi-cette-application-)
- [Fonctionnalités](#fonctionnalités)
- [Installation](#installation)
- [Vérifier l'installeur](#vérifier-linstalleur)
- [Fonctionnement](#fonctionnement)
- [Données et confidentialité](#données-et-confidentialité)
- [Compiler depuis les sources](#compiler-depuis-les-sources)
- [Publier une version](#publier-une-version)
- [Licence](#licence)

---

## Pourquoi cette application ?

Les notifications web (Web Push) n'arrivent sur PC que si le navigateur tourne. Chrome et Firefox ne les reçoivent pas une fois fermés, et seul Edge continue de les recevoir en arrière-plan.

Cette application garde une connexion directe et légère avec Halles des Douze pour ne rien manquer, quel que soit votre navigateur.

Pour éviter les doublons, elle **se tait automatiquement dès que le site est ouvert** dans un navigateur, même réduit : c'est alors le site qui vous notifie.

| Situation | Qui affiche la notification ? |
|---|---|
| Le site est affiché à l'écran | Le site (message dans la page) |
| Le site est ouvert mais réduit ou dans un autre onglet | Le navigateur (Web Push) |
| Le site est fermé | **Cette application** |

---

## Fonctionnalités

- **Deux styles de notification**, au choix :
  - **Personnalisée** : une carte s'affiche par-dessus tout, comme sur Steam, dans le coin de l'écran de votre choix. Elle reste affichée tant que la souris est dessus, et un clic ouvre la bonne page du site.
  - **Windows** : la notification système classique.
- **Son de notification** dans les deux modes : un son par défaut ou votre propre fichier `.ogg` ou `.wav` (2 Mo maximum), avec réglage du volume. Vous pouvez couper le son depuis l'application ou par un clic droit sur l'icône de la zone de notification (**Couper le son**).
- **Historique des 10 derniers jours**, groupé par jour, avec lien vers le site pour chaque notification.
- **Regroupement** : une rafale de notifications devient une seule carte « X nouvelles notifications ».

> **Jeux en plein écran** : la notification personnalisée s'affiche par-dessus les jeux en mode *fenêtré sans bordure* (« plein écran fenêtré »), mais pas en plein écran *exclusif*. Dans ce dernier cas, seul le son est entendu. Choisissez le mode fenêtré sans bordure dans les options du jeu si vous voulez voir les notifications.

---

## Installation

1. Téléchargez le fichier `Halles des Douze_x.y.z_x64-setup.exe` depuis la page [Releases](../../releases/latest).
2. Lancez-le. Aucun droit administrateur n'est nécessaire.
3. **Avertissement de Windows SmartScreen** : l'application n'est pas encore signée par un certificat payant, donc Windows peut afficher « Windows a protégé votre ordinateur ». Cliquez sur **Informations complémentaires**, puis sur **Exécuter quand même**. Si vous voulez d'abord vous assurer que le fichier est authentique, voyez [Vérifier l'installeur](#vérifier-linstalleur).
4. Dans l'application, cliquez sur **Se connecter avec le site**. Une page s'ouvre dans votre navigateur : vérifiez que **le code affiché est identique** dans les deux fenêtres, puis cliquez sur **Autoriser**.

C'est terminé. Cochez **Lancer au démarrage de Windows** si vous voulez qu'elle démarre toute seule.

**Utilisation au quotidien**

- **Fermer la fenêtre** avec la croix la cache seulement : l'application continue de fonctionner dans la zone de notification.
- **Pour la quitter**, faites un clic droit sur son icône dans la zone de notification, puis **Quitter**.
- **Pour la désinstaller**, passez par Paramètres → Applications → Halles des Douze.

**Configuration requise** : Windows 10 ou 11 (64 bits). WebView2 est déjà présent sur ces versions.

---

## Vérifier l'installeur

Chaque installeur est compilé **automatiquement par GitHub Actions** à partir du code de ce dépôt. Il n'est jamais compilé sur une machine personnelle. Deux moyens de vérifier :

### 1. L'empreinte SHA-256

Chaque release contient un fichier `SHA256SUMS.txt`. Dans PowerShell, calculez l'empreinte du fichier téléchargé :

```powershell
Get-FileHash ".\Halles des Douze_x.y.z_x64-setup.exe" -Algorithm SHA256
```

Le résultat doit être identique à celui de `SHA256SUMS.txt`, sans tenir compte des majuscules et minuscules.

### 2. L'attestation de provenance (le plus fiable)

GitHub signe une attestation qui prouve que le fichier a été produit par le workflow de ce dépôt, à partir d'un commit précis. Avec la [CLI GitHub](https://cli.github.com) :

```
gh attestation verify ".\Halles des Douze_x.y.z_x64-setup.exe" --repo OWNER/REPO
```

Si la vérification réussit, le fichier n'a pas été modifié et provient bien de ce code source. Le workflow de compilation est consultable dans [`.github/workflows/release.yml`](.github/workflows/release.yml).

---

## Fonctionnement

### Connexion du compte

L'application ne vous demande **jamais votre mot de passe** et n'a jamais accès à votre session sur le site.

1. L'application génère un **jeton aléatoire** sur votre PC.
2. Elle ouvre une page du site avec **l'empreinte SHA-256** de ce jeton. Le site ne voit jamais le jeton lui-même.
3. Vous confirmez sur le site que le code affiché est le même. Le site associe alors cette empreinte à votre compte.
4. L'application utilise ensuite son jeton pour se connecter et recevoir vos notifications.

Le code de vérification protège contre l'hameçonnage : il empêche qu'on vous fasse autoriser l'application de quelqu'un d'autre.

Vous pouvez déconnecter un appareil à tout moment, depuis l'application (**Déconnecter cet appareil**) ou depuis vos paramètres sur le site. Le jeton est alors révoqué et la connexion coupée immédiatement.

### Réception des notifications

L'application maintient une connexion WebSocket (Socket.IO) avec le serveur du site et écoute les notifications qui vous sont destinées.

- **Regroupement** : si plusieurs notifications arrivent en même temps, elles sont regroupées en une seule (« 12 nouvelles notifications ») pour ne pas inonder Windows.
- **Historique** : chaque notification reçue est enregistrée **sur votre PC uniquement** pendant 10 jours. Le serveur, lui, ne conserve rien.
- **PC éteint ou application fermée** : les notifications envoyées pendant ce temps ne sont ni affichées ni ajoutées à l'historique. Rien n'est stocké en attente.

---

## Données et confidentialité

**Ce que l'application stocke sur votre PC**, dans `%APPDATA%\fr.halles-des-douze.notifier\settings.json` :

- votre jeton de connexion ;
- votre pseudo et votre avatar, pour l'affichage ;
- vos réglages (type de notification, emplacement, son, volume).

Dans le même dossier :

- `history.jsonl` : l'**historique des notifications reçues**, en clair, conservé **10 jours** puis supprimé automatiquement. Le bouton **Vider** de l'onglet Historique l'efface immédiatement ;
- `sounds\` : une **copie** de votre son personnalisé, si vous en avez choisi un.

**Ce que le serveur enregistre :**

- l'empreinte de votre jeton (jamais le jeton lui-même) ;
- le nom de l'appareil (le nom de votre PC Windows), pour que vous puissiez le reconnaître dans vos paramètres ;
- la date de création et de dernière utilisation de l'appareil.

**Ce que l'application ne fait pas :**

- elle ne lit pas vos fichiers et ne surveille pas votre activité ;
- elle n'envoie aucune statistique ni aucune télémétrie ;
- elle ne communique qu'avec `halles-des-douze.fr` ;
- elle ne contient ni publicité ni traceur.

L'application ne contient **aucun secret** : clé d'API, mot de passe ou clé serveur. Toute la sécurité repose sur le jeton propre à chaque appareil.

---

## Compiler depuis les sources

### Prérequis

- [Node.js](https://nodejs.org) 18 ou plus récent
- [Rust](https://rustup.rs) (chaîne `stable`) avec les *Microsoft C++ Build Tools*
- Windows 10 ou 11

### Installation

```
git clone https://github.com/OWNER/REPO.git
cd REPO
npm install
```

### Configuration

Copiez `.env.example` en `.env` et adaptez les URL si besoin :

```
VITE_SITE_URL=https://www.halles-des-douze.fr
VITE_SOCKET_URL=https://www.halles-des-douze.fr
VITE_SOCKET_PATH=/socket.io
```

### Développement

```
npm run tauri dev
```

La première compilation prend plusieurs minutes, les suivantes quelques secondes. En mode développement, les notifications Windows s'affichent sous le nom « PowerShell » : c'est normal, la version installée affiche le vrai nom de l'application.

### Créer l'installeur

```
npm run tauri build
```

L'installeur est généré dans `src-tauri/target/release/bundle/nsis/`.

### Structure du projet

```
├── index.html                  Fenêtre principale (accueil, historique, paramètres)
├── overlay.html                Fenêtre transparente des notifications personnalisées
├── public/sounds/notification.ogg   Son par défaut
├── src/
│   ├── main.js                 Connexion, liaison du compte, réception, son, historique
│   ├── overlay.js              Affichage des cartes de notification
│   ├── style.css
│   └── overlay.css
├── src-tauri/
│   ├── src/lib.rs              Icône et menu, overlay, historique sur 10 jours, son personnalisé
│   ├── tauri.conf.json         Configuration de l'application et de l'installeur
│   └── capabilities/           Permissions accordées à l'interface (liste minimale)
└── .github/workflows/
    └── release.yml             Compilation et publication automatiques
```

Construit avec [Tauri 2](https://tauri.app) : l'application pèse quelques mégaoctets, contre plus de 100 Mo pour une application Electron.

---

## Publier une version

1. Mettez à jour `"version"` dans `src-tauri/tauri.conf.json` (par exemple `0.2.0`).
2. Commitez, créez le tag correspondant et poussez :
   ```
   git tag v0.2.0
   git push origin main --tags
   ```
3. GitHub Actions compile l'installeur, génère l'attestation de provenance et les empreintes SHA-256, puis crée une **release en brouillon**.
4. Vérifiez la release dans l'onglet *Releases*, puis publiez-la.

Le workflow refuse de compiler si le tag ne correspond pas à la version de `tauri.conf.json`.

---

## Licence

Distribué sous licence MIT. Voir [`LICENSE`](LICENSE).

---

*Une question, un bug ou un doute sur la sécurité ? Ouvrez une [issue](../../issues).*
