import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "threads",
    poolOptions: { threads: { singleThread: false } },
    reporters: process.env.CI ? ["default", "junit"] : ["default"],
    outputFile: { junit: "evidence/junit.xml" },
  },
});
