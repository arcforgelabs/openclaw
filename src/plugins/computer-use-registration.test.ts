import { describe, expect, it, vi } from "vitest";
import {
  guardAgentSeatBinding,
  resolveAgentSeatTarget,
  type AgentSeatSelection,
} from "../agents/tools/computer-tool-agent-seat.js";
import type { ComputerBinding } from "../agents/tools/computer-tool-bindings.js";
import type { ResolvedComputerTarget } from "../agents/tools/computer-tool-shared.js";
import { createDeferredCore } from "../shared/deferred.js";
import { fixture, first, second, owner, other } from "./computer-use-registration.test-helpers.js";

const inspect = { action: "inspect" };
const snapshot = { executionId: first };
const recovery = {
  action: "recover",
  executionId: first,
  providerGeneration: "generation-one",
};
const cleanup = {
  action: "__close_execution",
  executionId: first,
  providerGeneration: "generation-one",
};

describe("registered computer execution ownership", () => {
  it("inspects passively, retains the first owner across commands, and keeps private metadata private", async () => {
    const h = fixture();
    expect([...h.commands.keys()]).toContain("computer.execution");
    expect(await h.invoke("computer.execution", inspect)).toEqual({
      state: "free",
      providerGeneration: "generation-one",
    });
    expect(h.openExecution).not.toHaveBeenCalled();
    await h.invoke("screen.snapshot", snapshot);
    await h.invoke("screen.snapshot", snapshot);
    expect(h.openExecution).toHaveBeenCalledOnce();
    expect(await h.invoke("computer.execution", inspect)).toMatchObject({
      state: "owned",
      executionId: first,
      providerGeneration: "generation-one",
      activity: "unknown",
      owner,
    });
    const privateRead = await h.invoke("computer.execution", inspect, other);
    expect(privateRead).toMatchObject({ state: "owned", executionId: first });
    expect(privateRead).not.toHaveProperty("owner");
    await expect(h.invoke("screen.snapshot", { executionId: second }, other)).rejects.toThrow(
      "COMPUTER_HOST_BUSY",
    );
    await expect(h.invoke("screen.snapshot", snapshot, other)).rejects.toThrow(
      "COMPUTER_OWNER_FORBIDDEN",
    );
    await expect(h.invoke("computer.act", cleanup, other)).rejects.toThrow(
      "COMPUTER_OWNER_FORBIDDEN",
    );
    expect(h.close).not.toHaveBeenCalled();
    await h.invoke("computer.act", cleanup);
  });

  it.each(["completion", "cancellation"])(
    "releases exact run cleanup (%s) and permits another run without restarting the provider",
    async (reason) => {
      const h = fixture();
      await h.invoke("screen.snapshot", snapshot);
      await h.invoke("computer.act", { action: "type", text: "fixture", executionId: first });
      expect(await h.invoke("computer.act", { ...cleanup, reason })).toEqual({
        ok: true,
        released: true,
      });
      expect(await h.invoke("computer.act", cleanup)).toEqual({ ok: true, released: false });
      expect(h.close).toHaveBeenCalledExactlyOnceWith(reason);
      await h.invoke("screen.snapshot", { executionId: second }, other);
      expect(await h.invoke("computer.execution", inspect, other)).toMatchObject({
        executionId: second,
        owner: other,
      });
      await h.invoke("computer.act", { ...cleanup, executionId: second }, other);
    },
  );

  it.each([first, second])(
    "preserves a changed acquisition (%s) and rejects private-owner recovery",
    async (nextExecution) => {
      const h = fixture();
      await h.invoke("screen.snapshot", snapshot);
      const observed = await h.invoke("computer.execution", inspect);
      await expect(
        h.invoke("computer.execution", { ...recovery, ownershipId: observed.ownershipId }, other),
      ).rejects.toThrow("COMPUTER_OWNER_FORBIDDEN");
      await h.invoke("computer.act", cleanup);
      await h.invoke("screen.snapshot", { executionId: nextExecution }, other);
      await expect(
        h.invoke(
          "computer.execution",
          { ...recovery, ownershipId: observed.ownershipId },
          { recoveryOperator: true },
        ),
      ).rejects.toThrow("COMPUTER_OWNER_CHANGED");
      expect(await h.invoke("computer.execution", inspect, other)).toMatchObject({
        executionId: nextExecution,
      });
      await h.invoke("computer.act", { ...cleanup, executionId: nextExecution }, other);
    },
  );

  it("rechecks generation at physical close after awaiting provider initialization", async () => {
    const h = fixture();
    const opened = createDeferredCore<Awaited<ReturnType<typeof h.openExecution>>>();
    h.openExecution.mockReturnValueOnce(opened.promise);
    const capture = h.invoke("screen.snapshot", snapshot);
    const observed = await h.invoke("computer.execution", inspect);
    const releasing = h.invoke("computer.execution", {
      ...recovery,
      ownershipId: observed.ownershipId,
    });
    h.setGeneration("generation-two");
    opened.resolve({ close: h.close, snapshot: h.snapshot, act: async () => '{"ok":true}' });
    await capture;
    await expect(releasing).rejects.toThrow("COMPUTER_OWNER_CHANGED");
    expect(h.close).not.toHaveBeenCalled();
    expect(await h.invoke("computer.execution", inspect)).toMatchObject({
      state: "owned",
      executionId: first,
    });
    await h.commands.get("screen.snapshot")!.onDisconnect?.();
  });

  it("keeps failed cleanup visible and owned until explicit successful recovery", async () => {
    const h = fixture();
    await h.invoke("screen.snapshot", snapshot);
    h.close.mockRejectedValueOnce(new Error("fixture close failed"));
    await expect(h.invoke("computer.act", cleanup)).rejects.toThrow("fixture close failed");
    expect(await h.invoke("computer.execution", inspect)).toMatchObject({
      state: "owned",
      executionId: first,
    });
    await expect(h.invoke("screen.snapshot", snapshot)).rejects.toThrow("fixture close failed");
    await expect(
      h.invoke("computer.act", { executionId: first, action: "key", text: "Return" }),
    ).rejects.toThrow("fixture close failed");
    const observed = await h.invoke("computer.execution", inspect);
    expect(
      await h.invoke("computer.execution", { ...recovery, ownershipId: observed.ownershipId }),
    ).toMatchObject({
      ok: true,
      released: true,
      executionId: first,
    });
    expect(await h.invoke("computer.execution", inspect)).toMatchObject({ state: "free" });
    await h.invoke("screen.snapshot", { executionId: second }, other);
    await h.invoke("computer.act", { ...cleanup, executionId: second }, other);
  });

  it("does not let a standalone screenshot bypass an owned execution", async () => {
    const h = fixture();
    await h.invoke("screen.snapshot", snapshot);
    await expect(h.invoke("screen.snapshot", {}, other)).rejects.toThrow("COMPUTER_HOST_BUSY");
    expect(h.openExecution).toHaveBeenCalledOnce();
    await h.invoke("computer.act", cleanup);
    await h.invoke("screen.snapshot", {}, other);
    expect(await h.invoke("computer.execution", inspect)).toMatchObject({ state: "free" });
  });
});

