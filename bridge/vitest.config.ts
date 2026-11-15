import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Test against the compiler's sources, so no build is needed first.
    alias: { "@mandate/compiler": fileURLToPath(new URL("../compiler/src/index.ts", import.meta.url)) },
  },
  test: {
    include: ["test/**/*.test.ts"],
    // The compiler behind the bridge (MANDATE_COMPILER): the module it needs, the divergences of `both`, its counts.
    globalSetup: ["test/global-setup.ts"],
    setupFiles: ["test/setup.ts"],
  },
});
