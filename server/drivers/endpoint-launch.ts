import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { EffortLevel } from "../../shared/wire.ts";
import { writeFileAtomicIfChanged } from "../atomic.ts";
import { CONTROL_PLANE_ENV, CONTROL_PLANE_ENV_PREFIX, PROVIDER_CREDENTIAL_ENV,
  stripWorkspaceCredentialEnv, WORKSPACE_CREDENTIAL_ENV } from "../credential-env.ts";
import { ENDPOINT_API_KEY_ENV, endpointConnectionSchema, type EndpointConnection } from "../engine-endpoints.ts";
import { buildCodexEndpointCatalog } from "./codex-endpoint-catalog.ts";

export const ENDPOINT_INSTANCE_ID_ENV = "OPENMAUSBOT_ENDPOINT_INSTANCE_ID";
const PROTECTED_NAMES = new Set([
  ...WORKSPACE_CREDENTIAL_ENV, ...PROVIDER_CREDENTIAL_ENV, ...CONTROL_PLANE_ENV,
  ENDPOINT_API_KEY_ENV, ENDPOINT_INSTANCE_ID_ENV, "CODEX_HOME", "CLAUDE_CONFIG_DIR",
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_ORGANIZATION", "OPENAI_PROJECT_ID", "CODEX_API_KEY",
  "OPENMAUSBOT_CHATGPT_TOKEN", "CODEX_AUTH_TOKEN", "CODEX_BASE_URL", "CODEX_MODEL", "CODEX_MODEL_PROVIDER",
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION",
  "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_EFFORT_LEVEL", "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW_OVERRIDE", "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_DISABLE_AUTO_COMPACT",
  "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR", "ANTHROPIC_API_KEY_FILE_DESCRIPTOR",
  "ANTHROPIC_AUTH_TOKEN_FILE_DESCRIPTOR",
  "AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_WEB_IDENTITY_TOKEN_FILE",
  "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_OAUTH_ACCESS_TOKEN", "GOOGLE_CLOUD_ACCESS_TOKEN",
  "AZURE_API_KEY", "AZURE_AI_API_KEY", "AZURE_OPENAI_API_KEY", "AZURE_CLIENT_SECRET", "AZURE_FEDERATED_TOKEN_FILE",
]);

/** Also used when filtering project settings before merging an endpoint launch. */
export function isEndpointProtectedEnvName(name: string): boolean {
  const normalized = name.toUpperCase();
  return PROTECTED_NAMES.has(normalized) || normalized.startsWith(CONTROL_PLANE_ENV_PREFIX)
    || /^ANTHROPIC_(?:DEFAULT_.*_MODEL|CUSTOM_MODEL_OPTION(?:_.*)?|.*(?:BEDROCK|VERTEX|FOUNDRY).*)$/.test(normalized)
    || /^CLAUDE_CODE_(?:USE_(?:BEDROCK|VERTEX|FOUNDRY)|.*(?:OAUTH|BEDROCK|VERTEX|FOUNDRY).*)$/.test(normalized);
}

export interface EndpointLaunchInput {
  dataDir: string;
  instanceId: string;
  audienceKey?: string;
  endpoint: EndpointConnection;
  apiKey: string;
  cliVersion?: string;
  supportedEffortLevels?: readonly EffortLevel[];
  model: string;
  purpose: "turn" | "background" | "check";
  effort?: EffortLevel;
}
export type EndpointLaunch =
  | { runtime: "codex"; env: Record<string, string>; providerArgs: string[]; model: string; modelProvider: string;
    modelCatalog: ReturnType<typeof buildCodexEndpointCatalog>; effort?: EffortLevel }
  | { runtime: "claude"; env: Record<string, string>; settings: { model: string; env: Record<string, string> };
    model: string; effort?: EffortLevel; autoCompactTokens?: number };

function endpointHome(input: EndpointLaunchInput): string {
  const segment = /^[a-z0-9][a-z0-9_-]*$/i;
  if (!segment.test(input.instanceId) || input.audienceKey !== undefined && !segment.test(input.audienceKey)) {
    throw new Error("Endpoint instance and audience ids must be safe directory names");
  }
  return input.audienceKey === undefined
    ? join(resolve(input.dataDir), "providers", input.instanceId, input.endpoint.runtime)
    : join(resolve(input.dataDir), "engine-homes", input.audienceKey, "providers", input.instanceId, input.endpoint.runtime);
}

