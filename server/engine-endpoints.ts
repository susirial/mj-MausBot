import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { EndpointInfo, EndpointRuntime } from "../shared/engine-endpoint.ts";
import { EFFORT_LEVELS } from "../shared/wire.ts";
import type { InstanceConfig, InstanceConfigMap, ModelCatalog } from "./contracts.ts";
import { CLAUDE_MODEL_ID } from "./drivers/claude-model-extras.ts";

export const ENDPOINT_API_KEY_ENV = "OPENMAUSBOT_ENDPOINT_API_KEY";
const cleanText = (max: number) => z.string().max(max)
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), "Control characters are not allowed")
  .transform((value) => value.trim()).pipe(z.string().min(1));
const displayNameSchema = cleanText(80);
const apiKeySchema = cleanText(4096);
const modelIdSchema = cleanText(160).pipe(z.string().regex(CLAUDE_MODEL_ID))
  .refine((id) => !id.includes("::"), "Endpoint models must not contain host-routing decorators");
const codexId = /^[a-z0-9][a-z0-9._:/-]*$/i;
const providerSchema = z.enum(["deepseek", "kimi", "custom"]);
const effortSchema = z.enum(EFFORT_LEVELS);
const baseUrlSchema = cleanText(2048).refine((value) => {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && Boolean(url.hostname) && !url.username && !url.password
      && !value.includes("?") && !value.includes("#");
  } catch { return false; }
}, "Use an HTTP(S) URL without user information, query, or fragment")
  .transform((value) => new URL(value).href.replace(/\/+$/, ""));
const modelSchema = z.object({
  id: modelIdSchema, label: cleanText(80), source: z.enum(["preset", "configured", "discovered"]),
  contextWindow: z.number().int().positive().safe().optional(),
  inputModalities: z.array(z.enum(["text", "image"])).min(1),
  effortLevels: z.array(effortSchema),
  nativeSearch: z.enum(["supported", "unsupported", "unknown"]),
}).strict().refine((model) => new Set(model.inputModalities).size === model.inputModalities.length
  && new Set(model.effortLevels).size === model.effortLevels.length, "Capabilities must be unique");
const catalogSchema = z.object({
  default: modelIdSchema, options: z.array(modelSchema).min(1),
}).strict();
const baseFields = {
  version: z.literal(1), revision: z.number().int().positive().safe(),
  provider: providerSchema, baseUrl: baseUrlSchema, catalog: catalogSchema,
  backgroundModel: modelIdSchema, defaultEffort: effortSchema.optional(),
};
const roleModelsSchema = z.object({
  opus: modelIdSchema, sonnet: modelIdSchema, haiku: modelIdSchema,
  fable: modelIdSchema, subagent: modelIdSchema,
}).strict();
const codexSchema = z.object({
  ...baseFields, runtime: z.literal("codex"), protocol: z.literal("responses"),
  webSearch: z.enum(["disabled", "live"]),
}).strict();
const claudeSchema = z.object({
  ...baseFields, runtime: z.literal("claude"), protocol: z.literal("anthropic"),
  roleModels: roleModelsSchema, autoCompactTokens: z.number().int().positive().safe().optional(),
}).strict();
export const endpointConnectionSchema = z.discriminatedUnion("runtime", [codexSchema, claudeSchema])
  .superRefine((endpoint, context) => {
    const issue = (message: string) => context.addIssue({ code: "custom", message });
    const models = new Map(endpoint.catalog.options.map((model) => [model.id, model]));
    if (models.size !== endpoint.catalog.options.length) issue("Model ids must be unique");
    const required = [endpoint.catalog.default, endpoint.backgroundModel,
      ...(endpoint.runtime === "claude" ? Object.values(endpoint.roleModels) : [])];
    if (required.some((id) => !models.has(id))) issue("All selected models must belong to the catalog");
    if (endpoint.defaultEffort && !models.get(endpoint.catalog.default)?.effortLevels.includes(endpoint.defaultEffort)) {
      issue("Default effort must be supported by the default model");
    }
    if (endpoint.runtime === "codex") {
      if (endpoint.catalog.options.some((model) => !codexId.test(model.id) || model.id.includes("::"))) {
        issue("Codex requires raw API model ids");
      }
      if (endpoint.webSearch === "live" && endpoint.catalog.options.some((model) => model.nativeSearch !== "supported")) {
        issue("Live search must be confirmed for every selectable model");
      }
    } else if (endpoint.autoCompactTokens !== undefined && endpoint.catalog.options.some((model) =>
      model.contextWindow === undefined || endpoint.autoCompactTokens !== undefined && endpoint.autoCompactTokens >= model.contextWindow)) {
      issue("Compaction must be below every selectable model's known context window");
    }
  });

