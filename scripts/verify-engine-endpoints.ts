#!/usr/bin/env -S node --experimental-strip-types
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { startFakeEngineEndpoint, type FixtureFailure } from "../server/testing/fake-engine-endpoint.ts";
import { waitForExit } from "../server/testing/cleanup.ts";
import type { VerificationServer } from "./control-omb.ts";

export const endpointScenarios = [
  "official-regression", "codex-deepseek", "codex-kimi", "claude-deepseek", "claude-kimi",
  "background-route", "tool-roundtrip", "parallel-isolation", "failure-states", "metadata-restart",
] as const;
const scenarioSchema = z.enum(endpointScenarios);
const runtimeSchema = z.enum(["codex", "claude"]);
const instanceSchema = z.object({
  instanceId: z.string(), models: z.object({ default: z.string(), options: z.array(z.object({ id: z.string() }).passthrough()) }),
  engineEndpoint: z.unknown().optional(),
}).passthrough();
const instancesSchema = z.object({ instances: z.array(instanceSchema) });
const botSchema = z.object({ id: z.string(), threadId: z.string() }).passthrough();
const savedSchema = z.object({ instances: z.record(z.string(), z.unknown()), defaultModelSelection: z.unknown().optional() }).passthrough();
type Connection = { name: string; instanceId: string; runtime: z.infer<typeof runtimeSchema>; model: string; background: string; revision: number };
type HttpReceipt = { method: string; path: string; status: number; request?: unknown; response: unknown };

