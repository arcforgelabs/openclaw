import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  COMPUTER_EXECUTION_ID_PATTERN,
  type ComputerUseCapabilityDescriptor,
} from "./computer-use-contract.js";
import type {
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeHostCommandAvailabilityContext,
  OpenClawPluginNodeHostCommandContext,
} from "./types.node-host.js";

type ComputerUseExecution = {
  snapshot(paramsJSON: string | null | undefined, signal?: AbortSignal): Promise<string>;
  act(paramsJSON: string | null | undefined, signal?: AbortSignal): Promise<string>;
  close(reason: string): Promise<void>;
};

export type ComputerUseProvider = {
  id: string;
  label: string;
  capabilities(): ComputerUseCapabilityDescriptor;
  isAvailable(): boolean;
  prepare?: (context: OpenClawPluginNodeHostCommandAvailabilityContext) => Promise<void> | void;
  watchAvailability?: OpenClawPluginNodeHostCommand["watchAvailability"];
  openExecution(context: {
    executionId: string;
    sessionKey?: string;
  }): Promise<ComputerUseExecution>;
};

// Structural registration surface built from leaf node-host types only: importing
// the full plugin API type here creates an import cycle through the gateway
// server-method types that consume this contract.
type ComputerUseRegistrationApi = {
  registerNodeHostCommand(command: OpenClawPluginNodeHostCommand): void;
};

