import {
  stableJson,
  type ExecutionEvent,
  type FukuroTelemetryEventV1,
  type JsonObject,
  type OuroStore,
  type ResourceRefV1,
} from "../schema.js";
import { assertTelemetryEvent } from "../validation.js";

const DATA_FIELDS = new Set([
  "status",
  "attempt",
  "durationMs",
  "exitCode",
  "signal",
  "timedOut",
  "gateId",
  "expected",
  "actual",
  "permissionTier",
  "failureKind",
  "replayed",
]);

export function toFukuroTelemetry(event: ExecutionEvent): FukuroTelemetryEventV1 {
  const projected: FukuroTelemetryEventV1 = {
    schema: "fukuro.telemetry-event/v1",
    source: "ouro",
    sourceEventId: event.id,
    occurredAt: event.occurredAt,
    kind: telemetryKind(event),
    subject: withoutLocator(event.subject),
    refs: event.refs.map(withoutLocator),
    data: whitelistedData(event.data),
  };
  assertTelemetryEvent(projected);
  return projected;
}

export function exportFukuroNdjson(
  store: OuroStore,
  options: { sinceEventId?: string; runId?: string } = {},
): string {
  let events = store.events;
  if (options.sinceEventId) {
    const index = events.findIndex((event) => event.id === options.sinceEventId);
    if (index < 0) throw new Error(`Event not found: ${options.sinceEventId}`);
    events = events.slice(index + 1);
  }
  if (options.runId) {
    events = events.filter(
      (event) =>
        event.subject.id === options.runId || event.refs.some((reference) => reference.id === options.runId),
    );
  }
  if (events.length === 0) return "";
  return `${events.map((event) => stableJson(toFukuroTelemetry(event))).join("\n")}\n`;
}

function telemetryKind(event: ExecutionEvent): string {
  switch (event.type) {
    case "run_started":
      return "loop_start";
    case "attempt_completed":
      return "tick";
    case "run_succeeded":
    case "run_failed":
      return "loop_end";
    case "gate_evaluated":
      return event.data.status === "failed" ? "stop_line_hit" : "ouro_gate_passed";
    default:
      return `ouro_${event.type}`;
  }
}

function whitelistedData(data: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(data).filter(([key]) => DATA_FIELDS.has(key)),
  ) as JsonObject;
}

function withoutLocator(reference: ResourceRefV1): ResourceRefV1 {
  const { uri: _uri, ...safe } = reference;
  return safe;
}