export const endpointCreateSchema = z.object({
  operationId: z.uuid(), displayName: displayNameSchema, provider: providerSchema, apiKey: apiKeySchema,
  connections: z.array(endpointConnectionSchema).min(1).max(2),
}).strict().superRefine((request, context) => {
  if (new Set(request.connections.map((connection) => connection.runtime)).size !== request.connections.length) {
    context.addIssue({ code: "custom", message: "Only one connection per runtime may be created" });
  }
  if (request.connections.some((connection) => connection.provider !== request.provider || connection.revision !== 1)) {
    context.addIssue({ code: "custom", message: "New connections must match the provider and start at revision 1" });
  }
});
const endpointPatchSchema = z.union([
  codexSchema.omit({ runtime: true, revision: true }).partial(),
  claudeSchema.omit({ runtime: true, revision: true }).partial(),
]);
export const endpointUpdateSchema = z.object({
  expectedRevision: z.number().int().positive().safe(), displayName: displayNameSchema.optional(),
  cli: z.union([cleanText(2048), z.literal("")]).optional(),
  apiKey: apiKeySchema.optional(), endpointPatch: endpointPatchSchema.optional(),
}).strict().refine((request) => request.displayName !== undefined || request.cli !== undefined || request.apiKey !== undefined
  || request.endpointPatch !== undefined && Object.keys(request.endpointPatch).length > 0, "No settings supplied");
export type EndpointConnection = z.infer<typeof endpointConnectionSchema>;
export type EndpointCreateRequest = z.infer<typeof endpointCreateSchema>;
export type EndpointUpdateRequest = z.infer<typeof endpointUpdateSchema>;
export interface EndpointEntryOptions {
  dataDir: string;
  newInstanceId?: (runtime: EndpointRuntime) => string;
}
const configRecordSchema = z.record(z.string(), z.unknown());
function configRecord(raw: unknown): Record<string, unknown> {
  const parsed = configRecordSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}
