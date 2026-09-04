import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import globals from "globals";
import { defineConfig } from "eslint/config";

export default defineConfig([
  {
    files: ["**/*.{js,mjs,cjs}"],
    plugins: { js },
    extends: ["js/recommended"],
    languageOptions: {
      // `awslambda` is injected by the Lambda Node.js runtime for response streaming.
      globals: { ...globals.node, awslambda: "readonly" },
    },
  },
  eslintConfigPrettier,
]);