it("cancels recovery without releasing its inspected owner", async () => {
  const h = fixture();
  await h.invoke("screen.snapshot", snapshot);
  const observed = await h.invoke("computer.execution", inspect);
  const abort = new AbortController();
  abort.abort(new Error("interruption cancelled"));
  await expect(
    h.invoke(
      "computer.execution",
      { ...recovery, ownershipId: observed.ownershipId },
      owner,
      abort.signal,
    ),
  ).rejects.toThrow("interruption cancelled");
  expect(h.close).not.toHaveBeenCalled();
  expect(await h.invoke("computer.execution", inspect)).toMatchObject({
    state: "owned",
    executionId: first,
  });
  await h.invoke("computer.act", cleanup);
});

it("does not adopt Unknown work through its disclosed execution ID", async () => {
  const h = fixture();
  await h.invoke("screen.snapshot", snapshot, {});
  const observed = await h.invoke("computer.execution", inspect);
  expect(observed).not.toHaveProperty("owner");
  await expect(h.invoke("screen.snapshot", snapshot)).rejects.toThrow("COMPUTER_OWNER_FORBIDDEN");
  await expect(h.invoke("computer.act", cleanup)).rejects.toThrow("COMPUTER_OWNER_FORBIDDEN");
  expect(h.close).not.toHaveBeenCalled();
  await h.invoke(
    "computer.execution",
    { ...recovery, ownershipId: observed.ownershipId },
    { recoveryOperator: true },
  );
});

it("retains sessionless operator ownership by authenticated connection without inventing a run", async () => {
  const h = fixture();
  const operator = { callerId: "connection:operator-one", recoveryOperator: true };
  await h.invoke("screen.snapshot", snapshot, operator);
  await h.invoke("screen.snapshot", snapshot, operator);
  expect(await h.invoke("computer.execution", inspect, operator)).not.toHaveProperty("owner");
  await expect(
    h.invoke("computer.act", cleanup, {
      callerId: "connection:operator-two",
      recoveryOperator: true,
    }),
  ).rejects.toThrow("COMPUTER_OWNER_FORBIDDEN");
  expect(h.close).not.toHaveBeenCalled();
  await h.invoke("computer.act", cleanup, operator);
});

