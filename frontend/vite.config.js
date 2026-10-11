import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    assetsDir: "assets",
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:6066",
      "/gate": "http://127.0.0.1:6066",
      "/ws": { target: "ws://127.0.0.1:6066", ws: true },
    },
  },
});
