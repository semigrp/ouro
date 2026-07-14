import { chmod, readFile, rename, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digestBytes, type JsonObject, type OuroStore, type ResourceRefV1 } from "./schema.js";

export async function verifyProcedureArtifact(
  workspacePath: string,
  artifact: ResourceRefV1,
): Promise<{ path: string; digest: `sha256:${string}` }> {
  if (!artifact.uri) throw new Error("ProcedureArtifact URI is required");
  if (!artifact.digest) throw new Error("ProcedureArtifact digest is required");
  const path = resolveInsideWorkspace(workspacePath, artifact.uri);
  const digest = digestBytes(await readFile(path));
  if (digest.toLowerCase() !== artifact.digest.toLowerCase()) {
    throw new Error(`ProcedureArtifact digest mismatch for ${artifact.id}: ${digest} != ${artifact.digest}`);
  }
  return { path, digest };
}

export async function writeInputArtifact(
  artifactRoot: string,
  runId: string,
  inputs: JsonObject,
): Promise<{ path: string; ref: ResourceRefV1 }> {
  const data = `${JSON.stringify(inputs, null, 2)}\n`;
  const path = resolve(artifactRoot, runId, "input.json");
  const digest = await atomicWrite(path, data);
  return {
    path,
    ref: {
      system: "ouro",
      type: "run_input",
      id: `${runId}/input`,
      version: "1",
      uri: path,
      digest,
    },
  };
}

export async function snapshotProcedureArtifact(
  artifactRoot: string,
  runId: string,
  sourcePath: string,
  expectedDigest: `sha256:${string}`,
): Promise<{ path: string; ref: ResourceRefV1 }> {
  const data = await readFile(sourcePath);
  const digest = digestBytes(data);
  if (digest.toLowerCase() !== expectedDigest.toLowerCase()) {
    throw new Error(`ProcedureArtifact changed before snapshot: ${digest} != ${expectedDigest}`);
  }
  const path = resolve(artifactRoot, runId, `procedure${extname(sourcePath)}`);
  await atomicWrite(path, data);
  const sourceMode = (await stat(sourcePath)).mode & 0o777;
  await chmod(path, sourceMode);
  return {
    path,
    ref: {
      system: "ouro",
      type: "procedure_snapshot",
      id: `${runId}/procedure`,
      version: "1",
      uri: path,
      digest,
    },
  };
}

export async function writeOutputArtifact(
  artifactRoot: string,
  runId: string,
  attemptId: string,
  stream: "stdout" | "stderr",
  data: Buffer,
): Promise<ResourceRefV1> {
  const path = resolve(artifactRoot, runId, attemptId, `${stream}.log`);
  const digest = await atomicWrite(path, data);
  return {
    system: "ouro",
    type: "run_output",
    id: `${runId}/${attemptId}/${stream}`,
    version: "1",
    uri: path,
    digest,
  };
}

export function resolveInsideWorkspace(workspacePath: string, uri: string): string {
  const workspace = resolve(workspacePath);
  const candidate = uri.startsWith("file:")
    ? resolve(fileURLToPath(uri))
    : resolve(workspace, uri);
  const position = relative(workspace, candidate);
  if (position === "" || (!position.startsWith("..") && !isAbsolute(position))) return candidate;
  throw new Error(`ProcedureArtifact must resolve inside the workspace: ${uri}`);
}

export async function auditRunArtifacts(store: OuroStore): Promise<string[]> {
  const references = new Map<string, ResourceRefV1>();
  for (const run of Object.values(store.runs)) {
    for (const reference of [run.procedure.executionArtifact, run.procedure.inputs]) {
      references.set(`${reference.system}:${reference.type}:${reference.id}`, reference);
    }
  }
  for (const attempt of Object.values(store.attempts)) {
    for (const reference of [attempt.stdout, attempt.stderr]) {
      if (reference) references.set(`${reference.system}:${reference.type}:${reference.id}`, reference);
    }
  }
  const errors: string[] = [];
  for (const reference of references.values()) {
    if (!reference.uri || !reference.digest) {
      errors.push(`${reference.type}:${reference.id} is missing a local URI or digest`);
      continue;
    }
    try {
      const actual = digestBytes(await readFile(reference.uri));
      if (actual.toLowerCase() !== reference.digest.toLowerCase()) {
        errors.push(`${reference.type}:${reference.id} artifact digest mismatch`);
      }
    } catch (error) {
      errors.push(
        `${reference.type}:${reference.id} artifact cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return errors;
}

async function atomicWrite(path: string, data: string | Buffer): Promise<`sha256:${string}`> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, data);
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return digestBytes(data);
}
