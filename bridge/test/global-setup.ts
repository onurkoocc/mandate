// vitest's globalSetup for the bridge: test/compiler-setup.ts.
import type { TestProject } from "vitest/node";
import { compilerGlobalSetup } from "./compiler-setup.js";

export default function setup(project: TestProject): () => void {
  return compilerGlobalSetup(project as unknown as { provide(key: string, value: unknown): void });
}
