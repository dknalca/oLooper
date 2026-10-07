import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri dev server: fixed port so src-tauri/tauri.conf.json devUrl matches.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: "dist",
  },
});
