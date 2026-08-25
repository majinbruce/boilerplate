import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Set before any test file is imported, so src/config picks up .env.test.
    env: { NODE_ENV: "test" },
    include: ["test/**/*.test.ts"],
  },
});
