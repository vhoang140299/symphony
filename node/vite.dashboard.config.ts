import { defineConfig } from "vite";

export default defineConfig({
  root: "ui",
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/readyz": "http://127.0.0.1:3000",
    },
  },
  build: {
    outDir: "../dist/dashboard",
    emptyOutDir: true,
    assetsDir: "assets",
    assetsInlineLimit: 0,
    license: { fileName: "assets/licenses.md" },
  },
});
