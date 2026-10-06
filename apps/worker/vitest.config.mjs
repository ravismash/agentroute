import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Starts disposable Postgres and Redis via Testcontainers (requires Docker).
    globalSetup: ["./src/test-support/global-setup.ts"],
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
