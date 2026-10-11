import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = { "@": fileURLToPath(new URL("./src", import.meta.url)) };

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: { name: "unit", include: ["tests/unit/**/*.test.ts"] },
      },
      {
        // Learning mode: suites for the three mechanisms the owner implements.
        // Red until they are written; kept out of `npm test` on purpose.
        resolve: { alias },
        test: { name: "learning", include: ["tests/learning/**/*.test.ts"] },
      },
      {
        // Webhook -> agent -> approval, end to end on mocks, using the owner's
        // real learning-mode implementations. Red until those exist.
        resolve: { alias },
        test: { name: "integration", include: ["tests/integration/**/*.test.ts"] },
      },
      {
        // Needs `npm run db:start` (local Supabase) and a freshly reset database.
        resolve: { alias },
        test: {
          name: "db",
          include: ["tests/db/**/*.test.ts"],
          fileParallelism: false,
        },
      },
    ],
  },
});
