import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { json, readBody } from "../harness/http.ts";
import type { AppConfig } from "../config.ts";
import { createEngineEndpointRoutes } from "./engine-endpoints.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
const commitSchema = z.object({ committed: z.literal(true), instanceIds: z.array(z.string()) });
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });

const connection = {
  version: 1, revision: 1, runtime: "codex", protocol: "responses", provider: "kimi",
  baseUrl: "https://api.moonshot.cn/v1", backgroundModel: "kimi-k3.1-pro", webSearch: "disabled",
  catalog: { default: "kimi-k3.1-pro", options: [{
    id: "kimi-k3.1-pro", label: "Kimi Pro", source: "configured",
    inputModalities: ["text"], effortLevels: [], nativeSearch: "unknown",
  }] },
};

async function fixture(options: { hosted?: boolean; busy?: boolean } = {}) {
  const cfg: AppConfig = { instances: { codex: { driver: "codex" }, claude: { driver: "claudeAgent" } } };
  let saving = false, saves = 0;
  const route = createEngineEndpointRoutes({
    cfg, dataDir: "/tmp/omb-route-fixture", hostedModels: options.hosted ?? false,
    store: { bots: [], tasks: () => [] },
    providerConfigBusy: { get: () => saving, set: value => { saving = value; } },
    busy: () => options.busy ?? false,
    describeInstances: async () => Object.entries(cfg.instances ?? {}).map(([instanceId]) => ({ instanceId })),
    persist: async (instanceIds, instances) => {
      cfg.instances = instances; saves++;
      return { committed: true, instanceIds, loadResults: instanceIds.map(instanceId => ({ instanceId, state: "loaded" })) };
    },
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!await dispatchRoutes([route], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: { kind: "loopback", scopes: ["admin"] }, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture missing address");
  const call = (path: string, body: unknown, method = "POST") => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method, headers: { "content-type": "application/json" },
    ...(method === "GET" || method === "HEAD" ? {} : { body: JSON.stringify(body) }),
  });
  return { cfg, call, saves: () => saves };
}

it("creates independent entries once and recovers an identical retried operation", async () => {
  const f = await fixture();
  const original = structuredClone(f.cfg.instances);
  const body = { operationId: randomUUID(), displayName: "Kimi", provider: "kimi", apiKey: "fixture-private-key", connections: [connection] };
  const created = await f.call("/api/instances/engine-endpoints", body);
  expect(created.status).toBe(201);
  const result = commitSchema.parse(await created.json());
  expect(result.committed).toBe(true);
  expect(result.instanceIds).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain(body.apiKey);
  expect(f.cfg.instances?.codex).toEqual(original?.codex);
  expect(f.cfg.instances?.claude).toEqual(original?.claude);
  const retry = await f.call("/api/instances/engine-endpoints", body);
  expect(retry.status).toBe(201);
  expect(commitSchema.parse(await retry.json()).instanceIds).toEqual(result.instanceIds);
  expect(f.saves()).toBe(1);
});

it("rejects endpoint creation on hosted workspaces", async () => {
  const f = await fixture({ hosted: true });
  expect((await f.call("/api/instances/engine-endpoints", {})).status).toBe(403);
  expect(f.saves()).toBe(0);
});

it("rejects stale revisions and preserves key on an update that omits it", async () => {
  const f = await fixture();
  const created = await f.call("/api/instances/engine-endpoints", {
    operationId: randomUUID(), displayName: "Kimi", provider: "kimi", apiKey: "fixture-private-key", connections: [connection],
  });
  expect(created.status).toBe(201);
  const id = commitSchema.parse(await created.json()).instanceIds[0];
  const path = `/api/instances/${id}/engine-endpoint`;
  const updated = await f.call(path, { expectedRevision: 1, endpointPatch: { backgroundModel: "kimi-k3.1-pro" }, displayName: "New name" }, "PATCH");
  expect(updated.status).toBe(200);
  expect(f.cfg.instances?.[id]?.environment?.OPENMAUSBOT_ENDPOINT_API_KEY).toBe("fixture-private-key");
  expect((await f.call(path, { expectedRevision: 99, displayName: "Stale" }, "PATCH")).status).toBe(409);
});
