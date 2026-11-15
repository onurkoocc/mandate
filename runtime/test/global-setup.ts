// vitest's globalSetup for the runtime: the bridge's (bridge/test/compiler-setup.ts), which needs the Rust
// compiler's module only in `rust` and `both` mode, and neither the module nor any dist/ in the default mode.
import type { TestProject } from "vitest/node";
import { compilerGlobalSetup } from "../../bridge/test/compiler-setup.js";

export default function setup(project: TestProject): () => void {
  return compilerGlobalSetup(project as unknown as { provide(key: string, value: unknown): void });
}
