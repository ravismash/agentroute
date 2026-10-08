import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Token-bucket and budget tests use a disposable Redis via Testcontainers
    // (requires Docker). The circuit-breaker and retry tests are pure.
    globalSetup: ["./src/test-support/global-setup.ts"],
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
