// vitest's setup file for the bridge, in each test file's worker: test/compiler-setup.ts.
import { afterAll, afterEach, inject } from "vitest";
import { compilerSetup } from "./compiler-setup.js";

compilerSetup({ afterEach, afterAll, inject: (k) => inject(k as never) });
