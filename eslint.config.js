import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores(["dist"]),

  {
    // JavaScript files
    files: ["**/*.{js,mjs,cjs}"],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },

  {
    // TypeScript files
    files: ["**/*.{ts,mts,cts}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },

  eslintConfigPrettier,
]);
