import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Live evaluations call the real BackBoard API and cost credits: `pnpm eval:backboard`.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["evals/**/*.eval.ts"],
    testTimeout: 900_000,
    hookTimeout: 900_000,
    fileParallelism: false,
  },
});
