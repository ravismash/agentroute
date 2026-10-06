import { defineConfig } from "vitest/config";

// The policy engine is the security core: CI fails if coverage drops below the gate.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/test-support/**", "src/index.ts"],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 80 },
    },
  },
});
