import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/src/generated/**"] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // TypeScript rules for all packages
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": "warn",
    },
  },

  // Agent is a CLI tool — console.log is the output mechanism
  {
    files: ["packages/agent/src/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },

  // React rules for agent-gui only
  {
    files: ["packages/agent-gui/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Polling pattern (useEffect → async fn → setState) is intentional in this app
      "react-hooks/set-state-in-effect": "warn",
    },
  },
);