export function endpointFromConfig(raw: unknown): EndpointConnection | null {
  const config = configRecord(raw);
  if (!Object.hasOwn(config, "endpoint")) return null;
  const result = endpointConnectionSchema.safeParse(config.endpoint);
  if (!result.success) fail(400, "Independent endpoint configuration is invalid");
  return result.data;
}
export function isEngineEndpoint(entry: InstanceConfig | undefined): boolean {
  return entry !== undefined && Object.hasOwn(configRecord(entry.config), "endpoint");
}
function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}
function entryEndpoint(entry: InstanceConfig): EndpointConnection {
  const endpoint = endpointFromConfig(entry.config);
  if (!endpoint) fail(400, "This instance is not a valid independent endpoint");
  if (entry.driver !== (endpoint.runtime === "codex" ? "codex" : "claudeAgent")) {
    fail(400, "Endpoint runtime must match its instance driver");
  }
  return endpoint;
}
function inheritedExecutable(configs: InstanceConfigMap, runtime: EndpointRuntime): string {
  const driver = runtime === "codex" ? "codex" : "claudeAgent";
  for (const entry of Object.values(configs)) {
    if (entry.driver !== driver || isEngineEndpoint(entry) || entry.access === "custom") continue;
    const config = configRecord(entry.config);
    if (Array.isArray(config.endpointModels) || config.managed !== undefined) continue;
    if (typeof config.cli === "string" && cleanText(2048).safeParse(config.cli).success) return config.cli;
  }
  return runtime;
}
export function createEndpointEntries(configs: InstanceConfigMap, request: EndpointCreateRequest,
  options: EndpointEntryOptions): { instanceIds: string[]; instances: InstanceConfigMap } {
  const existing = Object.entries(configs).filter(([, entry]) =>
    configRecord(entry.config).endpointCreationOperationId === request.operationId);
  if (existing.length) {
    const matches = existing.length === request.connections.length && request.connections.every((connection) =>
      existing.some(([, entry]) => {
        const endpoint = endpointFromConfig(entry.config);
        return endpoint && entry.driver === (connection.runtime === "codex" ? "codex" : "claudeAgent")
          && entry.displayName === request.displayName && isDeepStrictEqual(endpoint, connection)
          && entry.environment?.[ENDPOINT_API_KEY_ENV] === request.apiKey;
      }));
    if (!matches) fail(409, "Creation operation no longer matches the saved connection group");
    return { instanceIds: existing.map(([id]) => id), instances: configs };
  }
  const instances = { ...configs };
  const instanceIds: string[] = [];
  for (const connection of request.connections) {
    const instanceId = options.newInstanceId?.(connection.runtime) ?? `${connection.runtime}-endpoint-${randomUUID()}`;
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(instanceId) || Object.hasOwn(instances, instanceId)) {
      fail(409, "New endpoint instance id is invalid or already exists");
    }
    const home = join(resolve(options.dataDir), "providers", instanceId, connection.runtime);
    instances[instanceId] = {
      driver: connection.runtime === "codex" ? "codex" : "claudeAgent",
      displayName: request.displayName, access: "custom",
      environment: { [ENDPOINT_API_KEY_ENV]: request.apiKey },
      config: {
        cli: inheritedExecutable(configs, connection.runtime),
        ...(connection.runtime === "claude" ? { configDir: home } : {}),
        endpoint: structuredClone(connection), endpointCreationOperationId: request.operationId,
      },
    };
    instanceIds.push(instanceId);
  }
  return { instanceIds, instances };
}
export function updateEndpointEntry(configs: InstanceConfigMap, instanceId: string, request: EndpointUpdateRequest):
  { instances: InstanceConfigMap; runtimeChanged: boolean } {
  const entry = configs[instanceId];
  if (!entry) fail(404, "Unknown instance");
  const saved = entryEndpoint(entry);
  if (saved.revision !== request.expectedRevision) fail(409, "Endpoint revision has changed");
  const endpoint = endpointConnectionSchema.parse({ ...saved, ...request.endpointPatch });
  if (request.apiKey === undefined && (saved.baseUrl !== endpoint.baseUrl || saved.provider !== endpoint.provider)) {
    fail(400, "Enter a new key for the new endpoint address or provider");
  }
  const apiKey = request.apiKey ?? entry.environment?.[ENDPOINT_API_KEY_ENV];
  if (!apiKeySchema.safeParse(apiKey).success || apiKey === undefined) fail(400, "Endpoint key is not configured");
  const config = configRecord(entry.config);
  const oldCli = typeof config.cli === "string" && config.cli ? config.cli : saved.runtime;
  const nextCli = request.cli === undefined ? oldCli : request.cli || saved.runtime;
  const runtimeChanged = !isDeepStrictEqual(saved, endpoint) || apiKey !== entry.environment?.[ENDPOINT_API_KEY_ENV]
    || oldCli !== nextCli;
  if (runtimeChanged) endpoint.revision += 1;
  if (request.cli === "") delete config.cli;
  else if (request.cli !== undefined) config.cli = request.cli;
  return {
    runtimeChanged,
    instances: {
      ...configs,
      [instanceId]: {
        ...entry, ...(request.displayName !== undefined ? { displayName: request.displayName } : {}),
        environment: { ...entry.environment, [ENDPOINT_API_KEY_ENV]: apiKey },
        config: { ...config, endpoint },
      },
    },
  };
}
export function publicEndpointInfo(entry: InstanceConfig): EndpointInfo {
  return { ...entryEndpoint(entry), keyConfigured: apiKeySchema.safeParse(entry.environment?.[ENDPOINT_API_KEY_ENV]).success,
    check: { state: "unverified" } };
}
export function endpointModelCatalog(endpoint: EndpointConnection): ModelCatalog {
  return {
    default: endpoint.catalog.default,
    options: endpoint.catalog.options.map((model) => ({
      id: model.id, label: model.label, custom: true, provider: endpoint.provider,
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      variants: model.effortLevels.map((effort) => ({ id: effort, label: effort })),
    })),
  };
}
