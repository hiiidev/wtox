import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// A fresh token for every production build avoids stale SVGs on Cloudflare.
const buildTag = Date.now().toString(36);

export default defineConfig({
  plugins: [
    react(),
    {
      name: "wtox-versioned-logo",
      transformIndexHtml(html) {
        return html.replaceAll('/logo.svg', `/logo.svg?t=${buildTag}`);
      },
    },
  ],
  define: {"__WTOX_BUILD_TAG__": JSON.stringify(buildTag)},
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
