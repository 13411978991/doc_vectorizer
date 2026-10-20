// ESLint flat config — minimal, type-aware-free setup.
//
// To run lint:
//
//   npm install --no-save --no-audit --no-fund @eslint/js typescript-eslint
//   npx eslint src/watcher/ src/api/watched-folders.ts \
//     src/services/watcher-mcp-service.ts web/src/pages/WatchedFolders/
//
// We use --no-save so the dependencies are not added to package.json.
// typescript-eslint is only needed for the parser; we don't enable the
// strict type-aware rules (they overlap with `npm run typecheck`).
//
// To extend later, see https://typescript-eslint.io/getting-started/

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.tmp/**",
      "**/coverage/**",
      "**/*.d.ts",
      "web/src/components/ui/**"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        // Node.js globals
        process: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        global: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        clearImmediate: "readonly",
        require: "readonly",
        module: "readonly",
        exports: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        fetch: "readonly",
        // Browser globals (used by web/)
        window: "readonly",
        document: "readonly",
        localStorage: "readonly",
        sessionStorage: "readonly",
        navigator: "readonly",
        HTMLElement: "readonly",
        HTMLDivElement: "readonly",
        HTMLInputElement: "readonly",
        HTMLButtonElement: "readonly",
        Event: "readonly",
        confirm: "readonly",
        alert: "readonly",
        FormData: "readonly",
        Headers: "readonly",
        Request: "readonly",
        Response: "readonly",
        Blob: "readonly",
        crypto: "readonly",
        performance: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        React: "readonly"
      }
    },
    rules: {
      // Disable TS-strict rules that overlap with tsc and would produce noise.
      // Sprint 1/2/3 code is read-only per Sprint 4 brief, so we can't
      // aggressively clean up unused vars / non-null assertions there.
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-this-alias": "off",
      "@typescript-eslint/no-var-requires": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/ban-types": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/preserve-caught-error": "off", // stylistic — error.cause is optional
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/restrict-plus-operands": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/return-await": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",

      // Core rules — keep best-practice ones, disable stylistic ones.
      "no-unused-vars": "off", // TS handles this
      "no-undef": "off", // TS handles this
      "no-unused-expressions": "off",
      "preserve-caught-error": "off", // stylistic — error.cause is optional
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-prototype-builtins": "off",
      "no-useless-escape": "off",
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-inner-declarations": "off",

      "no-irregular-whitespace": "off",
      "no-mixed-spaces-and-tabs": "off",
      "no-multi-spaces": "off",
      "no-trailing-spaces": "off",
      "no-extra-boolean-cast": "off",
      "no-extra-semi": "off",
      "no-fallthrough": "off",
      "no-useless-catch": "off",

      "no-console": "warn",
      "no-debugger": "error",
      "no-var": "error",
      "prefer-const": "warn",
      "eqeqeq": ["error", "smart"],
      "getter-return": "off",
      "no-throw-literal": "off",
      "no-control-regex": "off"
    }
  },
  {
    files: ["**/__tests__/**/*.ts", "**/test/**/*.ts"],
    rules: {
      "no-console": "off"
    }
  },
  {
    files: ["web/src/**/*.ts", "web/src/**/*.tsx"],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true }
      }
    },
    rules: {
      // console.error / console.warn are part of the React error-path
      // reporting convention in this codebase. Production builds don't
      // surface them to end users — they're developer diagnostics only.
      // A proper toast layer is a follow-up sprint; for now we tolerate
      // them so lint stays useful for catching real bugs (no-debugger,
      // no-var, eqeqeq, etc.) instead of being blocked by 10 cosmetic
      // warnings.
      "no-console": "off"
    }
  },
  {
    files: ["scripts/**/*.ts"],
    rules: {
      // CLI scripts use console.* for user-facing output (tsx demo-ingest
      // prints progress, demo-search prints results). Lint has no business
      // flagging that.
      "no-console": "off"
    }
  },
  {
    files: ["scripts/**/*.mjs"],
    rules: {
      // Same as TS scripts above — build pipelines (build-sea-bundle,
      // build-windows-exe) emit progress through console.log so users can
      // see what stage they're at.
      "no-console": "off",
      "no-unused-vars": "off",
    }
  }
);