/** Register the canonical node-host command pair for one node-local provider. */
export function registerComputerUseProvider(
  api: ComputerUseRegistrationApi,
  provider: ComputerUseProvider,
): void {
  type Caller = NonNullable<OpenClawPluginNodeHostCommandContext["computerExecutionV1"]>["caller"];
  type Execution = {
    id: string;
    generation: string;
    ownershipId: string;
    caller?: Caller;
    acquiredAt: number;
    lastCommandAt: number;
    promise: Promise<ComputerUseExecution>;
  };
  let execution: Execution | undefined;
  let closingPromise: Promise<void> | undefined;
  let pendingClose: Promise<void> | undefined;
  const hasActiveWork = () =>
    execution !== undefined || closingPromise !== undefined || pendingClose !== undefined;

  const executionEnvelopeFromParams = (
    paramsJSON: string | null | undefined,
    context?: OpenClawPluginNodeHostCommandContext,
  ) => {
    let value: unknown;
    try {
      value = JSON.parse(paramsJSON ?? "{}");
    } catch {
      throw new Error("COMPUTER_INVALID_REQUEST: params must be valid JSON");
    }
    context?.computerExecutionV1?.assertCurrent();
    const caller: Caller | undefined = context?.computerExecutionV1?.caller;
    if (
      caller?.cleanup &&
      (!isRecord(value) ||
        value.action !== "__close_execution" ||
        value.executionId !== caller.cleanup.executionId ||
        value.providerGeneration !== caller.cleanup.providerGeneration)
    ) {
      throw new Error("COMPUTER_OWNER_FORBIDDEN: cleanup authority permits only its exact close");
    }
    // Host-owned envelope metadata must never reach native provider argument parsers.
    const commandValue = isRecord(value)
      ? Object.fromEntries(
          Object.entries(value).filter(
            ([key]) => key !== "computerExecutionCaller" && key !== "providerGeneration",
          ),
        )
      : value;
    const executionId = isRecord(value) ? value.executionId : undefined;
    const providerGeneration = isRecord(value) ? value.providerGeneration : undefined;
    if (
      providerGeneration !== undefined &&
      (typeof providerGeneration !== "string" || !providerGeneration)
    ) {
      throw new Error("COMPUTER_INVALID_REQUEST: providerGeneration must be nonempty");
    }
    if (executionId === undefined) {
      return { executionId: undefined, value: commandValue, caller, providerGeneration };
    }
    if (
      typeof executionId !== "string" ||
      !new RegExp(COMPUTER_EXECUTION_ID_PATTERN, "u").test(executionId)
    ) {
      throw new Error("COMPUTER_INVALID_REQUEST: executionId is required");
    }
    return { executionId, value: commandValue, caller, providerGeneration };
  };
  const assertProviderGeneration = (expected: string | undefined) => {
    if (expected !== undefined && provider.capabilities().provider.generation !== expected) {
      throw new Error("COMPUTER_OWNER_CHANGED: provider changed before desktop operation");
    }
  };
  const ownsExecution = (current: Execution, caller?: Caller) => {
    if (current.caller?.instanceId) {
      return current.caller.instanceId === caller?.instanceId;
    }
    if (current.caller?.callerId) {
      return current.caller.callerId === caller?.callerId;
    }
    // Legacy internal carriers retain their execution-ID capability. A new
    // caller cannot adopt Unknown work merely by reading its execution ID.
    return current.caller === undefined && caller === undefined;
  };
  const getExecution = async (
    executionId: string,
    context?: OpenClawPluginNodeHostCommandContext,
    caller?: Caller,
  ) => {
    // An earlier queued close can replace the barrier while this acquisition resumes.
    for (let barrier = closingPromise; barrier !== undefined; barrier = closingPromise) {
      await barrier;
    }
    context?.computerExecutionV1?.assertCurrent();
    if (execution && execution.id !== executionId) {
      throw new Error("COMPUTER_HOST_BUSY: another provider execution owns this computer");
    }
    if (execution && !ownsExecution(execution, caller)) {
      throw new Error("COMPUTER_OWNER_FORBIDDEN: this execution belongs to another run");
    }
    if (!execution) {
      const generation = provider.capabilities().provider.generation;
      const opened = provider.openExecution(
        caller?.sessionKey || context?.sessionKey
          ? { executionId, sessionKey: caller?.sessionKey ?? context?.sessionKey }
          : { executionId },
      );
      // A failed open must not wedge the provider behind a cached rejection;
      // the next command call retries openExecution instead.
      opened.catch(() => {
        if (execution?.promise === opened) {
          execution = undefined;
        }
      });
      execution = {
        id: executionId,
        generation,
        ownershipId: randomUUID(),
        caller,
        acquiredAt: Date.now(),
        lastCommandAt: Date.now(),
        promise: opened,
      };
    }
    execution.lastCommandAt = Date.now();
    return execution.promise;
  };
  const finishAcquiredCommand = async (
    executionId: string,
    created: boolean,
    context: { signal?: AbortSignal; computerExecutionV1?: unknown } | undefined,
    run: () => Promise<string>,
  ) => {
    try {
      const payload = await run();
      const current = execution?.id === executionId ? execution : undefined;
      let stamped = payload;
      if (current) {
        try {
          const parsed = JSON.parse(payload) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            stamped = JSON.stringify({
              ...parsed,
              computerExecutionOwnership: {
                executionId,
                providerGeneration: current.generation,
                ownershipId: current.ownershipId,
              },
            });
          }
        } catch {
          // A non-JSON result keeps the separate ownership read.
        }
      }
      // Release this acquisition on the node when the caller is already cancelled.
      if (context?.signal?.aborted && current) {
        await closeExecution(executionId, "cancellation").catch(() => undefined);
      }
      return stamped;
    } catch (error) {
      if (created && execution?.id === executionId) {
        await closeExecution(
          executionId,
          context?.signal?.aborted ? "cancellation" : "command-failed",
        ).catch(() => undefined);
      }
      throw error;
    }
  };
  const closeCurrentExecution = (
    executionId: string | undefined,
    reason: string,
    guard?: () => void,
  ): Promise<void> => {
    const current = execution;
    if (!current || (executionId !== undefined && current.id !== executionId)) {
      return Promise.resolve();
    }
    if (pendingClose) {
      return pendingClose;
    }
    // A rejected pre-effect guard must not poison an otherwise usable execution.
    const previousBarrier = closingPromise;
    let physicalCloseStarted = false;
    // Watcher stop and disconnect must join the same physical close before either yields.
    const close = current.promise.then(async (opened) => {
      guard?.();
      physicalCloseStarted = true;
      await opened.close(reason);
    });
    pendingClose = close;
    closingPromise = close;
    void close.then(
      () => {
        if (execution === current) {
          execution = undefined;
        }
        pendingClose = undefined;
        closingPromise = undefined;
      },
      () => {
        pendingClose = undefined;
        // Failed open owns nothing; failed physical close stays owned for an explicit close.
        if (execution !== current) {
          closingPromise = undefined;
        } else if (!physicalCloseStarted) {
          closingPromise = previousBarrier;
        }
      },
    );
    return close;
  };
  const closeExecution = (
    executionId: string | undefined,
    reason: string,
    guard?: () => void,
  ): Promise<void> => {
    if (!pendingClose) {
      return closeCurrentExecution(executionId, reason, guard);
    }
    const joined = (async () => {
      // Earlier queued operations can publish another close after each barrier settles.
      for (let barrier = pendingClose; barrier !== undefined; barrier = pendingClose) {
        const matchesClosingOwner = executionId === undefined || execution?.id === executionId;
        try {
          await barrier;
        } catch (error) {
          if (matchesClosingOwner) {
            throw error;
          }
          return;
        }
      }
      await closeCurrentExecution(executionId, reason, guard);
    })();
    // Watcher cleanup may initiate an unawaited close; joiners still receive the actual failure.
    void joined.catch(() => {});
    return joined;
  };

  api.registerNodeHostCommand({
    command: "screen.snapshot",
    cap: "screen",
    dangerous: false,
    prepare: (context) => provider.prepare?.(context),
    isAvailable: () => provider.isAvailable(),
    hasActiveWork,
    watchAvailability: (context, onChange) => {
      const stopWatching = provider.watchAvailability?.(context, onChange);
      let availabilityStop: Promise<void> | undefined;
      return async () => {
        availabilityStop ??= Promise.resolve()
          .then(() => stopWatching?.())
          .catch((error: unknown) => {
            availabilityStop = undefined;
            throw error;
          });
        const results = await Promise.allSettled([
          availabilityStop,
          closeExecution(undefined, "node-host-stop"),
        ]);
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length === 1) {
          throw failures[0];
        }
        if (failures.length > 1) {
          throw new AggregateError(failures, "computer provider shutdown failed");
        }
      };
    },
    onDisconnect: async () => await closeExecution(undefined, "gateway-disconnect"),
    handle: async (paramsJSON, _io, context) => {
      const envelope = executionEnvelopeFromParams(paramsJSON, context);
      assertProviderGeneration(envelope.providerGeneration);
      if (envelope.executionId) {
        const created = execution?.id !== envelope.executionId;
        const opened = await getExecution(envelope.executionId, context, envelope.caller);
        return await finishAcquiredCommand(envelope.executionId, created, context, async () => {
          context?.signal?.throwIfAborted();
          context?.computerExecutionV1?.assertCurrent();
          assertProviderGeneration(envelope.providerGeneration);
          return await opened.snapshot(JSON.stringify(envelope.value), context?.signal);
        });
      }
      if (hasActiveWork()) {
        throw new Error("COMPUTER_HOST_BUSY: another provider execution owns this computer");
      }
      const executionId = randomUUID();
      const opened = await getExecution(executionId, context, envelope.caller);
      try {
        context?.signal?.throwIfAborted();
        context?.computerExecutionV1?.assertCurrent();
        assertProviderGeneration(envelope.providerGeneration);
        return await opened.snapshot(JSON.stringify(envelope.value), context?.signal);
      } finally {
        await closeExecution(executionId, "snapshot-complete");
      }
    },
  });
  api.registerNodeHostCommand({
    command: "computer.act",
    cap: "computer",
    dangerous: true,
    computerUse: () => provider.capabilities(),
    isAvailable: () => provider.isAvailable(),
    hasActiveWork,
    handle: async (paramsJSON, _io, context) => {
      const envelope = executionEnvelopeFromParams(paramsJSON, context);
      assertProviderGeneration(envelope.providerGeneration);
      if (!envelope.executionId) {
        throw new Error("COMPUTER_INVALID_REQUEST: executionId is required");
      }
      if (isRecord(envelope.value) && envelope.value.action === "__close_execution") {
        const reason = envelope.value.reason;
        const current = execution;
        const cleanup = envelope.caller?.cleanup;
        const assertCleanupAcquisition = () => {
          if (
            cleanup &&
            (!current ||
              execution !== current ||
              current.id !== cleanup.executionId ||
              current.generation !== cleanup.providerGeneration ||
              current.ownershipId !== cleanup.ownershipId ||
              provider.capabilities().provider.generation !== cleanup.providerGeneration)
          ) {
            throw new Error("COMPUTER_OWNER_CHANGED: cleanup acquisition changed");
          }
        };
        assertCleanupAcquisition();
        if (
          current?.id === envelope.executionId &&
          !cleanup &&
          !ownsExecution(current, envelope.caller)
        ) {
          throw new Error(
            "COMPUTER_OWNER_FORBIDDEN: use approved recovery for another run's execution",
          );
        }
        const expectedGeneration = envelope.providerGeneration;
        if (
          expectedGeneration !== undefined &&
          current?.id === envelope.executionId &&
          (current.generation !== expectedGeneration ||
            provider.capabilities().provider.generation !== expectedGeneration)
        ) {
          throw new Error("COMPUTER_OWNER_CHANGED: provider changed before cleanup");
        }
        const released = current?.id === envelope.executionId;
        const assertCurrentGeneration =
          expectedGeneration === undefined && !context?.computerExecutionV1
            ? undefined
            : () => {
                context?.computerExecutionV1?.assertCurrent();
                assertCleanupAcquisition();
                if (
                  expectedGeneration !== undefined &&
                  (execution !== current ||
                    current?.generation !== expectedGeneration ||
                    provider.capabilities().provider.generation !== expectedGeneration)
                ) {
                  throw new Error("COMPUTER_OWNER_CHANGED: provider changed before cleanup");
                }
              };
        await closeExecution(
          envelope.executionId,
          typeof reason === "string" && reason.trim() ? reason.slice(0, 64) : "completion",
          assertCurrentGeneration,
        );
        return JSON.stringify({
          ok: true,
          ...(expectedGeneration !== undefined ? { released } : {}),
        });
      }
      const created = execution?.id !== envelope.executionId;
      const opened = await getExecution(envelope.executionId, context, envelope.caller);
      return await finishAcquiredCommand(envelope.executionId, created, context, async () => {
        context?.signal?.throwIfAborted();
        context?.computerExecutionV1?.assertCurrent();
        assertProviderGeneration(envelope.providerGeneration);
        return await opened.act(JSON.stringify(envelope.value), context?.signal);
      });
    },
  });
  api.registerNodeHostCommand({
    command: "computer.execution",
    cap: "computer",
    dangerous: true,
    isAvailable: () => provider.isAvailable(),
    hasActiveWork,
    handle: async (paramsJSON, _io, context) => {
      const envelope = executionEnvelopeFromParams(paramsJSON, context);
      assertProviderGeneration(envelope.providerGeneration);
      if (!context?.computerExecutionV1) {
        throw new Error(
          "COMPUTER_OWNERSHIP_UNAVAILABLE: authenticated ownership requires an updated Gateway",
        );
      }
      const ownership = context.computerExecutionV1;
      if (isRecord(envelope.value) && envelope.value.action === "inspect") {
        const current = execution;
        const generation = provider.capabilities().provider.generation;
        if (!current) {
          return JSON.stringify({ state: "free", providerGeneration: generation });
        }
        const canRead =
          current.caller?.sessionKey !== undefined &&
          current.caller.sessionKey === envelope.caller?.sessionKey;
        return JSON.stringify({
          state: "owned",
          executionId: current.id,
          ownershipId: current.ownershipId,
          providerGeneration: current.generation,
          acquiredAt: current.acquiredAt,
          lastCommandAt: current.lastCommandAt,
          activity: "unknown",
          ...(canRead
            ? {
                owner: {
                  sessionKey: current.caller?.sessionKey,
                  runId: current.caller?.runId,
                  instanceId: current.caller?.instanceId,
                },
              }
            : {}),
        });
      }
      if (isRecord(envelope.value) && envelope.value.action === "recover") {
        if (!envelope.executionId) {
          throw new Error("COMPUTER_INVALID_REQUEST: executionId is required for recovery");
        }
        const expected = execution;
        const generation = envelope.providerGeneration;
        const ownershipId = envelope.value.ownershipId;
        if (typeof ownershipId !== "string" || !ownershipId) {
          throw new Error(
            "COMPUTER_INVALID_REQUEST: ownershipId from inspection is required for recovery",
          );
        }
        if (typeof generation !== "string" || !generation) {
          throw new Error("COMPUTER_INVALID_REQUEST: providerGeneration is required for recovery");
        }
        const assertExpectedOwner = () => {
          ownership.assertCurrent();
          context.signal?.throwIfAborted();
          if (
            !expected ||
            execution !== expected ||
            expected.id !== envelope.executionId ||
            expected.ownershipId !== ownershipId ||
            expected.generation !== generation ||
            provider.capabilities().provider.generation !== generation
          ) {
            throw new Error("COMPUTER_OWNER_CHANGED: inspect ownership again before recovery");
          }
          if (
            !envelope.caller?.recoveryOperator &&
            (!expected.caller?.sessionKey ||
              expected.caller.sessionKey !== envelope.caller?.sessionKey)
          ) {
            throw new Error(
              "COMPUTER_OWNER_FORBIDDEN: recovery requires the owning session or an operator",
            );
          }
        };
        assertExpectedOwner();
        // Do not join another close and claim its no-op as this request's release.
        if (pendingClose) {
          throw new Error("COMPUTER_CLOSE_PENDING: wait for cleanup, then inspect ownership again");
        }
        await closeCurrentExecution(
          envelope.executionId,
          "human-approved-recovery",
          assertExpectedOwner,
        );
        return JSON.stringify({
          ok: true,
          released: true,
          ownershipId,
          executionId: envelope.executionId,
          providerGeneration: generation,
        });
      }
      throw new Error("COMPUTER_INVALID_REQUEST: expected inspect or recover with exact ownership");
    },
  });
  // The provider plugin must also register its dangerous computer.act and computer.execution invoke
  // policy with the full plugin API. Forgetting it fails closed: the Gateway
  // rejects dangerous plugin commands that lack a registered policy.
}
