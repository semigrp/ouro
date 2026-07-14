#!/usr/bin/env node
import { runCli } from "../src/cli.js";

runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
}).catch((error: unknown) => {
  process.stderr.write(`ouro: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
