import { io } from "socket.io-client";
import { invoke } from "@tauri-apps/api/core";
// fetch côté Rust : pas de CORS entre l'app (tauri.localhost) et le site
import { fetch } from "@tauri-apps/plugin-http";
import { load } from "@tauri-apps/plugin-store";
import { openUrl } from "@tauri-apps/plugin-opener";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import {
    isPermissionGranted,
    requestPermission,
    sendNotification,
} from "@tauri-apps/plugin-notification";

const SITE_URL = import.meta.env.VITE_SITE_URL ?? "https://halles-des-douze.fr";
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL ?? SITE_URL;
const SOCKET_PATH = import.meta.env.VITE_SOCKET_PATH ?? "/socket.io";

const LINK_TIMEOUT_MS = 10 * 60 * 1000;
const LINK_POLL_MS = 2000;
const LINK_NETWORK_ERRORS_BEFORE_WARNING = 3;
const TOAST_GROUP_WINDOW_MS = 1500; // fenêtre de regroupement
const TOAST_GROUP_THRESHOLD = 3;    // au-delà : une seule notif récapitulative
const HISTORY_MAX = 30;

const $ = (id) => document.getElementById(id);

const els = {
    screens: {
        loading: $("screen-loading"),
        login: $("screen-login"),
        linking: $("screen-linking"),
        connected: $("screen-connected"),
    },
    loginError: $("login-error"),
    btnLink: $("btn-link"),
    linkCode: $("link-code"),
    linkStatus: $("link-status"),
    btnReopen: $("btn-reopen"),
    btnCancel: $("btn-cancel"),
    avatar: $("user-avatar"),
    userName: $("user-name"),
    statusDot: $("status-dot"),
    statusText: $("status-text"),
    autostart: $("opt-autostart"),
    history: $("history"),
    btnLogout: $("btn-logout"),
};

let store = null;
let socket = null;
let pollTimer = null;
let siteOpen = false; // site ouvert dans un navigateur (même réduit) : c'est lui qui notifie
let toastBuffer = [];
let toastTimer = null;
const history = [];

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

    const url = `${SITE_URL}/mon-compte/app/lier?h=${hash}&name=${encodeURIComponent(deviceName)}`;

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

    await store.delete("token");
    await store.delete("user");

    history.length = 0;
    renderHistory();
    showLogin(message);
}

/* ================= Écran connecté ================= */

async function showConnected(user) {
    els.userName.textContent = user?.username ?? "";
    els.avatar.src = absoluteUrl(user?.avatar ?? "/images/no-avatar.png");
    setStatus("connecting");
    showScreen("connected");

    if (!(await isPermissionGranted())) {
        await requestPermission();
    }
}

function renderHistory() {
    els.history.innerHTML = "";

    if (history.length === 0) {
        const li = document.createElement("li");
        li.className = "empty";
        li.textContent = "Aucune notification pour le moment.";
        els.history.appendChild(li);
        return;
    }

    for (const item of history) {
        const li = document.createElement("li");
        const time = document.createElement("time");
        time.textContent = item.at.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
        li.appendChild(time);
        li.appendChild(document.createTextNode(item.message));

        if (item.url) {
            li.classList.add("clickable");
            li.onclick = () => openUrl(absoluteUrl(item.url));
        }

        els.history.appendChild(li);
    }
}

/* ================= Notifications ================= */

function flushToasts() {
    toastTimer = null;
    const items = toastBuffer;
    toastBuffer = [];

    if (items.length === 0) return;

    if (items.length <= TOAST_GROUP_THRESHOLD) {
        for (const item of items) {
            sendNotification({ title: item.title ?? "Halles des Douze", body: item.message });
        }
        return;
    }

    sendNotification({
        title: "Halles des Douze",
        body: `${items.length} nouvelles notifications`,
    });
}

function queueToast(notification) {
    toastBuffer.push(notification);

    if (!toastTimer) {
        toastTimer = setTimeout(flushToasts, TOAST_GROUP_WINDOW_MS);
    }
}

function handleNotification(payload) {
    const notification = payload?.notification;
    if (!notification?.message) return;

    history.unshift({
        message: notification.message,
        url: notification.url ?? null,
        at: new Date(),
    });
    history.length = Math.min(history.length, HISTORY_MAX);
    renderHistory();

    // Le site est ouvert (visible ou réduit) : il notifie lui-même (toast ou Web Push)
    if (siteOpen) return;

    queueToast(notification);
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
        siteOpen = false;

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

    socket.on("desktop.siteState", ({ open }) => {
        siteOpen = open === true;
    });

    socket.on("me.notification", handleNotification);
}

/* ================= Démarrage ================= */

async function init() {
    store = await load("settings.json", { defaults: {}, autoSave: true });

    els.btnLink.onclick = startLinking;
    els.btnCancel.onclick = () => showLogin();
    els.btnLogout.onclick = () => logout();

    els.autostart.checked = await isEnabled().catch(() => false);
    els.autostart.onchange = async () => {
        try {
            if (els.autostart.checked) await enable();
            else await disable();
        } catch {
            els.autostart.checked = !els.autostart.checked;
        }
    };

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