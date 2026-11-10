import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  SYSTEM_RUN_EXECUTION_CONTEXT_CAPABILITY,
  validateSystemRunExecutionContext,
} from "../../packages/gateway-protocol/src/system-run-execution-context.js";
import { readComputerExecutionCleanup } from "./computer-execution-cleanup.js";
import type { ExecApprovalManager } from "./exec-approval-manager.js";
import { sanitizeSystemRunParamsForForwarding } from "./node-invoke-system-run-approval.js";
import { hasGatewayAdminScope } from "./operator-scopes.js";
import type { GatewayClient } from "./server-methods/types.js";

export async function sanitizeNodeInvokeParamsForForwarding(opts: {
  nodeId: string;
  command: string;
  caps?: readonly string[];
  declaredCommands?: readonly string[];
  rawParams: unknown;
  client: GatewayClient | null;
  execApprovalManager?: ExecApprovalManager;
}): ReturnType<typeof sanitizeSystemRunParamsForForwarding> {
  if (opts.command === "system.run" || opts.command === "system.run.prepare") {
    const context = asNullableRecord(opts.rawParams)?.executionContext;
    if (
      context !== undefined &&
      (!opts.caps?.includes(SYSTEM_RUN_EXECUTION_CONTEXT_CAPABILITY) ||
        !validateSystemRunExecutionContext(context))
    ) {
      return {
        ok: false,
        message: "executionContext invalid or unsupported by node; update the node and Gateway",
      };
    }
  }
  if (opts.command === "system.run") {
    return sanitizeSystemRunParamsForForwarding(opts);
  }
  if (
    opts.command === "computer.execution" ||
    ((opts.command === "screen.snapshot" || opts.command === "computer.act") &&
      opts.declaredCommands?.includes("computer.execution"))
  ) {
    const raw = asNullableRecord(opts.rawParams);
    if (raw) {
      // Never accept ownership provenance or recovery authority from tool arguments.
      const { computerExecutionCaller: _ignored, ...params } = raw;
      const cleanup = readComputerExecutionCleanup(opts);
      const identity = opts.client?.internal?.agentRuntimeIdentity;
      const callerId = identity
        ? undefined
        : !opts.client?.internal?.syntheticClient && opts.client?.connect?.device?.id
          ? "device:" + opts.client.connect.device.id
          : opts.client?.internal?.pluginRuntimeOwnerId
            ? "plugin:" + opts.client.internal.pluginRuntimeOwnerId
            : opts.client?.connId
              ? "connection:" + opts.client.connId
              : undefined;
      return {
        ok: true,
        params: {
          ...params,
          computerExecutionCaller: {
            ...(cleanup ? { cleanup } : {}),
            ...(identity
              ? {
                  sessionKey: identity.sessionKey,
                  runId: identity.operationalRunInstance.runId,
                  instanceId: identity.operationalRunInstance.instanceId,
                }
              : {}),
            ...(!identity && callerId ? { callerId } : {}),
            recoveryOperator:
              !identity &&
              !opts.client?.internal?.syntheticClient &&
              hasGatewayAdminScope(opts.client),
          },
        },
      };
    }
  }
  if (opts.command === "screen.snapshot" || opts.command === "computer.act") {
    const raw = asNullableRecord(opts.rawParams);
    if (raw && Object.hasOwn(raw, "computerExecutionCaller")) {
      const { computerExecutionCaller: _ignored, ...params } = raw;
      return { ok: true, params };
    }
  }
  return { ok: true, params: opts.rawParams };
}
