// vitest's setup file for the runtime, in each test file's worker: the bridge's (bridge/test/compiler-setup.ts),
// which fails a test that made the two compilers differ in `both` mode, and writes the file's counts.
import { afterAll, afterEach, inject } from "vitest";
import { compilerSetup } from "../../bridge/test/compiler-setup.js";

compilerSetup({ afterEach, afterAll, inject: (k) => inject(k as never) });
