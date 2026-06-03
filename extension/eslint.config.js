import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: [".wxt/**", ".output/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { chrome: "readonly", defineBackground: "readonly" },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // amounts, openings and blinding factors must never reach a log.
      // spec 18.8: diagnostics are built from public inputs only.
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
);
