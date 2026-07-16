#!/usr/bin/env node
// Generates an ouro.run-request/v1 document for the quality-gate procedure.
//
//   node make-run-request.mjs \
//     --work "owner/repo#123" \
//     --workspace /abs/path/to/repo \
//     --commands '[["npx","tsc"],["npm","test"]]' \
//     --experiment EXP-0001 --procedure PROC-0001 \
//     [--procedure-path procedures/quality-gate.mjs] \
//     [--tier workspace-write] [--timeout-ms 600000] > run-request.json
//
// Procedure bytes are repository-owned: Ouro requires the artifact to resolve
// inside the workspace, so vendor procedure.mjs into the target repository
// (default path: procedures/quality-gate.mjs) and pin it from there —
// version = the workspace HEAD commit, digest = sha256 of the bytes, so a
// Run snapshot is verifiable and replayable.
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    work: { type: "string" },
    workspace: { type: "string" },
    commands: { type: "string" },
    experiment: { type: "string" },
    procedure: { type: "string" },
    "procedure-path": { type: "string", default: "procedures/quality-gate.mjs" },
    tier: { type: "string", default: "workspace-write" },
    "timeout-ms": { type: "string", default: "600000" },
  },
});

for (const name of ["work", "workspace", "commands", "experiment", "procedure"]) {
  if (values[name] === undefined) {
    console.error(`make-run-request: missing --${name}`);
    process.exit(2);
  }
}
const workMatch = values.work.match(/^([^#]+)#(.+)$/);
if (workMatch === null) {
  console.error('make-run-request: --work must look like "owner/repo#123"');
  process.exit(2);
}
const commands = JSON.parse(values.commands);

const workspacePath = resolve(values.workspace);
const procedurePath = resolve(workspacePath, values["procedure-path"]);
if (!procedurePath.startsWith(workspacePath)) {
  console.error("make-run-request: --procedure-path must stay inside the workspace");
  process.exit(2);
}
const bytes = readFileSync(procedurePath);
const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const commit = execSync("git rev-parse HEAD", { cwd: workspacePath, encoding: "utf8" }).trim();
const remote = execSync("git remote get-url origin", { cwd: workspacePath, encoding: "utf8" })
  .trim()
  .replace(/^.*[:/]([^/]+\/[^/]+?)(\.git)?$/, "$1");

const request = {
  schema: "ouro.run-request/v1",
  work: {
    source: { system: "github", type: "issue", id: values.work, version: `requested:${commit}` },
    title: `Quality gate for ${values.work}`,
  },
  experiment: { system: "bouro", type: "experiment", id: values.experiment, version: "1" },
  contextQuery: {
    schema: "bouro.context-query/v1",
    roots: [{ system: "bouro", type: "experiment", id: values.experiment, version: "1" }],
    purpose: "run the declared quality gates against the workspace HEAD",
    tokenBudget: 4000,
    allowedSensitivities: ["public", "internal"],
  },
  procedure: {
    definition: { system: "bouro", type: "procedure", id: values.procedure, version: "1" },
    artifact: {
      system: "github",
      type: "file",
      id: `${remote}:${values["procedure-path"]}`,
      version: commit,
      uri: procedurePath,
      digest,
    },
    runtime: "node",
    args: [],
    inputs: { commands },
    permissionTier: values.tier,
    timeoutMs: Number(values["timeout-ms"]),
    retries: 0,
    environment: { inherit: ["PATH", "HOME"] },
  },
  workspace: {
    ref: { system: "ouro", type: "workspace", id: `WS-${workMatch[1].replace(/\W+/g, "-")}`, version: "1" },
    path: workspacePath,
  },
  gates: [{ id: "exit-zero", type: "exit_code", expected: 0 }],
  evidence: {
    when: "success",
    title: `Quality gates passed for ${values.work}`,
    observation: "Every declared command exited 0 under the pinned quality-gate procedure.",
  },
};

console.log(JSON.stringify(request, null, 2));
