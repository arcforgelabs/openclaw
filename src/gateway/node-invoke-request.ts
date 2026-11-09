import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

export function buildNodeInvokeRequest(params: {
  id: string;
  nodeId: string;
  command: string;
  params?: unknown;
  timeoutMs: number;
  idempotencyKey?: string;
  sessionKey?: string;
}) {
  let commandParams = params.params;
  let computerExecutionV1: unknown;
  if (
    ["screen.snapshot", "computer.act", "computer.execution"].includes(params.command) &&
    isRecord(commandParams)
  ) {
    const { computerExecutionCaller, ...input } = commandParams;
    // Only the current Gateway serializer can place provenance outside paramsJSON.
    // An older Gateway forwarding forged command arguments cannot mint this field.
    computerExecutionV1 = computerExecutionCaller;
    commandParams = input;
  }
  return {
    id: params.id,
    nodeId: params.nodeId,
    command: params.command,
    paramsJSON: commandParams === undefined ? null : JSON.stringify(commandParams),
    ...(computerExecutionV1 !== undefined ? { computerExecutionV1 } : {}),
    timeoutMs: params.timeoutMs,
    idempotencyKey: params.idempotencyKey,
    sessionKey: normalizeOptionalString(params.sessionKey),
  };
}

/** Measure the same outer encoding sent to nodes, including paramsJSON escaping. */
export function serializeNodeEvent(event: string, payload: unknown): string {
  return JSON.stringify({ type: "event", event, payload });
}
