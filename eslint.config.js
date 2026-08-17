import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^__" }],
    },
  },
  // `src/` must not need `@types/node`, so node globals are NOT declared globally. `scripts/`
  // is the opposite: it only ever runs under `node` in CI, so declare exactly what it uses
  // rather than pull in a `globals` dependency for one file.
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly", URL: "readonly" },
    },
  },
);
