import { defineConfig } from "vite";

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
    },
});