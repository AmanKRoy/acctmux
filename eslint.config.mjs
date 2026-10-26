import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: { ...globals.node, fetch: "readonly" } },
    rules: { "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }] },
  },
  { ignores: ["node_modules/"] },
];
