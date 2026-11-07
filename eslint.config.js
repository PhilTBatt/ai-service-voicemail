import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["**/node_modules/", "**/dist/", "**/coverage/", "spike/"] },
  {
    files: ["**/*.{js,ts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    rules: {
      // Express error handlers must declare all four parameters; `_next` marks the unused one.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
    languageOptions: {
      parserOptions: {
        // Ask TypeScript for type information using each file's nearest tsconfig.json.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Plain JS (config files) has no tsconfig, so lint it without type information.
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
