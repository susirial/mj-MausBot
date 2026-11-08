import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderInstance } from "../contracts.ts";
import { DATA_DIR } from "../config.ts";
import { engineHomes } from "../engine-homes/engine-homes.ts";
import { audienceHome } from "../engine-homes/layout.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents } from "../testing/events.ts";
import { CodexDriver } from "./codex.ts";

vi.mock("./codex-release.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("./codex-release.ts")>(),
  readLatestCodexRelease: async () => null,
}));

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-codex-app-server.ts");
const KEY = "synthetic-endpoint-key";
const endpoint = (effort = false) => ({
  version: 1,
  revision: 1,
  runtime: "codex",
  protocol: "responses",
  provider: "custom",
  baseUrl: "http://127.0.0.1:19876/v1",
  catalog: {
    default: "vendor-main",
    options: [
      { id: "vendor-main", label: "Main", source: "configured", contextWindow: 131072, inputModalities: ["text"], effortLevels: effort ? ["medium", "high"] : [], nativeSearch: "unknown" },
      { id: "vendor-small", label: "Background", source: "configured", contextWindow: 65536, inputModalities: ["text"], effortLevels: effort ? ["high"] : [], nativeSearch: "unknown" },
    ],
  },
  backgroundModel: "vendor-small",
  webSearch: "disabled",
  ...(effort ? { defaultEffort: "high" } : {}),
});

const callSchema = z.object({
  argv: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  calls: z.array(z.object({ method: z.string(), params: z.record(z.string(), z.unknown()).nullable() })).optional(),
});

describe("Codex endpoint boundary", () => {
  it("retains only explicitly configured endpoints", () => {
    expect(CodexDriver.decodeConfig({ endpoint: endpoint() })).toMatchObject({ endpoint: endpoint() });
    expect(CodexDriver.decodeConfig({})).toEqual({ cli: "codex", fullAuto: false });
  });

  it.each([
    { ...endpoint(), runtime: "claude", protocol: "anthropic", roleModels: { opus: "vendor-main", sonnet: "vendor-main", haiku: "vendor-main", fable: "vendor-main", subagent: "vendor-main" } },
    { ...endpoint(), catalog: { ...endpoint().catalog, default: "missing" } },
    null,
  ])("rejects malformed or runtime-mismatched endpoints", (value) => {
    expect(() => CodexDriver.decodeConfig({ endpoint: value })).toThrow();
  });

  it.each([
    { authMode: "chatgpt-plan" },
    { managed: { url: "https://company.example/v1", models: ["company"] } },
  ])("rejects endpoint and account-mode conflicts", (mode) => {
    expect(() => CodexDriver.decodeConfig({ endpoint: endpoint(), ...mode })).toThrow(/cannot be combined|conflict/i);
  });
});

