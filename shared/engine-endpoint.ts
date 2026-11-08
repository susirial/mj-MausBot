import type { EffortLevel } from "./wire.ts";

export type EndpointProvider = "deepseek" | "kimi" | "custom";
export type EndpointRuntime = "codex" | "claude";
export type CatalogSource = "preset" | "configured" | "discovered";

/** The selectable model id and capabilities confirmed for this runtime and service. */
export interface EndpointModel {
  id: string;
  label: string;
  source: CatalogSource;
  contextWindow?: number;
  inputModalities: Array<"text" | "image">;
  effortLevels: EffortLevel[];
  nativeSearch: "supported" | "unsupported" | "unknown";
}

export interface EndpointCatalog {
  default: string;
  options: EndpointModel[];
}

export interface EndpointBase {
  version: 1;
  revision: number;
  provider: EndpointProvider;
  baseUrl: string;
  catalog: EndpointCatalog;
  backgroundModel: string;
}

/** Configuration only. Credentials live in each instance's private environment. */
export type EndpointConnection =
  | EndpointBase & {
    runtime: "codex";
    protocol: "responses";
    defaultEffort?: EffortLevel;
    webSearch: "disabled" | "live";
  }
  | EndpointBase & {
    runtime: "claude";
    protocol: "anthropic";
    defaultEffort?: EffortLevel;
    autoCompactTokens?: number;
    roleModels: { opus: string; sonnet: string; haiku: string; fable: string; subagent: string };
  };

export type EndpointCheckKind = "answer" | "tools" | "background";
export type EndpointCheckCode =
  | "mcp_startup_failed"
  | "tool_denied"
  | "tool_approval_failed"
  | "tool_unsupported"
  | "tool_not_called"
  | "tool_receipt_mismatch"
  | "tool_answer_missing";
export type EndpointCheckResult =
  | { state: "unverified" }
  | { state: "checking"; model: string; kind: EndpointCheckKind }
  | { state: "passed"; model: string; kind: EndpointCheckKind; checkedAt: number; reportedModel?: string; checkId?: string }
  | {
    state: "failed";
    model: string;
    kind: EndpointCheckKind;
    checkedAt: number;
    reason: "credentials" | "model" | "protocol" | "timeout" | "rate_limit" | "other";
    message: string;
    /** Check-local failure evidence. Missing evidence never proves a provider protocol defect. */
    code?: EndpointCheckCode;
    /** Opaque identifier to find this check's redacted server log. */
    checkId?: string;
  };

export type EndpointInfo = EndpointConnection & {
  keyConfigured: boolean;
  check: EndpointCheckResult;
  checks?: EndpointCheckResult[];
};
export interface InstanceEngineEndpointInfo {
  engineEndpoint?: EndpointInfo;
}
