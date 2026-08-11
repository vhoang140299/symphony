import { defineConfig } from "vite";

// The operations HTTP server in @ai-symphony/server serves these assets from its
// own dist directory, so the bundle is emitted straight into that package.
export default defineConfig({
  root: "ui",
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/readyz": "http://127.0.0.1:3000",
    },
  },
  build: {
    outDir: "../../server/dist/dashboard",
    emptyOutDir: true,
    assetsDir: "assets",
    assetsInlineLimit: 0,
    license: { fileName: "assets/licenses.md" },
  },
});
