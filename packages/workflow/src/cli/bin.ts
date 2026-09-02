#!/usr/bin/env node
import { runCli } from "./main.js";

const result = await runCli(process.argv.slice(2), {
  writeStdout: (value) => process.stdout.write(value),
  writeStderr: (value) => process.stderr.write(value),
});
process.exitCode = result.exitCode;
