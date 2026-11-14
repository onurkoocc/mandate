// The `mandate` binary's hand-off to the runtime's CLI, as bridge/src/cli.ts
// (the binary) makes it, for a test that runs a control command as a child process.

import { main } from "../../src/cli.js";

process.exit(await main(process.argv.slice(2)));
