import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

/**
 * Static analysis lane (PRD §36). Deliberately narrow: the rules here catch the classes
 * of mistake that the type system and the test suite cannot, and nothing else — a large
 * stylistic rule set would generate noise that trains people to ignore the output.
 */
export default [
  {
    ignores: ["dist/**", "node_modules/**", "evidence/**"],
  },
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: "module",
        project: "./tsconfig.json",
      },
    },
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      // `as any` is forbidden outright; the codebase uses type guards and generics.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "no-console": ["error", { allow: ["error"] }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",
    },
  },
  {
    // Entrypoints print to stdout on purpose; that is their interface.
    files: ["src/cli/**/*.ts", "src/daemon/agentcpd.ts", "src/tools/**/*.ts"],
    rules: { "no-console": "off" },
  },
];
