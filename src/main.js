import { io } from "socket.io-client";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
// fetch côté Rust : pas de CORS entre l'app (tauri.localhost) et le site
import { fetch } from "@tauri-apps/plugin-http";
import { load } from "@tauri-apps/plugin-store";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import {
    isPermissionGranted,
    requestPermission,
    sendNotification,
} from "@tauri-apps/plugin-notification";

const SITE_URL = import.meta.env.VITE_SITE_URL ?? "https://www.halles-des-douze.fr";
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL ?? SITE_URL;
const SOCKET_PATH = import.meta.env.VITE_SOCKET_PATH ?? "/socket.io";

const LINK_TIMEOUT_MS = 10 * 60 * 1000;
const LINK_POLL_MS = 2000;
const LINK_NETWORK_ERRORS_BEFORE_WARNING = 3;

const HISTORY_RETENTION_MS = 10 * 24 * 60 * 60 * 1000; // 10 jours (purge du fichier côté Rust)

const DEFAULT_SOUND_URL = "/sounds/notification.ogg";
const SOUND_MIN_INTERVAL_MS = 800; // pas de rafale de sons

const DEFAULT_PREFS = {
    mode: "custom",            // "custom" (overlay) | "windows"
    corner: "bottom-right",    // top-left | top-right | bottom-left | bottom-right
    sound: {
        source: "default",     // "default" | "custom"
        customName: null,      // nom du fichier choisi (affichage)
        volume: 60,            // 0 à 100
        muted: false,
    },
};

const $ = (id) => document.getElementById(id);

const els = {
    screens: {
        loading: $("screen-loading"),
        login: $("screen-login"),
        linking: $("screen-linking"),
        connected: $("screen-connected"),
    },
    btnMute: $("btn-mute"),

    loginError: $("login-error"),
    btnLink: $("btn-link"),
    linkCode: $("link-code"),
    linkStatus: $("link-status"),
    btnReopen: $("btn-reopen"),
    btnCancel: $("btn-cancel"),

    tabs: [...document.querySelectorAll(".tab")],
    panels: {
        home: $("tab-home"),
        history: $("tab-history"),
        settings: $("tab-settings"),
    },

    avatar: $("user-avatar"),
    userName: $("user-name"),
    statusDot: $("status-dot"),
    statusText: $("status-text"),
    siteOpenHint: $("site-open-hint"),
    autostart: $("opt-autostart"),
    btnTest: $("btn-test"),
    btnLogout: $("btn-logout"),

    history: $("history"),
    historyCount: $("history-count"),
    btnClearHistory: $("btn-clear-history"),

    modeRadios: [...document.querySelectorAll('input[name="mode"]')],
    cornerGroup: $("corner-group"),
    cornerButtons: [...document.querySelectorAll(".corner-btn")],
    soundSourceRadios: [...document.querySelectorAll('input[name="sound-source"]')],
    soundFileName: $("sound-file-name"),
    btnChooseSound: $("btn-choose-sound"),
    soundError: $("sound-error"),
    soundVolume: $("sound-volume"),
    soundVolumeValue: $("sound-volume-value"),
    soundMuted: $("sound-muted"),
    windowsSoundHint: $("windows-sound-hint"),
};

let store = null;
let prefs = structuredClone(DEFAULT_PREFS);
let socket = null;
let pollTimer = null;
let siteOpen = false; // site ouvert dans un navigateur (même réduit) : c'est lui qui notifie
let currentTab = "home";
let historyItems = [];
let customSoundUrl = null;
let lastSoundAt = 0;

/* ================= Utilitaires ================= */

