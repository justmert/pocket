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
      // Amounts, openings and blinding factors must never reach a log, a
      // telemetry sink, or a crash report. Spec 18.8 and SDK.md 13: a proof
      // failure is diagnosable from public inputs alone, so diagnostics are
      // built from those and never from the witness.
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    // Tests are not shipped, and reporting a measured value is the point of a
    // live test. The rule above still governs everything that reaches a user.
    files: ["**/*.test.ts", "e2e/**"],
    rules: { "no-console": "off" },
  },
);
