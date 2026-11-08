import type { AppConfig } from "../config.ts";
import type { InstanceConfigMap } from "../contracts.ts";
import type { EndpointCommit, EndpointLoadResult } from "../endpoint-persistence.ts";
import {
  createEndpointEntries, endpointCreateSchema, endpointUpdateSchema, endpointFromConfig,
  isEngineEndpoint, updateEndpointEntry,
} from "../engine-endpoints.ts";
import { endpointPresets } from "../engine-endpoint-presets.ts";
import { HOSTED_PROVIDER_SETTINGS_ERROR } from "../hosted-models.ts";
import { z } from "zod";
import type { EndpointCheckKind, EndpointCheckResult } from "../../shared/engine-endpoint.ts";
import type { Store } from "../store.ts";
import type { BusyFlag } from "./config.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface EngineEndpointRouteDeps {
  cfg: AppConfig;
  dataDir: string;
  hostedModels: boolean;
  providerConfigBusy: BusyFlag;
  store: Pick<Store, "bots" | "tasks">;
  busy(instanceId: string): boolean;
  describeInstances(): Promise<unknown>;
  persist(instanceIds: string[], instances: InstanceConfigMap, runtimeChanged?: boolean): Promise<EndpointCommit>;
  loadState?(instanceId: string): EndpointLoadResult;
  check?(instanceId: string, model: string, kind: EndpointCheckKind): Promise<EndpointCheckResult>;
  readOnly?(instanceId: string): boolean;
}

const checkSchema = z.object({ model: z.string().min(1).max(160), kind: z.enum(["answer", "tools", "background"]) }).strict();

export function createEngineEndpointRoutes(deps: EngineEndpointRouteDeps): RouteHandler {
  const referencesRemovedModels = (instanceId: string, models: ReadonlySet<string>): number => {
    const used = (selection: { instanceId: string; model: string } | undefined) =>
      selection?.instanceId === instanceId && !models.has(selection.model) ? 1 : 0;
    return used(deps.cfg.defaultModelSelection) + used(deps.cfg.newBotDefaults?.profile.modelSelection) + deps.store.bots.reduce((sum, bot) =>
      sum + used(bot.modelSelection) + (bot.fallback ?? []).reduce((count, candidate) => count + used(candidate), 0)
      + deps.store.tasks(bot.id).reduce((count, task) => count + used(task.modelSelection), 0), 0);
  };
  return async ({ req, res, path, method, json, readBody }) => {
    if (method === "GET" && path === "/api/engine-endpoint-presets") return json(res, 200, { presets: endpointPresets });
    const create = method === "POST" && path === "/api/instances/engine-endpoints";
    const match = /^\/api\/instances\/([\w.-]+)\/engine-endpoint$/.exec(path);
    const checkMatch = method === "POST" ? /^\/api\/instances\/([\w.-]+)\/engine-endpoint\/check$/.exec(path) : null;
    const update = method === "PATCH" && match !== null;
    if (!create && !update && !checkMatch) return PASS;
    if (deps.hostedModels) return json(res, 403, { error: HOSTED_PROVIDER_SETTINGS_ERROR });
    const selectedId = match?.[1] ?? checkMatch?.[1];
    if (selectedId && (selectedId.startsWith("company.") || deps.readOnly?.(selectedId))) return json(res, 403, { error: "This connection is managed by your organization." });
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      return json(res, 415, { error: "content-type must be application/json" });
    }
    const body: unknown = await readBody(req, 64 * 1024);
    if (deps.providerConfigBusy.get()) return json(res, 409, { error: "Provider settings are already being updated." });
    if (checkMatch) {
      const instanceId = checkMatch[1];
      const entry = deps.cfg.instances?.[instanceId];
      if (!entry || !isEngineEndpoint(entry)) return json(res, 404, { error: "Unknown independent connection." });
      const parsed = checkSchema.safeParse(body);
      const endpoint = endpointFromConfig(entry.config);
      if (!parsed.success || !endpoint?.catalog.options.some(model => model.id === parsed.data.model)) return json(res, 400, { error: "Choose a model in this connection's catalog." });
      if (deps.busy(instanceId)) return json(res, 409, { error: "This connection is busy. Check it after its tasks finish." });
      if (!deps.check) return json(res, 503, { error: "Connection checks are unavailable." });
      return json(res, 200, { check: await deps.check(instanceId, parsed.data.model, parsed.data.kind) });
    }
    deps.providerConfigBusy.set(true);
    try {
      const configs = structuredClone(deps.cfg.instances ?? {});
      if (create) {
        const parsed = endpointCreateSchema.safeParse(body);
        if (!parsed.success) return json(res, 400, { error: "Check the connection name, key, addresses and model settings." });
        const result = createEndpointEntries(configs, parsed.data, { dataDir: deps.dataDir });
        const existing = result.instanceIds.every(id => Object.hasOwn(configs, id));
        const committed: EndpointCommit = existing
          ? { committed: true, instanceIds: result.instanceIds, loadResults: result.instanceIds.map(instanceId =>
            deps.loadState?.(instanceId) ?? { instanceId, state: "loaded" }) }
          : await deps.persist(result.instanceIds, result.instances);
        return json(res, 201, { ...committed, instances: await deps.describeInstances() });
      }
      if (!match) return PASS;
      const instanceId = match[1];
      if (!configs[instanceId]) return json(res, 404, { error: "Unknown connection." });
      if (!isEngineEndpoint(configs[instanceId])) return json(res, 400, { error: "This instance does not use an independent API connection." });
      const parsed = endpointUpdateSchema.safeParse(body);
      if (!parsed.success) return json(res, 400, { error: "Check the connection revision and model settings." });
      const result = updateEndpointEntry(configs, instanceId, parsed.data);
      if (result.runtimeChanged && deps.busy(instanceId)) return json(res, 409, { error: "Wait for tasks using this connection to finish before changing its settings." });
      const endpoint = endpointFromConfig(result.instances[instanceId].config);
      if (!endpoint) return json(res, 400, { error: "Invalid connection." });
      const references = referencesRemovedModels(instanceId, new Set(endpoint.catalog.options.map(model => model.id)));
      if (references) return json(res, 409, { error: "Move saved model selections before removing these models.", references });
      const committed = await deps.persist([instanceId], result.instances, result.runtimeChanged);
      return json(res, 200, { ...committed, instances: await deps.describeInstances() });
    } catch (error) {
      const status = error !== null && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 400;
      return json(res, status, { error: error instanceof Error ? error.message : "Connection settings could not be saved." });
    } finally { deps.providerConfigBusy.set(false); }
  };
}
