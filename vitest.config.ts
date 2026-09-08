import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [{
    name: "obsidian-test-host",
    enforce: "pre",
    resolveId(id) {
      return id === "obsidian" ? "\0obsidian-test-host" : null;
    },
    load(id) {
      return id === "\0obsidian-test-host" ? "export {}" : null;
    },
  }],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
