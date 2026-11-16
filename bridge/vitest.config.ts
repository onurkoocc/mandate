import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Test against the compiler's sources, so no build is needed first.
    alias: { "@mandate/compiler": fileURLToPath(new URL("../compiler/src/index.ts", import.meta.url)) },
  },
  test: {
    include: ["test/**/*.test.ts"],
    // The compiler behind the bridge: the module it needs (test/compiler-setup.ts).
    globalSetup: ["test/global-setup.ts"],
  },
});
