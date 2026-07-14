import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { EnvironmentSpec, Runtime } from "./schema.js";

export type ExecuteInput = {
  runtime: Runtime;
  artifactPath: string;
  args: string[];
  cwd: string;
  inputPath: string;
  runId: string;
  attemptNumber: number;
  timeoutMs: number;
  environment: EnvironmentSpec;
  maxOutputBytes?: number;
};

export type ProcessResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  stdout: Buffer;
  stderr: Buffer;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  spawnError?: string;
};

export interface ProcessExecutor {
  execute(input: ExecuteInput): Promise<ProcessResult>;
}

export class LocalProcessExecutor implements ProcessExecutor {
  async execute(input: ExecuteInput): Promise<ProcessResult> {
    const command = input.runtime === "node" ? process.execPath : input.artifactPath;
    const args = input.runtime === "node" ? [input.artifactPath, ...input.args] : input.args;
    const environment = buildEnvironment(input.environment, {
      OURO_INPUT_PATH: input.inputPath,
      OURO_RUN_ID: input.runId,
      OURO_ATTEMPT: String(input.attemptNumber),
    });
    const limit = input.maxOutputBytes ?? 1_048_576;
    const stdout = new BoundedCapture(limit);
    const stderr = new BoundedCapture(limit);
    const started = performance.now();

    return new Promise((resolveResult) => {
      const child = spawn(command, args, {
        cwd: input.cwd,
        env: environment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let timedOut = false;
      let spawnError: string | undefined;
      let forceKill: NodeJS.Timeout | undefined;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        forceKill = setTimeout(() => child.kill("SIGKILL"), 500);
        forceKill.unref();
      }, input.timeoutMs);
      timeout.unref();
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (error) => {
        spawnError = error.message;
      });
      child.on("close", (exitCode, signal) => {
        clearTimeout(timeout);
        if (forceKill) clearTimeout(forceKill);
        resolveResult({
          exitCode,
          signal,
          timedOut,
          durationMs: Math.max(0, Math.round(performance.now() - started)),
          stdout: stdout.value(),
          stderr: stderr.value(),
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          ...(spawnError ? { spawnError } : {}),
        });
      });
    });
  }
}

function buildEnvironment(
  spec: EnvironmentSpec,
  required: Record<string, string>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of spec.inherit ?? []) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  for (const [name, value] of Object.entries(spec.set ?? {})) environment[name] = value;
  return { ...environment, ...required };
}

class BoundedCapture {
  readonly limit: number;
  readonly chunks: Buffer[] = [];
  length = 0;
  truncated = false;

  constructor(limit: number) {
    this.limit = limit;
  }

  push(chunk: Buffer): void {
    if (this.length >= this.limit) {
      this.truncated = true;
      return;
    }
    const remaining = this.limit - this.length;
    const selected = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    this.chunks.push(selected);
    this.length += selected.length;
    if (selected.length < chunk.length) this.truncated = true;
  }

  value(): Buffer {
    return Buffer.concat(this.chunks, this.length);
  }
}