function toHex(bytes) {
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(size = 32) {
    const bytes = new Uint8Array(size);
    crypto.getRandomValues(bytes);
    return toHex(bytes);
}

async function sha256Hex(text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return toHex(new Uint8Array(digest));
}

function formatCode(hash) {
    return `${hash.slice(0, 3)}-${hash.slice(3, 6)}`.toUpperCase();
}

function absoluteUrl(path) {
    if (!path) return SITE_URL;
    return path.startsWith("http") ? path : `${SITE_URL}${path.startsWith("/") ? "" : "/"}${path}`;
}

function showScreen(name) {
    Object.entries(els.screens).forEach(([key, el]) => {
        el.classList.toggle("hidden", key !== name);
    });
}

function setStatus(state) {
    els.statusDot.className = `dot ${state}`;
    els.statusText.textContent = {
        online: "Connecté, en écoute",
        offline: "Hors ligne, reconnexion…",
        connecting: "Connexion…",
    }[state];
}

function showTab(name) {
    currentTab = name;
    els.tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
    Object.entries(els.panels).forEach(([key, panel]) => {
        panel.classList.toggle("hidden", key !== name);
    });

    if (name === "history") renderHistory();
}

/* ================= Préférences ================= */

function mergePrefs(saved) {
    return {
        ...DEFAULT_PREFS,
        ...(saved ?? {}),
        sound: { ...DEFAULT_PREFS.sound, ...(saved?.sound ?? {}) },
    };
}

async function savePrefs() {
    await store.set("prefs", prefs);
}

function applyPrefsToUi() {
    els.modeRadios.forEach((radio) => {
        radio.checked = radio.value === prefs.mode;
    });

    els.cornerGroup.classList.toggle("hidden", prefs.mode !== "custom");
    els.windowsSoundHint.classList.toggle("hidden", prefs.mode !== "windows");

    els.cornerButtons.forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.corner === prefs.corner);
    });

    els.soundSourceRadios.forEach((radio) => {
        radio.checked = radio.value === prefs.sound.source;
        if (radio.value === "custom") radio.disabled = !prefs.sound.customName;
    });

    els.soundFileName.textContent = prefs.sound.customName ?? "aucun";
    els.soundVolume.value = String(prefs.sound.volume);
    els.soundVolumeValue.textContent = `${prefs.sound.volume} %`;
    els.soundMuted.checked = prefs.sound.muted;

    els.btnMute.textContent = prefs.sound.muted ? "🔇" : "🔊";
    els.btnMute.title = prefs.sound.muted ? "Réactiver le son" : "Couper le son";
    els.btnMute.classList.toggle("muted-on", prefs.sound.muted);
}

async function setMuted(muted) {
    prefs.sound.muted = muted;
    applyPrefsToUi();
    await savePrefs();
    invoke("set_tray_muted", { muted }).catch((err) => console.error("set_tray_muted", err));
}

/* ================= Son ================= */

async function loadCustomSound() {
    if (customSoundUrl) {
        URL.revokeObjectURL(customSoundUrl);
        customSoundUrl = null;
    }

    if (prefs.sound.source !== "custom" || !prefs.sound.customName) return;

    try {
        const buffer = await invoke("read_sound");
        const isOgg = prefs.sound.customName.toLowerCase().endsWith(".ogg");
        const blob = new Blob([buffer], { type: isOgg ? "audio/ogg" : "audio/wav" });
        customSoundUrl = URL.createObjectURL(blob);
    } catch (err) {
        console.error("Son personnalisé introuvable, retour au son par défaut", err);
        prefs.sound.source = "default";
        prefs.sound.customName = null;
        applyPrefsToUi();
        await savePrefs();
    }
}

function playSound({ force = false } = {}) {
    if (prefs.sound.muted || prefs.sound.volume <= 0) return;

    const now = Date.now();
    if (!force && now - lastSoundAt < SOUND_MIN_INTERVAL_MS) return;
    lastSoundAt = now;

    const src = prefs.sound.source === "custom" && customSoundUrl ? customSoundUrl : DEFAULT_SOUND_URL;
    const audio = new Audio(src);
    audio.volume = prefs.sound.volume / 100;
    audio.play().catch((err) => console.error("Lecture du son impossible", err));
}

async function chooseSoundFile() {
    els.soundError.classList.add("hidden");

    const path = await openFileDialog({
        multiple: false,
        directory: false,
        filters: [{ name: "Son (.ogg, .wav)", extensions: ["ogg", "wav"] }],
    });

    if (!path || Array.isArray(path)) return;

    try {
        const name = await invoke("import_sound", { path });
        prefs.sound.source = "custom";
        prefs.sound.customName = name;
        await savePrefs();
        await loadCustomSound();
        applyPrefsToUi();
        playSound({ force: true });
    } catch (err) {
        els.soundError.textContent = String(err);
        els.soundError.classList.remove("hidden");
    }
}

