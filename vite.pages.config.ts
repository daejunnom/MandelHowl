import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: path.join(projectRoot, "pages"),
  base: "/MandelHowl/",
  publicDir: path.join(projectRoot, "public"),
  resolve: {
    alias: {
      "@": projectRoot,
    },
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  plugins: [
    svelte({
      configFile: path.join(projectRoot, "svelte.config.js"),
    }),
    react(),
  ],
  build: {
    outDir: path.join(projectRoot, "dist-pages"),
    emptyOutDir: true,
    sourcemap: false,
  },
});