export function compileEndpointLaunch(input: EndpointLaunchInput): EndpointLaunch {
  const endpoint = endpointConnectionSchema.parse(input.endpoint);
  if (!input.apiKey.trim() || input.apiKey.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(input.apiKey)) {
    throw new Error("A valid private endpoint key is required");
  }
  const model = input.purpose === "background" ? endpoint.backgroundModel : input.model;
  const selected = endpoint.catalog.options.find((option) => option.id === model);
  if (!selected) throw new Error("Selected model is not configured on this endpoint");
  const efforts = selected.effortLevels.filter((effort) => input.supportedEffortLevels?.includes(effort));
  if (input.effort !== undefined && !efforts.includes(input.effort)) {
    throw new Error("Requested effort is not supported by this model and CLI");
  }
  const effort = input.effort ?? (endpoint.defaultEffort && efforts.includes(endpoint.defaultEffort) ? endpoint.defaultEffort : undefined);
  if (endpoint.runtime === "codex" && endpoint.webSearch === "live" && selected.nativeSearch !== "supported") {
    throw new Error("Native search is not confirmed for this model");
  }
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !isEndpointProtectedEnvName(name)) env[name] = value;
  }
  stripWorkspaceCredentialEnv(env);
  env[ENDPOINT_INSTANCE_ID_ENV] = input.instanceId;
  const home = endpointHome(input);
  if (endpoint.runtime === "codex") {
    env.CODEX_HOME = home;
    env[ENDPOINT_API_KEY_ENV] = input.apiKey;
    const overrides: Record<string, string | number | boolean> = {
      model, model_provider: "omb_endpoint", model_catalog_json: join(home, "models.json"),
      web_search: endpoint.webSearch,
      "model_providers.omb_endpoint.name": endpoint.provider,
      "model_providers.omb_endpoint.base_url": endpoint.baseUrl,
      "model_providers.omb_endpoint.env_key": ENDPOINT_API_KEY_ENV,
      "model_providers.omb_endpoint.wire_api": "responses",
      "model_providers.omb_endpoint.requires_openai_auth": false,
      "model_providers.omb_endpoint.supports_websockets": false,
      cli_auth_credentials_store: "ephemeral",
      ...(selected.contextWindow !== undefined ? { model_context_window: selected.contextWindow } : {}),
    };
    return { runtime: "codex", env, model, modelProvider: "omb_endpoint",
      providerArgs: Object.entries(overrides).flatMap(([name, value]) => ["-c", `${name}=${JSON.stringify(value)}`]),
      modelCatalog: buildCodexEndpointCatalog(endpoint, input), ...(effort !== undefined ? { effort } : {}) };
  }
  const settingsEnv: Record<string, string> = {
    ANTHROPIC_BASE_URL: endpoint.baseUrl, ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: endpoint.roleModels.opus,
    ANTHROPIC_DEFAULT_SONNET_MODEL: endpoint.roleModels.sonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: endpoint.roleModels.haiku,
    ANTHROPIC_DEFAULT_FABLE_MODEL: endpoint.roleModels.fable,
    CLAUDE_CODE_SUBAGENT_MODEL: endpoint.roleModels.subagent,
    ...(effort !== undefined ? { CLAUDE_CODE_EFFORT_LEVEL: effort } : {}),
    ...(endpoint.autoCompactTokens !== undefined ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(endpoint.autoCompactTokens) } : {}),
  };
  Object.assign(env, settingsEnv, { CLAUDE_CONFIG_DIR: home, ANTHROPIC_AUTH_TOKEN: input.apiKey });
  return { runtime: "claude", env, settings: { model, env: settingsEnv }, model,
    ...(effort !== undefined ? { effort } : {}),
    ...(endpoint.autoCompactTokens !== undefined ? { autoCompactTokens: endpoint.autoCompactTokens } : {}) };
}

export async function prepareEndpointFiles(input: EndpointLaunchInput): Promise<void> {
  const launch = compileEndpointLaunch({ ...input, model: input.endpoint.catalog.default, purpose: "turn", effort: undefined });
  const home = endpointHome(input);
  await mkdir(home, { recursive: true, mode: 0o700 });
  if (launch.runtime === "codex") {
    const lines = launch.providerArgs.filter((value) => value !== "-c").map((value) => {
      const index = value.indexOf("=");
      return `${value.slice(0, index)} = ${value.slice(index + 1)}`;
    });
    writeFileAtomicIfChanged(join(home, "config.toml"), `${lines.join("\n")}\n`, { mode: 0o600 });
    writeFileAtomicIfChanged(join(home, "models.json"), `${JSON.stringify(launch.modelCatalog, null, 2)}\n`, { mode: 0o600 });
  } else {
    const settings = { model: launch.settings.model, env: { ...launch.settings.env } };
    delete settings.env.CLAUDE_CODE_EFFORT_LEVEL;
    writeFileAtomicIfChanged(join(home, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  }
}