describe("Codex endpoint execution with fake CLI", () => {
  let scratch: string;
  const instances: ProviderInstance[] = [];
  let sequence = 0;
  const create = async (options: { effort?: boolean; key?: string; search?: boolean; environment?: Record<string, string> } = {}) => {
    const connection = endpoint(options.effort);
    if (options.search) {
      connection.webSearch = "live";
      for (const model of connection.catalog.options) model.nativeSearch = "supported";
    }
    const instance = await CodexDriver.create({
      instanceId: `codex-endpoint-test-${sequence++}`,
      displayName: "Endpoint",
      enabled: true,
      environment: {
        HOME: scratch,
        CODEX_HOME: join(scratch, "unrelated-official-home"),
        OPENMAUSBOT_ENDPOINT_API_KEY: options.key ?? KEY,
        OPENMAUSBOT_COMPANY_API_KEY: "sibling-company-key",
        OPENMAUSBOT_CHATGPT_TOKEN: "sibling-plan-token",
        FAKE_CODEX_DUMP: join(scratch, "main.json"),
        FAKE_CODEX_TEXT_LOG: join(scratch, "background.jsonl"),
        FAKE_CODEX_MODE: "logged-out",
        FAKE_CODEX_VERSION: "codex-cli 0.167.0",
        FAKE_CODEX_ACCOUNT_MODE: "none",
        ...options.environment,
      },
      config: CodexDriver.decodeConfig({ cli: FAKE_CLI, endpoint: connection }),
    });
    instances.push(instance);
    return instance;
  };
  const mainCall = () => callSchema.parse(JSON.parse(readFileSync(join(scratch, "main.json"), "utf8")));
  const backgroundCalls = () => readFileSync(join(scratch, "background.jsonl"), "utf8").trim().split("\n").map((line) => callSchema.parse(JSON.parse(line)));
  const turn = async (instance: ProviderInstance, input: Parameters<ProviderInstance["adapter"]["sendTurn"]>[0]) => {
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn(input);
      await recorder.until((event) => event.type === "turn.completed");
      return recorder.events;
    } finally { recorder.stop(); }
  };

  beforeEach(() => {
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-endpoint-codex-"));
  });
  afterEach(async () => {
    await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
    engineHomes.stop();
    vi.unstubAllEnvs();
    await removeTempDir(scratch);
  });

  it("uses its catalog without official startup discovery or refresh", async () => {
    const instance = await create();
    expect(instance.models.default).toBe("vendor-main");
    expect(instance.models.options.map((model) => model.id)).toEqual(["vendor-main", "vendor-small"]);
    expect(instance.startupModelRefresh).toBeUndefined();
    expect(existsSync(join(scratch, "main.json"))).toBe(false);
    await instance.refreshModels?.();
    expect(instance.models.options.map((model) => model.id)).toEqual(["vendor-main", "vendor-small"]);
    expect(existsSync(join(scratch, "main.json"))).toBe(false);
  });

  it("reports a key-configured endpoint without official login", async () => {
    const instance = await create();
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true, billing: "metered", account: { method: "api-key" } });
    expect(existsSync(join(scratch, "main.json"))).toBe(false);
  });

  it("reports a missing private key as unavailable", async () => {
    const instance = await create({ key: "" });
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable", authenticated: false });
    await expect(instance.generateMemoryText!("hello")).rejects.toThrow(/key/i);
    await expect(instance.adapter.sendTurn({ threadId: "no-key", text: "hello" })).rejects.toThrow(/key/i);
  });

  it("reports an unqualified CLI version as unavailable without probing official models", async () => {
    const instance = await create({ environment: { FAKE_CODEX_VERSION: "codex-cli 0.147.0" } });
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable" });
    expect(existsSync(join(scratch, "main.json"))).toBe(false);
  });

  it.each(["x\nkey", "x".repeat(4097)])("reports malformed private keys as unavailable", async (key) => {
    const instance = await create({ key });
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable" });
  });

  it("never exposes official OAuth or sign-out actions", async () => {
    const instance = await create();
    expect(instance.startAuthentication).toBeUndefined();
    expect(instance.getAuthentication).toBeUndefined();
    expect(instance.cancelAuthentication).toBeUndefined();
    expect(instance.signOut).toBeUndefined();
  });

  it.each(["start", "resume"])("routes thread/%s with a raw model and fixed provider", async (method) => {
    const instance = await create({ effort: true, environment: { FAKE_CODEX_MODE: method === "resume" ? "resume" : "logged-out" } });
    const events = await turn(instance, { threadId: `endpoint-${method}`, text: "hello", model: "vendor-main", effort: "high", ...(method === "resume" ? { resumeCursor: "codex-thread-1" } : {}), cwd: scratch });
    expect(events.find((event) => event.type === "turn.completed")).toMatchObject({ ok: true });
    const call = mainCall();
    expect(call.calls?.find((entry) => entry.method === `thread/${method}`)?.params).toMatchObject({ model: "vendor-main", modelProvider: "omb_endpoint", config: { "model_reasoning_effort": "high" } });
    expect(call.calls?.find((entry) => entry.method === "turn/start")?.params).toMatchObject({ effort: "high" });
    expect(call.argv).toContain('model_provider="omb_endpoint"');
    expect(call.argv).toContain('model_providers.omb_endpoint.base_url="http://127.0.0.1:19876/v1"');
    expect(call.argv).toContain("model_context_window=131072");
    expect(call.env.CODEX_HOME).toContain(join(DATA_DIR, "providers", instance.instanceId));
    expect(call.env.CODEX_HOME).not.toBe(join(scratch, "unrelated-official-home"));
    expect(call.env.OPENMAUSBOT_ENDPOINT_API_KEY).toBe(KEY);
    expect(call.env.OPENAI_API_KEY).toBeUndefined();
    expect(call.env.OPENMAUSBOT_COMPANY_API_KEY).toBeUndefined();
    expect(call.env.OPENMAUSBOT_CHATGPT_TOKEN).toBeUndefined();
    expect(call.argv.join(" ")).not.toContain(KEY);
  });

  it("merges shell exclusions and disables snapshots even without tool selection", async () => {
    const instance = await create({ environment: { FAKE_CODEX_SHELL_ENVIRONMENT_POLICY: JSON.stringify({ exclude: ["PERSONAL_SECRET"], include_only: ["PATH", "HOME"] }) } });
    await turn(instance, { threadId: "endpoint-shell", text: "hello", cwd: scratch });
    const call = mainCall();
    expect(call.argv).toContain("features.shell_snapshot=false");
    expect(call.calls?.find((entry) => entry.method === "thread/start")?.params?.config).toMatchObject({ "shell_environment_policy.exclude": ["PERSONAL_SECRET", "OPENMAUSBOT_ENDPOINT_API_KEY"] });
  });

  it("preserves filter-based shell includes and exclusions", async () => {
    const instance = await create({ environment: { FAKE_CODEX_SHELL_ENVIRONMENT_POLICY: JSON.stringify({ filters: { PATH: "include", "PERSONAL_SECRET": "exclude" } }) } });
    const events = await turn(instance, { threadId: "endpoint-filters", text: "hello", cwd: scratch });
    expect(events.find((event) => event.type === "turn.completed")).toMatchObject({ ok: true });
    expect(mainCall().calls?.find((entry) => entry.method === "thread/start")?.params?.config).toMatchObject({
      "shell_environment_policy.filters": { PATH: "include", PERSONAL_SECRET: "exclude", OPENMAUSBOT_ENDPOINT_API_KEY: "exclude" },
    });
  });

  it("uses default effort for a turn and lets an explicit selection override it", async () => {
    const instance = await create({ effort: true });
    await turn(instance, { threadId: "endpoint-default-effort", text: "hello", cwd: scratch });
    expect(mainCall().calls?.find((entry) => entry.method === "turn/start")?.params?.effort).toBe("high");
    await turn(instance, { threadId: "endpoint-selected-effort", text: "hello", effort: "medium", cwd: scratch });
    expect(mainCall().calls?.find((entry) => entry.method === "thread/start")?.params?.config).toMatchObject({ model_reasoning_effort: "medium" });
    expect(mainCall().calls?.find((entry) => entry.method === "turn/start")?.params?.effort).toBe("medium");
  });

  it("fails closed when the CLI cannot disable inherited shell snapshots", async () => {
    const instance = await create({ environment: { FAKE_CODEX_IGNORE_FEATURES: "1", FAKE_CODEX_MODE: "happy" } });
    const events = await turn(instance, { threadId: "endpoint-unsafe", text: "hello", cwd: scratch });
    expect(events.find((event) => event.type === "turn.completed")).toMatchObject({ ok: false });
    expect(events.some((event) => event.type === "content.delta")).toBe(false);
  });

  it("routes background with full explicit provider, catalog and model context overrides", async () => {
    const instance = await create();
    await expect(instance.generateMemoryText!("hello", { fallback: { model: "gpt-6-luna", refused: new Set(), onRefused: () => {} } })).resolves.toBe("fake background answer");
    const [call] = backgroundCalls();
    expect(call?.argv).toContain("--ignore-user-config");
    expect(call?.argv[call.argv.indexOf("--model") + 1]).toBe("vendor-small");
    expect(call?.argv).toContain('model_provider="omb_endpoint"');
    expect(call?.argv).toContain('model_providers.omb_endpoint.env_key="OPENMAUSBOT_ENDPOINT_API_KEY"');
    expect(call?.argv).toContain("model_providers.omb_endpoint.requires_openai_auth=false");
    expect(call?.argv).toContain("model_context_window=65536");
    expect(call?.argv.some((arg) => arg.startsWith("model_catalog_json="))).toBe(true);
    expect(call?.argv.some((arg) => arg.startsWith("model_reasoning_effort="))).toBe(false);
    expect(call?.env.OPENMAUSBOT_ENDPOINT_API_KEY).toBe(KEY);
    expect(call?.argv.join(" ")).not.toContain(KEY);
  });

  it("uses a configured background effort instead of fixed low", async () => {
    const instance = await create({ effort: true });
    await instance.generateMemoryText!("hello");
    expect(backgroundCalls()[0]?.argv).toContain('model_reasoning_effort="high"');
    expect(backgroundCalls()[0]?.argv).not.toContain('model_reasoning_effort="low"');
  });

  it("disables native search for tool-free background calls without changing main search policy", async () => {
    const instance = await create({ search: true });
    await turn(instance, { threadId: "endpoint-search", text: "hello", cwd: scratch });
    expect(mainCall().argv).toContain('web_search="live"');
    await instance.generateMemoryText!("background");
    const policies = backgroundCalls()[0]?.argv.filter((arg) => arg.startsWith("web_search="));
    expect(policies?.at(-1)).toBe('web_search="disabled"');
  });

  it("honors the explicitly requested check model without an official fallback", async () => {
    const instance = await create();
    await instance.generateMemoryText!("check model", { model: "vendor-main" });
    const [call] = backgroundCalls();
    expect(call?.argv[call.argv.indexOf("--model") + 1]).toBe("vendor-main");
    expect(call?.argv).toContain("model_context_window=131072");
  });

  it("rejects unconfigured models and unsupported effort before dispatch", async () => {
    const instance = await create();
    await expect(instance.adapter.sendTurn({ threadId: "bad-model", text: "hello", model: "gpt-6-luna" })).rejects.toThrow(/model|catalog/i);
    await expect(instance.adapter.sendTurn({ threadId: "bad-effort", text: "hello", model: "vendor-main", effort: "low" })).rejects.toThrow(/effort/i);
    await expect(instance.generateMemoryText!("hello", { model: "gpt-6-luna" })).rejects.toThrow(/model|catalog/i);
  });

  it("does not retry a refused background model on an official or bot fallback", async () => {
    const instance = await create({ environment: { FAKE_CODEX_TEXT_REFUSE: "vendor-small" } });
    await expect(instance.generateMemoryText!("hello", { fallback: { model: "gpt-6-luna", refused: new Set(), onRefused: () => {} } })).rejects.toThrow(/vendor-small/);
    expect(backgroundCalls()).toHaveLength(1);
  });

  it("keeps two endpoint instance homes and private keys separate", async () => {
    const first = await create();
    const second = await create({ key: "second-synthetic-key" });
    await first.generateMemoryText!("first");
    await second.generateMemoryText!("second");
    const [a, b] = backgroundCalls();
    expect(a?.env.CODEX_HOME).not.toBe(b?.env.CODEX_HOME);
    expect(a?.env.OPENMAUSBOT_ENDPOINT_API_KEY).toBe(KEY);
    expect(b?.env.OPENMAUSBOT_ENDPOINT_API_KEY).toBe("second-synthetic-key");
  });

  it("keeps generated endpoint files in the actual spawned home of each audience", async () => {
    engineHomes.start({ dataDir: DATA_DIR, serverHome: scratch,
      audienceOf: (threadId) => threadId === "private" ? "member:fixture-person" : "team",
      threads: () => [], log: () => {} });
    const instance = await create();
    for (const threadId of ["public", "private"]) {
      const events = await engineHomes.within(threadId, () => turn(instance, { threadId, text: "hello", cwd: scratch }));
      expect(events.find((event) => event.type === "turn.completed")).toMatchObject({ ok: true });
      const call = mainCall();
      const home = join(audienceHome(DATA_DIR, threadId === "private" ? "member:fixture-person" : "team"), "providers", instance.instanceId, "codex");
      expect(call.env.CODEX_HOME).toBe(home);
      expect(existsSync(join(home, "models.json"))).toBe(true);
      expect(call.argv).toContain(`model_catalog_json=${JSON.stringify(join(home, "models.json"))}`);
      await engineHomes.within(threadId, () => instance.generateMemoryText!("background"));
      expect(backgroundCalls().at(-1)?.env.CODEX_HOME).toBe(home);
    }
  });

  it("does not restore inherited official or workspace credentials from the compiler environment", async () => {
    vi.stubEnv("OPENMAUSBOT_COMPANY_API_KEY", "inherited-company");
    vi.stubEnv("OPENMAUSBOT_CHATGPT_TOKEN", "inherited-chatgpt");
    vi.stubEnv("OPENAI_API_KEY", "inherited-openai");
    vi.stubEnv("CODEX_API_KEY", "inherited-codex");
    vi.stubEnv("OMB_CLOUD_READY_TOKEN", "inherited-workspace");
    const instance = await create();
    await instance.generateMemoryText!("hello");
    const call = backgroundCalls()[0];
    for (const name of ["OPENMAUSBOT_COMPANY_API_KEY", "OPENMAUSBOT_CHATGPT_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "OMB_CLOUD_READY_TOKEN"]) {
      expect(call?.env[name]).toBeUndefined();
    }
  });

  it("reports endpoint configuration errors without official login advice", async () => {
    const instance = await create({ environment: { FAKE_CODEX_START_ERROR: JSON.stringify({ code: -32603, message: "provider_not_configured" }) } });
    const events = await turn(instance, { threadId: "endpoint-unconfigured", text: "hello", cwd: scratch });
    expect(events.find((event) => event.type === "turn.completed")).toMatchObject({ ok: false });
    const errors = events.filter((event) => event.type === "runtime.error");
    expect(JSON.stringify(errors)).toContain("provider_not_configured");
    expect(JSON.stringify(errors)).not.toMatch(/Continue with ChatGPT|ChatGPT plan|sign in/i);
  });
});
