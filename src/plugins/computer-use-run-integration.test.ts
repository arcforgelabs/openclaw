import { describe, expect, it, vi } from "vitest";
import { ComputerToolSession } from "../agents/tools/computer-tool-node.js";
import type { ComputerUseCapabilityDescriptor } from "./computer-use-contract.js";
import { fixture, first, second, owner, other } from "./computer-use-registration.test-helpers.js";

const resolveBinding = vi.hoisted(() => vi.fn());
vi.mock("../agents/tools/computer-tool-bindings.js", () => ({
  resolveComputerBinding: resolveBinding,
  NOT_COMPUTER_CAPABLE_HINT: "enable computer control",
}));
const inspect = { action: "inspect" };
const cleanup = {
  action: "__close_execution",
  executionId: first,
  providerGeneration: "generation-one",
};
describe("run cleanup through registered provider commands", () => {
  function sessionFixture() {
    const h = fixture();
    const computerUse = h.commands.get("computer.act")!.computerUse!({
      config: {},
      env: {},
    }) as ComputerUseCapabilityDescriptor;
    const binding = {
      host: { host: "node" as const, nodeId: "agent-seat" },
      gatewayOpts: {},
      capabilities: computerUse,
      executionOwnership: true,
      invoke: async (request: {
        command: string;
        commandParams: Record<string, unknown>;
        signal?: AbortSignal;
      }) => await h.invoke(request.command, request.commandParams, owner, request.signal),
    };
    resolveBinding.mockResolvedValue(binding);
    let registeredCleanup: ((reason: string) => Promise<void>) | undefined;
    const session = new ComputerToolSession({
      executionId: first,
      onCapabilitiesChanged: () => {},
      getOperationQueue: async () => {},
      registerRunCleanup: (close) => {
        registeredCleanup = close;
      },
    });
    return {
      h,
      session,
      cleanup: async (reason: string) => {
        if (!registeredCleanup) {
          throw new Error("Missing run cleanup");
        }
        await registeredCleanup(reason);
      },
    };
  }

  it.each(["completion", "cancellation"])(
    "drains two calls and the registered %s cleanup, then permits another caller",
    async (reason) => {
      const { h, session, cleanup: closeRun } = sessionFixture();
      const resolved = await session.resolveTarget({
        action: "screenshot",
        input: { node: "agent-seat" },
        gatewayOpts: {},
      });
      await session.captureScreenshot(resolved, 1280);
      if (reason === "cancellation") {
        h.snapshot.mockImplementationOnce(async (_params, signal) => {
          signal?.throwIfAborted();
          throw new Error("expected an aborted signal");
        });
        const abort = new AbortController();
        abort.abort(new Error("fixture cancellation"));
        await expect(session.captureScreenshot(resolved, 1280, abort.signal)).rejects.toThrow(
          "fixture cancellation",
        );
      } else {
        await session.captureScreenshot(resolved, 1280);
      }
      await closeRun(reason);
      expect(h.close).toHaveBeenCalledExactlyOnceWith(reason);
      expect(await h.invoke("computer.execution", inspect)).toMatchObject({ state: "free" });
      await h.invoke("screen.snapshot", { executionId: second }, other);
      await h.invoke("computer.act", { ...cleanup, executionId: second }, other);
    },
  );

  it.each(["failed-close", "no-op"])(
    "exposes %s to the run owner instead of confirming release",
    async (failure) => {
      const { h, session, cleanup: closeRun } = sessionFixture();
      const resolved = await session.resolveTarget({
        action: "screenshot",
        input: { node: "agent-seat" },
        gatewayOpts: {},
      });
      await session.captureScreenshot(resolved, 1280);
      if (failure === "failed-close") {
        h.close.mockRejectedValueOnce(new Error("fixture close failed"));
      } else {
        await h.invoke("computer.act", cleanup);
      }
      await expect(closeRun("completion")).rejects.toMatchObject({
        message: "computer: session desktop cleanup failed",
        errors: [
          expect.objectContaining({
            message: expect.stringContaining("agent-seat"),
            cause: expect.any(Error),
          }),
        ],
      });
      if (failure === "failed-close") {
        expect(await h.invoke("computer.execution", inspect)).toMatchObject({ state: "owned" });
        await h.commands.get("screen.snapshot")!.onDisconnect?.();
      }
    },
  );
});

