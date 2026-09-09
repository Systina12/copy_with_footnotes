import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([{
  files: ["src/**/*.ts"],
  extends: obsidianmd.configs.recommended,
  languageOptions: {
    parserOptions: {
      project: "./tsconfig.json",
      tsconfigRootDir: import.meta.dirname,
    },
  },
  rules: {
    "@typescript-eslint/no-unnecessary-type-assertion": "error",
  },
}]);