it("rejects owner claims forwarded only inside command arguments by an older Gateway", async () => {
  const h = fixture();
  await expect(
    h.commands.get("computer.execution")!.handle(
      JSON.stringify({
        action: "inspect",
        computerExecutionCaller: { ...owner, recoveryOperator: true },
      }),
    ),
  ).rejects.toThrow("COMPUTER_OWNERSHIP_UNAVAILABLE");
  expect(h.openExecution).not.toHaveBeenCalled();
});

it.each(["screen.snapshot", "computer.act", "standalone"])(
  "does not perform %s after cancellation during provider initialization",
  async (command) => {
    const h = fixture();
    let opened!: (value: Awaited<ReturnType<typeof h.openExecution>>) => void;
    const provider = await h.openExecution();
    h.openExecution.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          opened = resolve;
        }),
    );
    h.snapshot.mockClear();
    const abort = new AbortController();
    const pending = h.invoke(
      command === "standalone" ? "screen.snapshot" : command,
      command === "standalone" ? {} : { executionId: first, action: "key", text: "Return" },
      owner,
      abort.signal,
    );
    await Promise.resolve();
    abort.abort(new Error("cancelled while opening"));
    opened(provider);
    await expect(pending).rejects.toThrow("cancelled while opening");
    expect(h.snapshot).not.toHaveBeenCalled();
    expect(provider.act).not.toHaveBeenCalled();
    if (command === "standalone") {
      expect(h.close).toHaveBeenCalledOnce();
    } else {
      await h.invoke("computer.act", cleanup);
    }
  },
);

it("selects by actual acquisition after a framed busy refusal, not by a passive peek", async () => {
  const occupied = fixture();
  const available = fixture();
  await occupied.invoke("screen.snapshot", { executionId: second }, other);
  const selection: AgentSeatSelection = { candidates: ["agent-one", "agent-two"], locked: false };
  let selected: ComputerBinding | undefined;
  const operations = {
    referenceWidth: 1280,
    selected: () => selected,
    resolve: async (request: { input: Record<string, unknown> }) => {
      const nodeId =
        typeof request.input.node === "string"
          ? request.input.node
          : selected?.host.host === "node"
            ? selected.host.nodeId
            : "";
      selected = { host: { host: "node", nodeId }, gatewayOpts: {}, invoke: async () => {} };
      return { target: { host: "node" as const, nodeId, screenIndex: 0 } };
    },
    capture: async (target: ResolvedComputerTarget) => {
      const provider =
        target.target.host === "node" && target.target.nodeId === "agent-one"
          ? occupied
          : available;
      try {
        const result = await provider.invoke(
          "screen.snapshot",
          { executionId: first, providerGeneration: "generation-one" },
          owner,
        );
        return {
          base64: result.base64,
          displayFrameId: result.displayFrameId,
          mimeType: "image/png",
        };
      } catch (error) {
        throw Object.assign(new Error("node refused acquisition"), {
          name: "GatewayClientRequestError",
          details: {
            nodeError: {
              code: "INVALID_REQUEST",
              message: error instanceof Error ? error.message : "unknown",
            },
          },
        });
      }
    },
    forgetBusy: () => {},
  };
  const resolved = await resolveAgentSeatTarget(
    selection,
    { action: "screenshot", input: {}, gatewayOpts: {} },
    operations,
  );
  expect(resolved.target).toMatchObject({ nodeId: "agent-two" });
  expect(selection.locked).toBe(true);
  expect(resolved.initialCapture).toMatchObject({ displayFrameId: "frame-one" });
  expect(await occupied.invoke("computer.execution", inspect, other)).toMatchObject({
    executionId: second,
  });
  expect(await available.invoke("computer.execution", inspect, owner)).toMatchObject({
    executionId: first,
  });
  await expect(
    resolveAgentSeatTarget(
      selection,
      { action: "screenshot", input: { target: "gateway" }, gatewayOpts: {} },
      operations,
    ),
  ).rejects.toThrow("target overrides");
  await occupied.invoke("computer.act", { ...cleanup, executionId: second }, other);
  await available.invoke("computer.act", cleanup, owner);
});