describe("approved agent seat selection through registered provider commands", () => {
  function seats(failFirst?: string) {
    const busy = fixture();
    const chosen = fixture();
    const capabilities = chosen.commands.get("computer.act")!.computerUse!({
      config: {},
      env: {},
    }) as ComputerUseCapabilityDescriptor;
    const resolved: string[] = [];
    resolveBinding.mockImplementation(async ({ node }: { node: string }) => {
      resolved.push(node);
      const provider = node === "seat-one" ? busy : chosen;
      return {
        host: { host: "node", nodeId: node },
        gatewayOpts: {},
        capabilities,
        executionOwnership: true,
        invoke: async (request: { command: string; commandParams: Record<string, unknown> }) => {
          if (node === "seat-one" && failFirst) {
            throw Object.assign(new Error("INVALID_REQUEST: " + failFirst), {
              name: "GatewayClientRequestError",
              details: { nodeError: { code: "INVALID_REQUEST", message: failFirst } },
            });
          }
          return await provider.invoke(request.command, request.commandParams, owner);
        },
      };
    });
    const session = new ComputerToolSession({
      executionId: first,
      agentNodeCandidates: ["seat-one", "seat-two"],
      onCapabilitiesChanged: () => {},
      getOperationQueue: async () => {},
      registerRunCleanup: () => {},
    });
    return { session, busy, chosen, resolved };
  }
  it("acquires by observation after busy refusal and retains that exact seat instead of Primary", async () => {
    const h = seats("COMPUTER_HOST_BUSY: another execution owns this seat");
    const firstTarget = await h.session.resolveTarget({
      action: "screenshot",
      input: {},
      gatewayOpts: {},
    });
    expect(firstTarget.target).toMatchObject({ host: "node", nodeId: "seat-two" });
    await h.session.captureScreenshot(firstTarget, 1280);
    expect(h.chosen.snapshot).toHaveBeenCalledOnce();
    const secondTarget = await h.session.resolveTarget({
      action: "screenshot",
      input: {},
      gatewayOpts: {},
    });
    await h.session.captureScreenshot(secondTarget, 1280);
    expect(secondTarget.target).toMatchObject({ nodeId: "seat-two" });
    expect(h.resolved).toEqual(["seat-one", "seat-two"]);
    await expect(
      h.session.resolveTarget({
        action: "screenshot",
        input: { target: "gateway" },
        gatewayOpts: {},
      }),
    ).rejects.toThrow("target overrides");
    await h.session.dispose("completion");
    expect(await h.chosen.invoke("computer.execution", inspect)).toMatchObject({ state: "free" });
  });
  it("does not acquire through an input command and rejects a changed provider after selection", async () => {
    const h = seats();
    await expect(
      h.session.resolveTarget({ action: "type", input: { text: "unused" }, gatewayOpts: {} }),
    ).rejects.toThrow("take a screenshot");
    expect(h.resolved).toEqual([]);
    const target = await h.session.resolveTarget({
      action: "screenshot",
      input: {},
      gatewayOpts: {},
    });
    await h.session.captureScreenshot(target, 1280);
    h.busy.setGeneration("generation-two");
    const next = await h.session.resolveTarget({
      action: "screenshot",
      input: {},
      gatewayOpts: {},
    });
    await expect(h.session.captureScreenshot(next, 1280)).rejects.toThrow("COMPUTER_OWNER_CHANGED");
    expect(h.resolved).toEqual(["seat-one"]);
  });
});
