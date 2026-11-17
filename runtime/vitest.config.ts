import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  resolve: {
    // Test against the sources of the bridge and, behind it, the compiler, so no build is needed first. A pattern,
    // because the bridge's own import of the compiler goes through this alias too (this package never names the
    // compiler: seam.test.ts). The bridge's second entry point (`@mandate/bridge/mode`) is its src/mode.ts.
    alias: [
      { find: /^@mandate\/bridge\/mode$/, replacement: `${root}bridge/src/mode.ts` },
      { find: /^@mandate\/([a-z]+)$/, replacement: `${root}$1/src/index.ts` },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The compiler behind the bridge: the module it needs (the bridge's test/compiler-setup.ts).
    globalSetup: ["test/global-setup.ts"],
  },
});
