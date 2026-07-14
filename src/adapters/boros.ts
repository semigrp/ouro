import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resourceIdentity,
  type ContextBundleV1,
  type ContextQueryV1,
  type RegisterEvidenceCommandV1,
  type ResourceRefV1,
} from "../schema.js";
import { assertPinnedRef } from "../validation.js";

export interface BorosGateway {
  queryContext(query: ContextQueryV1): Promise<ContextBundleV1>;
  registerEvidence(command: RegisterEvidenceCommandV1): Promise<ResourceRefV1>;
}

export type BorosCliConfig = {
  bin: string;
  vault?: string;
};

export class BorosCliGateway implements BorosGateway {
  readonly config: BorosCliConfig;

  constructor(config: BorosCliConfig) {
    this.config = config;
  }

  async queryContext(query: ContextQueryV1): Promise<ContextBundleV1> {
    if (query.includeKinds?.length) {
      throw new Error("The current Boros CLI does not expose includeKinds; omit it for CLI transport");
    }
    const args = ["context"];
    for (const root of query.roots) args.push("--root", root.id);
    args.push("--purpose", query.purpose);
    if (query.asOf) args.push("--as-of", query.asOf);
    if (query.tokenBudget) args.push("--token-budget", String(query.tokenBudget));
    if (query.maxResources) args.push("--max-resources", String(query.maxResources));
    for (const sensitivity of query.allowedSensitivities ?? []) {
      args.push("--sensitivity", sensitivity);
    }
    this.addVault(args);
    const response = await this.invoke(args);
    const bundle = unwrapResult(response) as ContextBundleV1;
    assertContextBundle(bundle);
    for (const expected of query.roots) {
      if (!expected.version) continue;
      const actual = bundle.query.roots.find(
        (candidate) => resourceIdentity(candidate) === resourceIdentity(expected),
      );
      if (!actual || actual.version !== expected.version) {
        throw new Error(
          `Boros resolved a different root revision for ${expected.id}: ${actual?.version ?? "missing"}`,
        );
      }
    }
    return bundle;
  }

  async registerEvidence(command: RegisterEvidenceCommandV1): Promise<ResourceRefV1> {
    const directory = await mkdtemp(join(tmpdir(), "ouro-boros-command-"));
    try {
      const input = join(directory, "register-evidence.json");
      await writeFile(input, `${JSON.stringify(command, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      const args = ["evidence", "register", "--input", input];
      this.addVault(args);
      const response = await this.invoke(args);
      const result = unwrapResult(response) as {
        evidence?: { id?: unknown; version?: unknown; kind?: unknown };
      };
      if (
        !result.evidence ||
        typeof result.evidence.id !== "string" ||
        typeof result.evidence.version !== "string"
      ) {
        throw new Error("Boros returned an invalid Evidence registration response");
      }
      return {
        system: "boros",
        type: typeof result.evidence.kind === "string" ? result.evidence.kind : "evidence",
        id: result.evidence.id,
        version: result.evidence.version,
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private addVault(args: string[]): void {
    if (this.config.vault) args.push("--vault", this.config.vault);
  }

  private async invoke(args: string[]): Promise<unknown> {
    const isJavaScript = this.config.bin.endsWith(".js");
    const command = isJavaScript ? process.execPath : this.config.bin;
    const commandArgs = isJavaScript ? [this.config.bin, ...args] : args;
    const result = await spawnJson(command, commandArgs);
    if (result.exitCode !== 0) {
      throw new Error(`Boros CLI failed with exit ${result.exitCode}: ${result.stderr.trim()}`);
    }
    try {
      return JSON.parse(result.stdout) as unknown;
    } catch {
      throw new Error("Boros CLI returned non-JSON output");
    }
  }
}

export class StaticBorosGateway implements BorosGateway {
  readonly bundle: ContextBundleV1;
  readonly contextQueries: ContextQueryV1[] = [];
  readonly evidenceCommands: RegisterEvidenceCommandV1[] = [];
  failEvidence = false;

  constructor(bundle: ContextBundleV1) {
    this.bundle = bundle;
  }

  async queryContext(query: ContextQueryV1): Promise<ContextBundleV1> {
    this.contextQueries.push(structuredClone(query));
    return structuredClone(this.bundle);
  }

  async registerEvidence(command: RegisterEvidenceCommandV1): Promise<ResourceRefV1> {
    this.evidenceCommands.push(structuredClone(command));
    if (this.failEvidence) throw new Error("Fixture Boros is unavailable");
    return {
      system: "boros",
      type: "evidence",
      id: `EVD-FIXTURE-${String(this.evidenceCommands.length).padStart(4, "0")}`,
      version: "1",
    };
  }
}

function assertContextBundle(bundle: ContextBundleV1): void {
  if (bundle.schema !== "boros.context-bundle/v1" || !bundle.id || !bundle.digest) {
    throw new Error("Boros returned an invalid ContextBundle");
  }
  assertPinnedRef(
    {
      system: "boros",
      type: "context_bundle",
      id: bundle.id,
      version: "1",
      digest: bundle.digest,
    },
    "Boros ContextBundle",
    true,
  );
  assertPinnedRef(bundle.ontology, "Boros OntologyRelease", true);
  for (const selection of bundle.selections) {
    assertPinnedRef(selection.resource, `Context selection ${selection.resource.id}`);
  }
}

function unwrapResult(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("result" in value)) {
    throw new Error("Boros CLI response is missing result");
  }
  return (value as { result: unknown }).result;
}

async function spawnJson(
  command: string,
  args: string[],
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolveResult({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}