export async function verifyEngineEndpoints(options: { scenario: z.infer<typeof scenarioSchema>; evidenceDir: string; repoRoot?: string }) {
  const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const repoRoot = resolve(options.repoRoot ?? ownRoot);
  const control: typeof import("./control-omb.ts") = await import(pathToFileURL(join(repoRoot, "scripts/control-omb.ts")).href);
  const evidenceDir = resolve(options.evidenceDir);
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const service = await startFakeEngineEndpoint();
  const keys: string[] = [];
  const receipts: HttpReceipt[] = [];
  const assertions: string[] = [];
  const connections: Connection[] = [];
  const chats = new Map<string, z.infer<typeof botSchema>>();
  const chatSessions = new Map<string, string>();
  let fixture: VerificationServer | undefined;
  let restarted: ChildProcess | undefined;
  const report: { scenario: string; repoRoot: string; fixture?: VerificationServer["info"]; ok: boolean; assertions: string[]; error?: string } = {
    scenario: options.scenario, repoRoot, ok: false, assertions,
  };
  const redact = (text: string) => keys.reduce((value, key) => value.replaceAll(key, "[REDACTED]"), text);
  const save = () => {
    writeFileSync(join(evidenceDir, "result.json"), redact(JSON.stringify(report, null, 2)));
    writeFileSync(join(evidenceDir, "http.json"), redact(JSON.stringify(receipts, null, 2)));
    writeFileSync(join(evidenceDir, "endpoint-requests.json"), redact(JSON.stringify(service.requests, null, 2)));
  };
  const prove = (condition: unknown, label: string) => { assert(condition, label); assertions.push(label); save(); };
  const api = async (method: string, path: string, request?: unknown, expected = 200): Promise<unknown> => {
    if (!fixture) throw new Error("Fixture not launched");
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { origin: fixture.info.url, "content-type": "application/json" },
      ...(request !== undefined ? { body: JSON.stringify(request) } : {}), signal: AbortSignal.timeout(110_000),
    });
    const text = await response.text();
    for (const key of keys) assert(!text.includes(key), `Public response leaked a synthetic key at ${path}`);
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = text; }
    receipts.push({ method, path, status: response.status, ...(request !== undefined ? { request } : {}), response: body });
    save();
    assert.equal(response.status, expected, `${method} ${path} returned ${response.status}: ${redact(text).slice(0, 700)}`);
    return body;
  };
  const config = () => {
    if (!fixture) throw new Error("Fixture not launched");
    return savedSchema.parse(JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8")));
  };
  const cli = (runtime: Connection["runtime"]) => {
    if (!fixture) throw new Error("Fixture not launched");
    const path = join(fixture.info.dataDir, `endpoint-${runtime}.mjs`);
    writeFileSync(path, [
      "#!/usr/bin/env node",
      `process.env.${runtime === "claude" ? "FAKE_CLAUDE_ENDPOINT" : "FAKE_CODEX_ENDPOINT"} = "1";`,
      `process.env.${runtime === "claude" ? "FAKE_CLAUDE_VERSION" : "FAKE_CODEX_VERSION"} = ${JSON.stringify(runtime === "claude" ? "2.1.296" : "codex-cli 0.167.0")};`,
      `await import(${JSON.stringify(pathToFileURL(join(ownRoot, "server/testing", runtime === "claude" ? "fake-claude-cli.ts" : "fake-codex-app-server.ts")).href)});`,
    ].join("\n"), { mode: 0o700 });
    return path;
  };
  const makeEndpoint = (runtime: Connection["runtime"], provider: "deepseek" | "kimi", baseUrl: string) => {
    const model = provider === "deepseek" ? runtime === "claude" ? "deepseek-flash[1m]" : "deepseek-flash" : "kimi-k3.1-pro";
    const background = provider === "deepseek" ? "deepseek-flash" : "kimi-k3.1-pro-background";
    return {
      version: 1, revision: 1, runtime, protocol: runtime === "codex" ? "responses" : "anthropic",
      provider, baseUrl, catalog: { default: model, options: [...new Set([model, background])].map(id => ({
        id, label: id, source: "configured", contextWindow: 1_048_576,
        inputModalities: ["text"], effortLevels: [], nativeSearch: "unsupported",
      })) }, backgroundModel: background,
      ...(runtime === "codex" ? { webSearch: "disabled" } : {
        roleModels: { opus: model, sonnet: model, haiku: background, fable: model, subagent: background },
        autoCompactTokens: 500_000,
      }),
    };
  };
  const create = async (provider: "deepseek" | "kimi", runtimes: Connection["runtime"][]) => {
    const key = `fixture-only-${randomUUID()}`; keys.push(key);
    const requested = runtimes.map(runtime => {
      const name = `${runtime}-${provider}-${connections.length}`;
      return { name, endpoint: makeEndpoint(runtime, provider, service.register(name, runtime, key)) };
    });
    const request = { operationId: randomUUID(), displayName: `Fixture ${provider}`, provider, apiKey: key, connections: requested.map(item => item.endpoint) };
    const before = service.requests.length;
    const parsed = z.object({ committed: z.literal(true), instanceIds: z.array(z.string()).length(runtimes.length) }).parse(
      await api("POST", "/api/instances/engine-endpoints", request, 201));
    const retried = z.object({ instanceIds: z.array(z.string()) }).parse(await api("POST", "/api/instances/engine-endpoints", request, 201));
    prove(isDeepStrictEqual(parsed.instanceIds, retried.instanceIds), "operationId retry returns the committed instance group");
    prove(service.requests.length === before, "saving and retrying do not send implicit endpoint checks");
    for (const [index, item] of requested.entries()) {
      const instanceId = z.string().parse(parsed.instanceIds[index]);
      await api("PATCH", `/api/instances/${instanceId}/engine-endpoint`, { expectedRevision: 1, cli: cli(item.endpoint.runtime) });
      const connection: Connection = { name: item.name, instanceId, runtime: item.endpoint.runtime,
        model: item.endpoint.catalog.default, background: item.endpoint.backgroundModel, revision: 2 };
      connections.push(connection);
    }
  };
  const check = async (connection: Connection, kind: "answer" | "tools" | "background", reason?: string) => {
    const before = service.requests.length;
    const body = z.object({ check: z.object({ state: z.string(), reason: z.string().optional() }).passthrough() }).parse(
      await api("POST", `/api/instances/${connection.instanceId}/engine-endpoint/check`, {
        model: kind === "background" ? connection.background : connection.model, kind,
      }));
    prove(body.check.state === (reason ? "failed" : "passed"), `${connection.name} ${kind} check ${reason ? "fails" : "passes"}`);
    if (reason) prove(body.check.reason === reason, `${connection.name} reports ${reason}`);
    const requests = service.requests.slice(before).filter(receipt => receipt.connection === connection.name);
    prove(requests.length > 0, `${connection.name} ${kind} reaches the HTTP service`);
    prove(requests.every(receipt => receipt.authorized && receipt.model === (kind === "background" ? connection.background : connection.model)),
      `${connection.name} ${kind} uses its own key and selected model`);
    if (kind === "tools" && !reason) prove(requests.some(receipt => /tool_result|function_call_output/.test(JSON.stringify(receipt.body))),
      `${connection.name} submits an actual echo tool result before the final answer`);
  };
  const chat = async (instanceId: string, model: string, name: string, reuse = false) => {
    const bot = (reuse ? chats.get(instanceId) : undefined) ?? z.object({ bot: botSchema }).parse(await api("POST", "/api/bots", {
      name: `Endpoint verifier ${randomUUID().slice(0, 8)}`, description: "Synthetic endpoint verifier", modelSelection: { instanceId, model },
    }, 201)).bot;
    if (!fixture) throw new Error("Fixture not launched");
    const url = fixture.info.url;
    const sent: unknown = await control.runControlOmb(["send", "--bot", bot.id, "--text", "Reply with a short synthetic answer.", "--url", url]);
    const wait: unknown = await control.runControlOmb(["wait", "--bot", bot.id, "--timeout", "30", "--url", url]);
    const messages: unknown = await control.runControlOmb(["messages", "--bot", bot.id, "--limit", "20", "--url", url]);
    receipts.push({ method: "control", path: `chat/${bot.id}`, status: 200, request: sent, response: { wait, messages } });
    prove(z.object({ status: z.literal("settled") }).safeParse(wait).success, `${name} chat settles through the real server`);
    prove(JSON.stringify(messages).includes(name === "official" ? "fake" : `endpoint answer ${name}`), `${name} chat contains the engine's final answer`);
    chats.set(instanceId, bot);
    const session = service.requests.filter(receipt => receipt.instanceId === instanceId).at(-1)?.session;
    if (session) chatSessions.set(instanceId, session);
    return bot;
  };
  try {
    fixture = await control.launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, ["codex"]);
    report.fixture = fixture.info; save();
    process.stdout.write(`${JSON.stringify({ fixture: fixture.info, evidenceDir })}\n`);
    const initial = instancesSchema.parse(await api("GET", "/api/instances")).instances;
    for (const runtime of ["claude", "codex"]) {
      const instance = initial.find(item => item.instanceId === runtime);
      if (!instance) throw new Error(`Missing official fixture ${runtime}`);
      await chat(runtime, instance.models.default, "official");
    }
    const legacy = z.object({ instanceId: z.string() }).parse(await api("POST", "/api/instances/claude-endpoint", {
      displayName: "Synthetic legacy endpoint", baseUrl: `${service.url}/legacy/v1`,
      token: "fixture-only-legacy", model: "legacy-fixture-model",
    }, 201));
    keys.push("fixture-only-legacy");
    await api("PATCH", `/api/instances/${legacy.instanceId}`, { cli: join(repoRoot, "server/testing/fake-claude-cli.ts") });
    const oldConfig = config();
    const oldInstances = instancesSchema.parse(await api("GET", "/api/instances")).instances;
    const scenario = options.scenario;
    if (/^(?:codex|claude)-(?:deepseek|kimi)$/.test(scenario)) {
      const [runtime, provider] = scenario.split("-");
      await create(z.enum(["deepseek", "kimi"]).parse(provider), [runtimeSchema.parse(runtime)]);
    } else {
      await create("deepseek", ["codex", "claude"]);
      await create("kimi", ["codex", "claude"]);
    }
    prove(Object.entries(oldConfig.instances).every(([id, entry]) => isDeepStrictEqual(config().instances[id], entry)),
      "adding independent connections preserves every official and legacy config entry");
    prove(isDeepStrictEqual(config().defaultModelSelection, oldConfig.defaultModelSelection), "adding connections does not migrate the default selection");
    if (scenario === "official-regression") {
      const current = instancesSchema.parse(await api("GET", "/api/instances")).instances;
      prove(oldInstances.every(old => isDeepStrictEqual(current.find(item => item.instanceId === old.instanceId)?.models, old.models)),
        "official and legacy catalogs stay unchanged");
      for (const connection of connections) await api("DELETE", `/api/instances/${connection.instanceId}`);
      prove(isDeepStrictEqual(config().instances, oldConfig.instances), "removing all new connections restores the old instance map unchanged");
      prove(service.requests.length === 0, "official regression never contacts an endpoint");
    } else if (scenario === "failure-states") {
      const failures = [["401", "credentials"], ["model404", "model"], ["429", "rate_limit"], ["timeout", "timeout"]] satisfies Array<[FixtureFailure, string]>;
      for (const connection of connections) {
        for (const [mode, reason] of failures) { service.mode(connection.name, mode); await check(connection, "answer", reason); }
        service.mode(connection.name, "answer");
        await check(connection, "answer");
      }
    } else if (scenario === "background-route" || scenario === "tool-roundtrip") {
      for (const connection of connections) await check(connection, scenario === "background-route" ? "background" : "tools");
    } else if (scenario === "parallel-isolation") {
      await Promise.all(connections.map(async connection => { await check(connection, "answer"); await chat(connection.instanceId, connection.model, connection.name); }));
      const homes = connections.map(connection => new Set(service.requests.filter(receipt => receipt.connection === connection.name).map(receipt => receipt.home)));
      prove(homes.every(set => set.size === 1 && !set.has("")), "each concurrent instance uses one explicit CLI home");
      prove(new Set(homes.flatMap(set => [...set])).size === connections.length, "concurrent connection homes are distinct");
    } else {
      for (const connection of connections) { await chat(connection.instanceId, connection.model, connection.name); await check(connection, "answer"); }
    }
    if (scenario === "metadata-restart") {
      const target = connections[0];
      const previousSession = chatSessions.get(target.instanceId);
      const key = `fixture-only-${randomUUID()}`; keys.push(key);
      service.register(target.name, target.runtime, key);
      await api("PATCH", `/api/instances/${target.instanceId}/engine-endpoint`, { expectedRevision: target.revision, apiKey: key });
      target.revision += 1;
      await api("PATCH", `/api/instances/${target.instanceId}/engine-endpoint`, { expectedRevision: target.revision - 1, apiKey: key }, 409);
      await chat(target.instanceId, target.model, target.name, true);
      const updatedSession = chatSessions.get(target.instanceId);
      prove(previousSession && updatedSession && previousSession !== updatedSession, "key rotation does not resume the previous revision's native chat");
      const before = config();
      await waitForExit(fixture.child, { signal: "SIGTERM" });
      const port = Number(new URL(fixture.info.url).port);
      const env = control.verificationServerEnvironment({}, fixture.info.dataDir, port);
      const log = openSync(fixture.info.logPath, "a", 0o600);
      restarted = spawn(process.execPath, control.verificationServerArgs(env), { cwd: repoRoot, env, stdio: ["ignore", log, log] });
      closeSync(log);
      const deadline = Date.now() + 30_000;
      for (;;) {
        if (restarted.exitCode !== null) throw new Error("Restarted fixture exited before ready");
        try {
          const response = await fetch(`${fixture.info.url}/api/health`, { signal: AbortSignal.timeout(500) });
          if (response.ok) break;
        } catch { /* Readiness requires the owned process to listen. */ }
        assert(Date.now() < deadline, "Restart readiness timed out");
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      prove(isDeepStrictEqual(config().instances, before.instances), "HTTP update revisions and private instance configuration survive a real process restart");
      await chat(target.instanceId, target.model, target.name, true);
      for (const connection of connections) await check(connection, "answer");
      const walk = (path: string): string[] => readdirSync(path).flatMap(name => {
        const full = join(path, name); return statSync(full).isDirectory() ? walk(full) : [full];
      });
      const files = walk(join(fixture.info.dataDir, "providers")).filter(path => /models\.json|config\.toml|settings\.json/.test(path));
      prove(files.length >= 4, "endpoint metadata exists after restart");
      for (const file of files) for (const key of keys) assert(!readFileSync(file, "utf8").includes(key), "Derived metadata must not contain credentials");
      await api("DELETE", `/api/instances/${target.instanceId}`, undefined, 409);
      await create("kimi", ["codex"]);
      const removable = connections.at(-1);
      if (!removable) throw new Error("Missing removable fixture connection");
      await api("DELETE", `/api/instances/${removable.instanceId}`);
      prove(!Object.hasOwn(config().instances, removable.instanceId), "HTTP deletion removes an unreferenced connection after restart");
      connections.pop();
    }
    const unused = connections[connections.length - 1];
    if (scenario !== "official-regression" && unused) {
      await api("PATCH", `/api/instances/${unused.instanceId}/engine-endpoint`, { expectedRevision: unused.revision, displayName: "Renamed synthetic connection" });
      prove(Object.entries(oldConfig.instances).every(([id, entry]) => isDeepStrictEqual(config().instances[id], entry)),
        "HTTP update leaves official and legacy entries unchanged");
    }
    report.ok = true;
  } catch (error) {
    report.error = redact(error instanceof Error ? error.message : String(error));
  } finally {
    if (fixture) {
      const log = readFileSync(fixture.info.logPath, "utf8");
      writeFileSync(join(evidenceDir, "server.log"), redact(log));
      if (keys.some(key => log.includes(key))) { report.ok = false; report.error = "Server log leaked a synthetic key; evidence was redacted"; }
    }
    try {
      await waitForExit(restarted, { signal: "SIGTERM" });
    } finally {
      try { await fixture?.close(); }
      finally { await service.close(); save(); }
    }
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      scenario: { type: "string" }, "evidence-dir": { type: "string" }, "repo-root": { type: "string" },
    } });
    const report = await verifyEngineEndpoints({
      scenario: scenarioSchema.parse(values.scenario), evidenceDir: z.string().min(1).parse(values["evidence-dir"]),
      ...(values["repo-root"] ? { repoRoot: values["repo-root"] } : {}),
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
