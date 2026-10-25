import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";
import stylistic from "@stylistic/eslint-plugin";

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

  {
    plugins: { "@stylistic": stylistic },
    rules: {
      "@stylistic/padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: "multiline-const", next: "*" },
        { blankLine: "always", prev: "multiline-expression", next: "*" },
        { blankLine: "always", prev: "*", next: "return" },
      ],
    },
  },
]);
