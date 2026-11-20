#!/usr/bin/env node
// Mock agent CLI that hangs — proves runTask's timeout path SIGKILLs the child,
// forces pass:false, and does not evaluate assertions against a killed run.
setTimeout(() => {}, 60000);
