#!/usr/bin/env node
// The published binary. A shim so `quadra-verify` runs compiled JavaScript and a judge does not
// need tsx installed to check a settlement.
//
// It CALLS run() rather than relying on the module's own direct-invocation guard: importing the
// module means `import.meta.url` is the compiled file while `process.argv[1]` is this shim, so
// that guard never fires and the binary would exit silently having done nothing.
import { run, reportAndExit } from '../dist/verify.js';

run().catch(reportAndExit);