/* ================= Historique ================= */

function isSameDay(a, b) {
    return a.getFullYear() === b.getFullYear()
        && a.getMonth() === b.getMonth()
        && a.getDate() === b.getDate();
}

function dayKey(timestamp) {
    const d = new Date(timestamp);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(timestamp) {
    const date = new Date(timestamp);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);

    if (isSameDay(date, today)) return "Aujourd'hui";
    if (isSameDay(date, yesterday)) return "Hier";

    const label = date.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
    return label.charAt(0).toUpperCase() + label.slice(1);
}

async function loadHistory() {
    try {
        historyItems = await invoke("history_list");
    } catch (err) {
        console.error("history_list", err);
        historyItems = [];
    }

    renderHistory();
}

function renderHistory() {
    const cutoff = Date.now() - HISTORY_RETENTION_MS;
    historyItems = historyItems.filter((item) => item.at >= cutoff);

    const total = historyItems.length;
    els.historyCount.textContent = total === 0
        ? ""
        : `${total} notification${total > 1 ? "s" : ""} sur 10 jours`;
    els.btnClearHistory.disabled = total === 0;

    els.history.replaceChildren();

    if (total === 0) {
        const empty = document.createElement("p");
        empty.className = "empty";
        empty.textContent = "Aucune notification reçue pour le moment.";
        els.history.appendChild(empty);
        return;
    }

    // historyItems est trié du plus récent au plus ancien
    const groups = new Map();
    for (const item of historyItems) {
        const key = dayKey(item.at);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    }

    for (const items of groups.values()) {
        const section = document.createElement("section");
        section.className = "day";

        const heading = document.createElement("h3");
        heading.textContent = dayLabel(items[0].at);
        const count = document.createElement("span");
        count.textContent = String(items.length);
        heading.appendChild(count);

        const list = document.createElement("ul");

        for (const item of items) {
            const li = document.createElement("li");

            const time = document.createElement("time");
            time.textContent = new Date(item.at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

            const body = document.createElement("div");

            if (item.title) {
                const title = document.createElement("span");
                title.className = "entry-title";
                title.textContent = item.title;
                body.appendChild(title);
            }

            const message = document.createElement("span");
            message.className = "entry-message";
            message.textContent = item.message;
            body.appendChild(message);

            li.append(time, body);

            if (item.url) {
                li.classList.add("clickable");
                li.title = "Ouvrir sur le site";
                li.onclick = () => openUrl(absoluteUrl(item.url));
            }

            list.appendChild(li);
        }

        section.append(heading, list);
        els.history.appendChild(section);
    }
}

async function clearHistory() {
    try {
        await invoke("history_clear");
        historyItems = [];
        renderHistory();
    } catch (err) {
        console.error("history_clear", err);
    }
}

/* ================= Affichage des notifications ================= */

async function ensureWindowsPermission() {
    if (!(await isPermissionGranted())) {
        await requestPermission();
    }
}

function displayNotification(item) {
    if (prefs.mode === "windows") {
        sendNotification({ title: item.title || "Halles des Douze", body: item.message });
        return;
    }

    emitTo("overlay", "overlay:notify", {
        notification: item,
        corner: prefs.corner,
        siteUrl: SITE_URL,
    }).catch((err) => console.error("overlay:notify", err));
}

/** Affichage immédiat, comme le bouton de test (l'overlay limite lui-même à 4 cartes) */
function showNow(item) {
    playSound(); // limité à un son toutes les 0,8 s en cas de rafale
    displayNotification(item);
}

function handleNotification(payload) {
    const notification = payload?.notification;
    if (!notification?.message) return;

    const entry = {
        id: randomHex(8),
        at: Date.now(),
        title: notification.title ?? null,
        message: String(notification.message),
        url: notification.url ?? null,
        type: notification.type ?? "info",
    };

    // L'historique garde tout, même quand le site s'en charge
    historyItems.unshift(entry);
    invoke("history_add", { entry }).catch((err) => console.error("history_add", err));
    if (currentTab === "history" && !els.screens.connected.classList.contains("hidden")) {
        renderHistory();
    }

    // Le site est ouvert (visible ou réduit) : il notifie lui-même (toast ou Web Push)
    if (siteOpen) return;

    showNow(entry);
}

function sendTestNotification() {
    playSound({ force: true });
    displayNotification({
        title: "Halles des Douze",
        message: prefs.mode === "custom"
            ? "Notification de test : voici où elles s'afficheront."
            : "Notification de test.",
        url: null,
        type: "success",
    });
}

/* ================= API ================= */

/** Renvoie les infos utilisateur, "unauthorized", ou null en cas d'erreur réseau */
async function fetchMe(token) {
    try {
        const response = await fetch(`${SITE_URL}/api/desktop/me`, {
            headers: { Authorization: `Bearer ${token}` },
        });

        if (response.status === 401) return "unauthorized";

        if (!response.ok) {
            console.error(`GET /api/desktop/me : HTTP ${response.status}`);
            return null;
        }

        return await response.json();
    } catch (err) {
        console.error("GET /api/desktop/me : erreur réseau", err);
        return null;
    }
}

/* ================= Liaison du compte ================= */

function showLogin(message = null) {
    clearInterval(pollTimer);
    els.loginError.textContent = message ?? "";
    els.loginError.classList.toggle("hidden", !message);
    showScreen("login");
}

async function startLinking() {
    const token = randomHex(32);
    const hash = await sha256Hex(token);

    let deviceName = "Application de bureau";
    try {
        deviceName = await invoke("device_name");
    } catch {}

    const url = `${SITE_URL}/desktop/link?h=${hash}&name=${encodeURIComponent(deviceName)}`;

    els.linkCode.textContent = formatCode(hash);
    els.linkStatus.textContent = "En attente de validation…";
    els.linkStatus.classList.remove("error");
    els.btnReopen.onclick = () => openUrl(url);
    showScreen("linking");

    await openUrl(url);

    const startedAt = Date.now();
    let networkErrors = 0;
    clearInterval(pollTimer);

    pollTimer = setInterval(async () => {
        if (Date.now() - startedAt > LINK_TIMEOUT_MS) {
            showLogin("Le délai est dépassé, recommencez la connexion.");
            return;
        }

        const me = await fetchMe(token);

        // Erreur réseau répétée : on le dit au lieu d'attendre sans fin
        if (me === null) {
            networkErrors += 1;

            if (networkErrors >= LINK_NETWORK_ERRORS_BEFORE_WARNING) {
                els.linkStatus.textContent = `Impossible de joindre ${SITE_URL}. Nouvelle tentative…`;
                els.linkStatus.classList.add("error");
            }
            return;
        }

        if (networkErrors > 0) {
            networkErrors = 0;
            els.linkStatus.textContent = "En attente de validation…";
            els.linkStatus.classList.remove("error");
        }

        if (me !== "unauthorized") {
            clearInterval(pollTimer);
            await store.set("token", token);
            await store.set("user", me.user);
            await showConnected(me.user);
            connect(token);
        }
    }, LINK_POLL_MS);
}

async function logout({ revoke = true, message = null } = {}) {
    const token = await store.get("token");

    if (revoke && token) {
        await fetch(`${SITE_URL}/api/desktop/me`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {});
    }

    socket?.removeAllListeners();
    socket?.disconnect();
    socket = null;
    siteOpen = false;

    await store.delete("token");
    await store.delete("user");

    showLogin(message);
}

/* ================= Écran connecté ================= */

async function showConnected(user) {
    els.userName.textContent = user?.username ?? "";
    els.avatar.src = absoluteUrl(user?.avatar ?? "/images/no-avatar.png");
    setStatus("connecting");
    showScreen("connected");
    showTab("home");

    if (prefs.mode === "windows") {
        await ensureWindowsPermission();
    }
}

function setSiteOpen(open) {
    siteOpen = open === true;
    els.siteOpenHint.classList.toggle("hidden", !siteOpen);
}

/* ================= Socket.IO ================= */

function connect(token) {
    socket?.removeAllListeners();
    socket?.disconnect();

    socket = io(SOCKET_URL, {
        path: SOCKET_PATH,
        transports: ["websocket"],
        auth: { deviceToken: token },
        reconnection: true,
        reconnectionDelay: 2000,
        reconnectionDelayMax: 30000,
    });

    socket.on("connect", () => setStatus("online"));

    socket.on("disconnect", async (reason) => {
        setStatus("offline");
        setSiteOpen(false);

        // Déconnexion forcée par le serveur (appareil révoqué depuis le site ?)
        if (reason === "io server disconnect") {
            const me = await fetchMe(token);

            if (me === "unauthorized") {
                await logout({ revoke: false, message: "Cet appareil a été déconnecté depuis le site." });
                return;
            }

            setTimeout(() => socket?.connect(), 5000);
        }
    });

    socket.on("connect_error", async (err) => {
        setStatus("offline");

        // Erreur renvoyée par le middleware : pas de reconnexion automatique
        if (err.message === "unauthorized") {
            await logout({ revoke: false, message: "Cet appareil a été déconnecté depuis le site." });
            return;
        }

        if (err.message === "server_error") {
            setTimeout(() => socket?.connect(), 10000);
        }
    });

    socket.on("desktop.siteState", ({ open }) => setSiteOpen(open));

    socket.on("me.notification", handleNotification);
}

/* ================= Écouteurs de l'interface ================= */

function bindUi() {
    els.btnLink.onclick = startLinking;
    els.btnCancel.onclick = () => showLogin();
    els.btnLogout.onclick = () => logout();
    els.btnTest.onclick = sendTestNotification;
    els.btnClearHistory.onclick = clearHistory;
    els.btnMute.onclick = () => setMuted(!prefs.sound.muted);

    els.tabs.forEach((tab) => {
        tab.onclick = () => showTab(tab.dataset.tab);
    });

    els.autostart.onchange = async () => {
        try {
            if (els.autostart.checked) await enable();
            else await disable();
        } catch {
            els.autostart.checked = !els.autostart.checked;
        }
    };

    els.modeRadios.forEach((radio) => {
        radio.onchange = async () => {
            if (!radio.checked) return;
            prefs.mode = radio.value;
            applyPrefsToUi();
            await savePrefs();
            if (prefs.mode === "windows") await ensureWindowsPermission();
        };
    });

    els.cornerButtons.forEach((btn) => {
        btn.onclick = async () => {
            prefs.corner = btn.dataset.corner;
            applyPrefsToUi();
            await savePrefs();
            emitTo("overlay", "overlay:layout", { corner: prefs.corner }).catch(() => {});
            sendTestNotification();
        };
    });

    els.soundSourceRadios.forEach((radio) => {
        radio.onchange = async () => {
            if (!radio.checked) return;
            prefs.sound.source = radio.value;
            await savePrefs();
            await loadCustomSound();
            applyPrefsToUi();
            playSound({ force: true });
        };
    });

    els.btnChooseSound.onclick = chooseSoundFile;

    els.soundVolume.oninput = () => {
        prefs.sound.volume = Number(els.soundVolume.value);
        els.soundVolumeValue.textContent = `${prefs.sound.volume} %`;
    };

    els.soundVolume.onchange = async () => {
        await savePrefs();
        playSound({ force: true });
    };

    els.soundMuted.onchange = () => setMuted(els.soundMuted.checked);

    // Clic sur « Couper le son » dans le menu de l'icône
    listen("tray:mute-toggle", () => setMuted(!prefs.sound.muted));
}

/* ================= Démarrage ================= */

async function init() {
    store = await load("settings.json", { defaults: {}, autoSave: true });

    prefs = mergePrefs(await store.get("prefs"));
    applyPrefsToUi();
    invoke("set_tray_muted", { muted: prefs.sound.muted }).catch(() => {});
    await loadCustomSound();

    bindUi();
    loadHistory();

    els.autostart.checked = await isEnabled().catch(() => false);

    const token = await store.get("token");

    if (!token) {
        showLogin();
        return;
    }

    const me = await fetchMe(token);

    if (me === "unauthorized") {
        await logout({ revoke: false, message: "Votre session a expiré, reconnectez l'appareil." });
        return;
    }

    // me === null : pas encore de réseau (démarrage du PC) → on affiche le dernier utilisateur connu
    const user = me?.user ?? (await store.get("user"));
    if (me?.user) await store.set("user", me.user);

    await showConnected(user);
    connect(token);
}

init();