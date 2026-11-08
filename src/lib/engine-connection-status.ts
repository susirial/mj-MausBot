import type { EndpointCheckKind, EndpointCheckResult } from "../../shared/engine-endpoint";
import type { InstanceInfo } from "@/state/store";
import type { LocaleKey } from "@/locales";
import type { EffortLevel } from "../../shared/wire";

export function endpointEffortLevels(instance: InstanceInfo, model: string): EffortLevel[] {
  const levels = instance.engineEndpoint?.catalog.options.find((option) => option.id === model)?.effortLevels ?? [];
  const cliLevels = instance.capabilities?.effortLevels ?? [];
  return levels.filter((level) => cliLevels.includes(level));
}

export function engineConnectionStatus(input: {
  cliAvailable: boolean;
  keyConfigured: boolean;
  modelConfigured: boolean;
  disabled?: boolean;
  policyDenied?: boolean;
  check: EndpointCheckResult;
}) {
  if (input.policyDenied) return { kind: "policy", canSelect: false, action: "repair" } as const;
  if (input.disabled) return { kind: "disabled", canSelect: false, action: "repair" } as const;
  if (!input.cliAvailable) return { kind: "cli", canSelect: false, action: "repair" } as const;
  if (!input.keyConfigured) return { kind: "key", canSelect: false, action: "repair" } as const;
  if (!input.modelConfigured) return { kind: "model", canSelect: false, action: "repair" } as const;
  const check = input.check;
  if (check.state === "failed") return {
    kind: check.reason, canSelect: check.reason !== "credentials" && check.reason !== "protocol" && check.reason !== "model",
    action: "repair",
  } as const;
  return { kind: check.state, canSelect: true, action: check.state === "passed" ? "none" : "check" } as const;
}

export function endpointCheckFor(instance: InstanceInfo, model: string, kind: EndpointCheckKind = "answer"): EndpointCheckResult {
  const endpoint = instance.engineEndpoint;
  let latest: EndpointCheckResult = { state: "unverified" };
  for (const check of [...endpoint?.checks ?? [], ...endpoint ? [endpoint.check] : []]) {
    if (check.state === "unverified" || check.model !== model || check.kind !== kind) continue;
    if (latest.state === "unverified" || check.state === "checking"
      || latest.state !== "checking" && check.checkedAt >= latest.checkedAt) latest = check;
  }
  return latest;
}

export function endpointModelStatus(instance: InstanceInfo, model: string, check = endpointCheckFor(instance, model)) {
  return engineConnectionStatus({
    cliAvailable: instance.snapshot.state === "available",
    keyConfigured: instance.engineEndpoint?.keyConfigured === true,
    modelConfigured: instance.engineEndpoint?.catalog.options.some((option) => option.id === model) === true,
    policyDenied: Boolean(instance.policy),
    check,
  });
}

export const ENDPOINT_STATUS_COPY: Record<ReturnType<typeof engineConnectionStatus>["kind"], LocaleKey> = {
  policy: "engineEndpoints.status.policy", disabled: "engineEndpoints.status.disabled",
  cli: "engineEndpoints.status.cli", key: "engineEndpoints.status.key", model: "engineEndpoints.status.model",
  credentials: "engineEndpoints.status.credentials", protocol: "engineEndpoints.status.protocol",
  timeout: "engineEndpoints.status.timeout", rate_limit: "engineEndpoints.status.rate_limit", other: "engineEndpoints.status.other",
  unverified: "engineEndpoints.status.unverified", checking: "engineEndpoints.status.checking", passed: "engineEndpoints.status.passed",
};

export function endpointServiceLabel(instance: InstanceInfo): string {
  const endpoint = instance.engineEndpoint;
  if (!endpoint) return instance.displayName;
  return `${endpoint.runtime === "codex" ? "Codex" : "Claude Code"} · ${
    endpoint.provider === "deepseek" ? "DeepSeek" : endpoint.provider === "kimi" ? "Kimi" : new URL(endpoint.baseUrl).host
  }`;
}
