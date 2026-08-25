import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Set before any test file is imported, so src/config picks up .env.test.
    env: { NODE_ENV: "test" },
    include: ["test/**/*.test.ts"],
    /**
     * Migrates and truncates the app_test database once per run. Test files
     * still execute in parallel — isolation comes from every test minting a
     * unique email, not from serialising the suite.
     */
    globalSetup: ["test/globalSetup.ts"],
  },
});
