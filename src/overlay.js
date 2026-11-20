import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
// Importé pour que Vite l'inclue dans le build (un chemin en dur casserait en production)
import logoUrl from "./icon-512.png";

const WIDTH = 360;        // doit correspondre à #stack dans overlay.css
const DURATION_S = 6;     // durée d'affichage (en pause au survol)
const MAX_CARDS = 4;      // au-delà, la plus ancienne disparaît
const LEAVE_MS = 220;
const TYPES = ["success", "info", "warning", "error"];

const stack = document.getElementById("stack");

let corner = "bottom-right";
let siteUrl = "https://www.halles-des-douze.fr";
let layoutPending = false;

const isBottom = () => corner.startsWith("bottom");

function absoluteUrl(path) {
    if (!path) return siteUrl;
    return path.startsWith("http") ? path : `${siteUrl}${path.startsWith("/") ? "" : "/"}${path}`;
}

/**
 * Demande à Rust de placer la fenêtre dans le coin et de l'ajuster au contenu.
 * Pas de requestAnimationFrame : au repos l'overlay fait 1×1 px et WebView2 peut
 * espacer ses rafraîchissements, ce qui retarderait l'apparition de la carte.
 */
function scheduleLayout() {
    if (layoutPending) return;
    layoutPending = true;

    queueMicrotask(() => {
        layoutPending = false;

        // getBoundingClientRect force le calcul de la mise en page immédiatement
        const height = stack.childElementCount > 0
            ? Math.ceil(stack.getBoundingClientRect().height)
            : 0;

        invoke("overlay_layout", { corner, width: WIDTH, height }).catch((err) => {
            console.error("overlay_layout", err);
        });
    });
}

function setCorner(next) {
    if (!next || next === corner) {
        document.body.dataset.corner = corner;
        return;
    }

    const wasBottom = isBottom();
    corner = next;
    document.body.dataset.corner = corner;

    // La plus récente doit rester côté bord de l'écran : on inverse l'ordre si besoin
    if (wasBottom !== isBottom()) {
        [...stack.children].reverse().forEach((card) => stack.appendChild(card));
    }

    scheduleLayout();
}

function activeCards() {
    return [...stack.querySelectorAll(".card:not(.leaving)")];
}

function dismiss(card) {
    if (!card || card.classList.contains("leaving")) return;

    card.classList.add("leaving");

    setTimeout(() => {
        card.remove();
        scheduleLayout();
    }, LEAVE_MS);
}

function buildCard(notification) {
    const type = TYPES.includes(notification.type) ? notification.type : "info";

    const card = document.createElement("div");
    card.className = `card type-${type}`;
    card.style.setProperty("--duration", `${DURATION_S}s`);

    const logo = document.createElement("div");
    logo.className = "logo";

    const logoImg = document.createElement("img");
    logoImg.src = logoUrl;
    logoImg.alt = "Halles des Douze";
    logoImg.draggable = false;
    logo.appendChild(logoImg);

    const content = document.createElement("div");
    content.className = "content";

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = notification.title || "Halles des Douze";

    // textContent uniquement : le message n'est jamais interprété comme du HTML
    const message = document.createElement("div");
    message.className = "message";
    message.textContent = notification.message;

    content.append(title, message);

    const close = document.createElement("button");
    close.className = "close";
    close.type = "button";
    close.title = "Fermer";
    close.textContent = "×";

    const progress = document.createElement("div");
    progress.className = "progress";

    card.append(logo, content, close, progress);

    card.addEventListener("click", (event) => {
        if (event.target.closest(".close")) return;
        openUrl(absoluteUrl(notification.url)).catch((err) => console.error(err));
        dismiss(card);
    });

    close.addEventListener("click", (event) => {
        event.stopPropagation();
        dismiss(card);
    });

    progress.addEventListener("animationend", () => dismiss(card));

    return card;
}

function addCard(payload) {
    const notification = payload?.notification;
    if (!notification?.message) return;

    if (payload.siteUrl) siteUrl = payload.siteUrl;
    setCorner(payload.corner);

    // Bas : la plus récente en bas (ajout à la fin). Haut : la plus récente en haut.
    const cards = activeCards();
    while (cards.length >= MAX_CARDS) {
        dismiss(isBottom() ? cards.shift() : cards.pop());
    }

    const card = buildCard(notification);

    if (isBottom()) stack.appendChild(card);
    else stack.prepend(card);

    scheduleLayout();
}

new ResizeObserver(scheduleLayout).observe(stack);

listen("overlay:notify", (event) => addCard(event.payload));
listen("overlay:layout", (event) => setCorner(event.payload?.corner));

scheduleLayout();