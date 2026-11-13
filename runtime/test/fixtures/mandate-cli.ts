// The `mandate` binary's hand-off to the runtime's CLI, as compiler/src/cli.ts
// makes it, for a test that runs a control command as a child process.

import { main } from "../../src/cli.js";

process.exit(await main(process.argv.slice(2)));
