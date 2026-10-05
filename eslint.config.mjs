import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores(["**/dist/**", "**/coverage/**", "**/node_modules/**", "**/.turbo/**"]),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },
  {
    // Shared packages must never depend on deployable apps.
    files: ["packages/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@agentroute/*-api", "@agentroute/*-agent", "@agentroute/*-ui", "@agentroute/worker"],
              message: "packages/* must not import from apps/*",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.mjs", "**/*.config.ts"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
