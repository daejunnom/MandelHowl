import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../../", import.meta.url)),
    },
  },
  test: {
    allowOnly: false,
    environment: "node",
    include: ["tests/web/**/*.test.ts"],
    passWithNoTests: false,
  },
});
