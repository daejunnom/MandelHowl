/**
 * Backward-compatible entry point. The N-version supervisor owns all baker
 * execution so validation never asks Cargo to synthesize a test executable.
 */
import process from "node:process";

import { runSupervisorCli } from "../../baker-supervisor/src/supervisor.mjs";

process.exitCode = runSupervisorCli(["validate", ...process.argv.slice(2)]);
