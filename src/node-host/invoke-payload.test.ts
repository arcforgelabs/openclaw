import { describe, expect, it } from "vitest";
import { coerceNodeInvokeInputPayload, coerceNodeInvokePayload } from "./invoke-payload.js";
import { withNodeHostPluginInvocation } from "./invoke-plugin-context.js";

describe("coerceNodeInvokePayload", () => {
  it.each([
    ["normalizes the owning session", "  agent:main:managed  ", "agent:main:managed"],
    ["omits an absent owning session", undefined, undefined],
    ["omits a blank owning session", "  ", undefined],
  ])("%s", (_name, sessionKey, expectedSessionKey) => {
    expect(
      coerceNodeInvokePayload({
        id: "invoke-1",
        nodeId: "node-1",
        command: "plugin.workspace",
        sessionKey,
      }),
    ).toEqual({
      id: "invoke-1",
      nodeId: "node-1",
      command: "plugin.workspace",
      paramsJSON: null,
      timeoutMs: null,
      idempotencyKey: null,
      ...(expectedSessionKey ? { sessionKey: expectedSessionKey } : {}),
    });
  });
});

describe("coerceNodeInvokeInputPayload", () => {
  it("accepts a bounded well-formed input payload", () => {
    expect(
      coerceNodeInvokeInputPayload({
        id: "invoke-1",
        nodeId: "node-1",
        seq: 0,
        payloadJSON: JSON.stringify({ kind: "data", data: "keys" }),
      }),
    ).toEqual({
      invokeId: "invoke-1",
      nodeId: "node-1",
      seq: 0,
      payloadJSON: JSON.stringify({ kind: "data", data: "keys" }),
    });
  });

  it.each([
    [
      "oversized payloadJSON",
      { id: "i", nodeId: "n", seq: 0, payloadJSON: "x".repeat(16 * 1024 + 1) },
    ],
    ["negative seq", { id: "i", nodeId: "n", seq: -1, payloadJSON: "{}" }],
    ["fractional seq", { id: "i", nodeId: "n", seq: 0.5, payloadJSON: "{}" }],
    ["array frame", []],
    ["string frame", "input"],
  ])("rejects %s", (_name, payload) => {
    expect(coerceNodeInvokeInputPayload(payload)).toBeNull();
  });
});

it("never promotes computer ownership claims from model parameters into the host envelope", () => {
  const caller = { sessionKey: "agent:main:forged", recoveryOperator: true };
  const frame = coerceNodeInvokePayload({
    id: "invoke-owner",
    nodeId: "node-owner",
    command: "computer.execution",
    params: { action: "inspect", computerExecutionCaller: caller },
  });
  expect(frame).not.toHaveProperty("computerExecutionV1");
  expect(
    coerceNodeInvokePayload({
      id: "invoke-owner",
      nodeId: "node-owner",
      command: "computer.execution",
      computerExecutionV1: { recoveryOperator: "yes" },
    }),
  ).toBeNull();
});

it("retires retained computer owner capabilities when their invocation returns", async () => {
  const capability = await withNodeHostPluginInvocation(
    {
      context: { sendNodeEvent: async () => {} },
      computerExecutionV1: { recoveryOperator: false, callerId: "connection:fixture" },
    },
    async (context) => {
      const current = context?.computerExecutionV1;
      if (!current) {
        throw new Error("missing versioned ownership capability");
      }
      current.assertCurrent();
      return current;
    },
  );
  expect(() => capability.assertCurrent()).toThrow(
    "computer execution invocation authority is closed",
  );
});