it.each(["TIMEOUT: ambiguous", "FORBIDDEN: denied", undefined])(
  "does not try another agent seat after an unconfirmed acquisition failure (%s)",
  async (failure) => {
    const selection: AgentSeatSelection = { candidates: ["agent-one", "agent-two"], locked: false };
    const opened: string[] = [];
    const operations = {
      referenceWidth: 1280,
      selected: () => undefined,
      resolve: async (request: { input: Record<string, unknown> }) => {
        const nodeId = String(request.input.node);
        opened.push(nodeId);
        return { target: { host: "node" as const, nodeId, screenIndex: 0 } };
      },
      capture: async () => {
        throw failure;
      },
      forgetBusy: () => {},
    };
    await expect(
      resolveAgentSeatTarget(
        selection,
        { action: "screenshot", input: {}, gatewayOpts: {} },
        operations,
      ),
    ).rejects.toBe(failure);
    await expect(
      resolveAgentSeatTarget(
        selection,
        { action: "screenshot", input: {}, gatewayOpts: {} },
        operations,
      ),
    ).rejects.toBe(failure);
    expect(opened).toEqual(["agent-one"]);
  },
);

it("pins an approved seat's provider generation at the actual registered desktop operation", async () => {
  const h = fixture();
  const capabilities = h.commands.get("computer.act")!.computerUse!({ config: {}, env: {} });
  const binding = guardAgentSeatBinding({
    host: { host: "node", nodeId: "agent-seat" },
    gatewayOpts: {},
    capabilities,
    executionOwnership: true,
    invoke: async (request) => await h.invoke(request.command, request.commandParams, owner),
  });
  await binding.invoke({ command: "screen.snapshot", commandParams: { executionId: first } });
  h.setGeneration("generation-two");
  await expect(
    binding.invoke({ command: "screen.snapshot", commandParams: { executionId: first } }),
  ).rejects.toThrow("COMPUTER_OWNER_CHANGED");
  expect(h.snapshot).toHaveBeenCalledOnce();
  // Explicit disconnect cleanup still uses its existing internal owner, not a stale input header.
  await h.commands.get("screen.snapshot")!.onDisconnect?.();
});

it("keeps the legitimate owner usable when cancelled recovery never starts physical close", async () => {
  const h = fixture();
  const opened = createDeferredCore<Awaited<ReturnType<typeof h.openExecution>>>();
  h.openExecution.mockReturnValueOnce(opened.promise);
  const capture = h.invoke("screen.snapshot", { executionId: first }, owner);
  await Promise.resolve();
  const inspection = await h.invoke("computer.execution", inspect, owner);
  const abort = new AbortController();
  const recoveryAttempt = h.invoke(
    "computer.execution",
    {
      action: "recover",
      executionId: first,
      providerGeneration: "generation-one",
      ownershipId: inspection.ownershipId,
    },
    owner,
    abort.signal,
  );
  const rejected = expect(recoveryAttempt).rejects.toThrow();
  abort.abort(new Error("recovery cancelled before effect"));
  const act = vi.fn(async () => '{"ok":true}');
  opened.resolve({ close: h.close, snapshot: h.snapshot, act });
  await rejected;
  await capture;
  expect(h.close).not.toHaveBeenCalled();
  await h.invoke("screen.snapshot", { executionId: first }, owner);
  await h.invoke(
    "computer.act",
    { executionId: first, action: "type", text: "still owned" },
    owner,
  );
  await h.invoke("computer.act", cleanup, owner);
  expect(h.close).toHaveBeenCalledOnce();
});

it("limits transferred cleanup to its exact acquisition and never permits input", async () => {
  const h = fixture();
  await h.invoke("screen.snapshot", snapshot, owner);
  const acquired = await h.invoke("computer.execution", inspect, owner);
  const cleanupOnly = {
    cleanup: {
      executionId: first,
      providerGeneration: "generation-one",
      ownershipId: acquired.ownershipId,
    },
  };
  await expect(h.invoke("screen.snapshot", snapshot, cleanupOnly)).rejects.toThrow(
    "cleanup authority permits only its exact close",
  );
  await expect(
    h.invoke("computer.act", { ...snapshot, action: "type", text: "forbidden" }, cleanupOnly),
  ).rejects.toThrow("cleanup authority permits only its exact close");
  await h.invoke("computer.act", cleanup, cleanupOnly);
  expect(h.close).toHaveBeenCalledOnce();
  await h.invoke("screen.snapshot", snapshot, owner);
  await expect(h.invoke("computer.act", cleanup, cleanupOnly)).rejects.toThrow(
    "cleanup acquisition changed",
  );
  expect(h.close).toHaveBeenCalledOnce();
  await h.invoke("computer.act", cleanup, owner);
});
