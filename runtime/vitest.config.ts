import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Test against the sources of the bridge and, behind it, the compiler, so no build is needed first. A pattern,
    // because the bridge's own import of the compiler goes through this alias too (this package never names the
    // compiler: seam.test.ts).
    alias: [{ find: /^@mandate\/([a-z]+)$/, replacement: `${fileURLToPath(new URL("..", import.meta.url))}$1/src/index.ts` }],
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
