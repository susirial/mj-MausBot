import { expect, it } from "vitest";
import { engineConnectionStatus, endpointCheckFor, endpointEffortLevels } from "./engine-connection-status";
import type { InstanceInfo } from "@/state/store";

const configured = { cliAvailable: true, keyConfigured: true, modelConfigured: true, check: { state: "unverified" } as const };

it("allows explicit selection before verification without needing account authentication", () => {
  expect(engineConnectionStatus(configured)).toEqual({ kind: "unverified", canSelect: true, action: "check" });
});

it.each([
  [{ cliAvailable: false }, "cli"], [{ keyConfigured: false }, "key"], [{ modelConfigured: false }, "model"],
  [{ disabled: true }, "disabled"], [{ policyDenied: true }, "policy"],
] as const)("rejects incomplete or denied selections", (patch, kind) => {
  expect(engineConnectionStatus({ ...configured, ...patch })).toEqual({ kind, canSelect: false, action: "repair" });
});

it.each(["credentials", "protocol"] as const)("offers repair instead of official login for %s", (reason) => {
  expect(engineConnectionStatus({ ...configured, check: { state: "failed", model: "A", kind: "answer", checkedAt: 1, reason, message: "Rejected" } }))
    .toEqual({ kind: reason, canSelect: false, action: "repair" });
});

it("does not turn a transient limit into a connection-wide selection ban", () => {
  expect(engineConnectionStatus({ ...configured, check: { state: "failed", model: "A", kind: "answer", checkedAt: 1, reason: "rate_limit", message: "Quota" } }))
    .toMatchObject({ kind: "rate_limit", canSelect: true });
});

it("keeps answer, tools, background and different models separate", () => {
  const instance: InstanceInfo = {
    instanceId: "fixture", displayName: "Fixture", driverKind: "codex", snapshot: { state: "available" }, models: { default: "A", options: [] },
    engineEndpoint: {
      version: 1, revision: 1, runtime: "codex", protocol: "responses", provider: "custom", baseUrl: "https://fixture.test",
      catalog: { default: "A", options: [] }, backgroundModel: "B", webSearch: "disabled", keyConfigured: true,
      check: { state: "passed", model: "A", kind: "answer", checkedAt: 1 },
      checks: [{ state: "failed", model: "B", kind: "background", checkedAt: 2, reason: "model", message: "B missing" }],
    },
  };
  expect(endpointCheckFor(instance, "A", "answer").state).toBe("passed");
  expect(endpointCheckFor(instance, "B", "answer").state).toBe("unverified");
  expect(endpointCheckFor(instance, "A", "tools").state).toBe("unverified");
  expect(endpointCheckFor(instance, "B", "background").state).toBe("failed");
  instance.capabilities = { effortLevels: ["high", "max"] };
  expect(endpointEffortLevels(instance, "A")).toEqual([]);
  if (instance.engineEndpoint) instance.engineEndpoint.catalog.options = [{
    id: "A", label: "A", source: "configured", inputModalities: ["text"], nativeSearch: "unknown", effortLevels: ["low", "high"],
  }];
  expect(endpointEffortLevels(instance, "A")).toEqual(["high"]);
  expect(endpointEffortLevels(instance, "missing")).toEqual([]);
  instance.capabilities = undefined;
  expect(endpointEffortLevels(instance, "A")).toEqual([]);
});
