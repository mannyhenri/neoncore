#!/usr/bin/env node
// Mock Gridlight that does nothing — stands in for a model that failed the task.
// The fixture is left unchanged, so a correct assertion must report a failure.
process.stdout.write('(did nothing)\n');
