import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
    clearScreen: false,
    server: {
        port: 1420,
        strictPort: true,
        watch: {
            // Cargo écrit en permanence dans src-tauri/target :
            // Vite ne doit pas le surveiller (EBUSY sous Windows)
            ignored: ["**/src-tauri/**"],
        },
    },
    build: {
        target: "es2021",
        outDir: "dist",
        rollupOptions: {
            // Deux pages : la fenêtre principale et l'overlay de notifications
            input: {
                main: fileURLToPath(new URL("./index.html", import.meta.url)),
                overlay: fileURLToPath(new URL("./overlay.html", import.meta.url)),
            },
        },
    },
});
