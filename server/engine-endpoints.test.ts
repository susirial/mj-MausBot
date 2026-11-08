import { describe, expect, it } from "vitest";
import type { InstanceConfigMap } from "./contracts.ts";
import {
  createEndpointEntries, ENDPOINT_API_KEY_ENV, endpointConnectionSchema, endpointCreateSchema,
  endpointFromConfig, endpointModelCatalog, endpointUpdateSchema, isEngineEndpoint, publicEndpointInfo, updateEndpointEntry,
} from "./engine-endpoints.ts";
import { endpointPresets } from "./engine-endpoint-presets.ts";

function codexFixture() {
  return {
    version: 1, revision: 1, runtime: "codex", protocol: "responses", provider: "custom",
    baseUrl: "https://example.test/v1/",
    catalog: { default: "main", options: [
      { id: "main", label: "Main", source: "configured", contextWindow: 10000,
        inputModalities: ["text", "image"], effortLevels: ["high"], nativeSearch: "supported" },
      { id: "small", label: "Small", source: "configured", contextWindow: 5000,
        inputModalities: ["text"], effortLevels: [], nativeSearch: "unknown" },
    ] },
    backgroundModel: "small", defaultEffort: "high", webSearch: "disabled",
  };
}

function claudeFixture() {
  const { webSearch: _webSearch, ...base } = codexFixture();
  return { ...base, runtime: "claude", protocol: "anthropic", autoCompactTokens: 4000,
    roleModels: { opus: "main", sonnet: "main", haiku: "small", fable: "main", subagent: "small" } };
}

function request() {
  return endpointCreateSchema.parse({
    operationId: "11111111-1111-4111-8111-111111111111",
    displayName: "My connection", provider: "custom", apiKey: "fixture-secret",
    connections: [codexFixture(), claudeFixture()],
  });
}
const options = { dataDir: "/tmp/endpoint-fixture", newInstanceId: (runtime: "codex" | "claude") => `${runtime}-fixture` };
const legacy: InstanceConfigMap = {
  official: { driver: "codex", config: { cli: "codex" }, environment: { OPENAI_API_KEY: "old" } },
  oldClaude: { driver: "claudeAgent", config: { endpointModels: ["old"] }, environment: { ANTHROPIC_AUTH_TOKEN: "old" } },
};

describe("endpoint contracts", () => {
  it("normalizes only trailing URL slashes and preserves protocol paths", () => {
    expect(endpointConnectionSchema.parse(codexFixture()).baseUrl).toBe("https://example.test/v1");
    expect(endpointConnectionSchema.parse(claudeFixture()).runtime).toBe("claude");
  });
  it.each([
    { catalog: { ...codexFixture().catalog, default: "missing" } },
    { catalog: { ...codexFixture().catalog, options: [] } },
    { catalog: { ...codexFixture().catalog, options: [codexFixture().catalog.options[0], codexFixture().catalog.options[0]] } },
    { backgroundModel: "missing" }, { revision: 0 }, { protocol: "anthropic" }, { defaultEffort: "low" },
    { runtime: "claude" }, { webSearch: "live", backgroundModel: "small" },
  ])("rejects invalid catalog or runtime configuration %j", (patch) => {
    expect(endpointConnectionSchema.safeParse({ ...codexFixture(), ...patch }).success).toBe(false);
  });
  it.each(["ftp://example.test", "https://u:p@example.test/v1", "https://example.test/?key=x",
    "https://example.test/#x", "https://example.test/\npath", "https://example.test/?", "https://example.test/#"])(
    "rejects unsafe URL %s", (baseUrl) => {
      expect(endpointConnectionSchema.safeParse({ ...codexFixture(), baseUrl }).success).toBe(false);
    });
  it("rejects command-like ids and Claude-only suffixes for Codex", () => {
    for (const id of ["x;touch /tmp/x", "--config=x", "x[1m]", "provider::model"]) {
      const raw = codexFixture();
      raw.catalog.options[0].id = id;
      expect(endpointConnectionSchema.safeParse(raw).success).toBe(false);
    }
    const raw = claudeFixture();
    raw.catalog.options[0].id = "main[1m]";
    raw.catalog.default = "main[1m]";
    raw.roleModels.opus = raw.roleModels.sonnet = raw.roleModels.fable = "main[1m]";
    expect(endpointConnectionSchema.safeParse(raw).success).toBe(true);
  });
  it("rejects host-decorator ids for Claude even when catalog membership is valid", () => {
    const raw = claudeFixture();
    raw.catalog.options[0].id = raw.catalog.default = "host::main";
    raw.roleModels.opus = raw.roleModels.sonnet = raw.roleModels.fable = "host::main";
    expect(endpointConnectionSchema.safeParse(raw).success).toBe(false);
  });
  it.each([0, 5000, 10000])("rejects compaction outside any used model context %s", (autoCompactTokens) => {
    expect(endpointConnectionSchema.safeParse({ ...claudeFixture(), autoCompactTokens }).success).toBe(false);
  });
  it("requires known context for custom compaction", () => {
    const raw = claudeFixture();
    const { contextWindow: _contextWindow, ...unknownContext } = raw.catalog.options[1];
    expect(endpointConnectionSchema.safeParse({ ...raw, catalog: { ...raw.catalog,
      options: [raw.catalog.options[0], unknownContext] } }).success).toBe(false);
  });
  it("does not reinterpret absent, malformed, or legacy config", () => {
    expect(endpointFromConfig(undefined)).toBeNull();
    expect(endpointFromConfig({ endpointModels: ["old"] })).toBeNull();
    expect(() => endpointFromConfig({ endpoint: { runtime: "codex" } })).toThrow();
    expect(endpointFromConfig({ endpoint: codexFixture() })?.runtime).toBe("codex");
  });
  it("identifies only explicit endpoint entries, including malformed endpoint markers", () => {
    expect(isEngineEndpoint(undefined)).toBe(false);
    expect(isEngineEndpoint(legacy.official)).toBe(false);
    expect(isEngineEndpoint(legacy.oldClaude)).toBe(false);
    expect(isEngineEndpoint({ driver: "codex", config: { endpoint: {} } })).toBe(true);
  });
  it("validates create boundaries and unique runtimes", () => {
    const raw = request();
    for (const patch of [{ apiKey: "" }, { apiKey: "secret\n" }, { displayName: "x\n" },
      { connections: [] }, { connections: [raw.connections[0], raw.connections[0]] },
      { provider: "kimi" }, { operationId: "bad" }, { environment: {} }]) {
      expect(endpointCreateSchema.safeParse({ ...raw, ...patch }).success).toBe(false);
    }
  });
  it("validates edit boundaries without accepting identity changes", () => {
    for (const raw of [{}, { expectedRevision: 1 }, { expectedRevision: 0, displayName: "x" },
      { expectedRevision: 1, apiKey: "" }, { expectedRevision: 1, endpointPatch: { runtime: "claude" } },
      { expectedRevision: 1, endpointPatch: { revision: 99 } }]) {
      expect(endpointUpdateSchema.safeParse(raw).success).toBe(false);
    }
  });
});

describe("pure endpoint entries", () => {
  it("creates separate credentials without changing official or legacy entries", () => {
    const before = structuredClone(legacy);
    const result = createEndpointEntries(legacy, request(), options);
    expect(result.instanceIds).toEqual(["codex-fixture", "claude-fixture"]);
    expect(legacy).toEqual(before);
    expect(result.instances.official).toBe(legacy.official);
    expect(result.instances.oldClaude).toBe(legacy.oldClaude);
    expect(result.instances["claude-fixture"].driver).toBe("claudeAgent");
    expect(result.instances["codex-fixture"].environment).not.toBe(result.instances["claude-fixture"].environment);
    expect(result.instances["codex-fixture"].environment?.[ENDPOINT_API_KEY_ENV]).toBe("fixture-secret");
  });
  it("inherits only the same driver's official executable and not directories or credentials", () => {
    const configs: InstanceConfigMap = {
      maliciousLegacy: { driver: "claudeAgent", config: { cli: "wrong", endpointModels: ["old"] } },
      managed: { driver: "codex", config: { cli: "wrong", managed: { url: "https://managed.test" } } },
      codexOfficial: { driver: "codex", config: { cli: "/tmp/fake codex", extra: "not inherited" },
        environment: { OPENAI_API_KEY: "official-only" } },
      claudeOfficial: { driver: "claudeAgent", config: { cli: "/tmp/fake claude", configDir: "/official" },
        environment: { ANTHROPIC_API_KEY: "official-only" } },
    };
    const result = createEndpointEntries(configs, request(), options);
    expect(result.instances["codex-fixture"].config).toMatchObject({ cli: "/tmp/fake codex" });
    expect(result.instances["claude-fixture"].config).toMatchObject({ cli: "/tmp/fake claude" });
    expect(result.instances["claude-fixture"].config).not.toMatchObject({ configDir: "/official" });
    expect(result.instances["codex-fixture"].config).not.toHaveProperty("extra");
    expect(JSON.stringify(result.instances["codex-fixture"])).not.toContain("official-only");
    expect(JSON.stringify(result.instances["claude-fixture"])).not.toContain("official-only");
  });
  it("replays operationId irrespective of request order and never allocates new ids", () => {
    const body = request();
    const first = createEndpointEntries(legacy, body, options);
    const second = createEndpointEntries(first.instances, { ...body, connections: [...body.connections].reverse() },
      { ...options, newInstanceId: () => { throw new Error("must not allocate"); } });
    expect(new Set(second.instanceIds)).toEqual(new Set(first.instanceIds));
    expect(second.instances).toBe(first.instances);
  });
  it("rejects conflicting replay, partial deletion, and edited entries", () => {
    const body = request();
    const first = createEndpointEntries(legacy, body, options);
    expect(() => createEndpointEntries(first.instances, { ...body, apiKey: "different" }, options)).toThrow();
    const partial = { ...first.instances };
    delete partial["claude-fixture"];
    expect(() => createEndpointEntries(partial, body, options)).toThrow();
    const edited = updateEndpointEntry(first.instances, "codex-fixture",
      endpointUpdateSchema.parse({ expectedRevision: 1, apiKey: "new" }));
    expect(() => createEndpointEntries(edited.instances, body, options)).toThrow();
  });
  it("increments revision only for runtime or key changes and preserves siblings", () => {
    const created = createEndpointEntries(legacy, request(), options).instances;
    const renamed = updateEndpointEntry(created, "codex-fixture",
      endpointUpdateSchema.parse({ expectedRevision: 1, displayName: "Renamed" }));
    expect(renamed.runtimeChanged).toBe(false);
    expect(endpointFromConfig(renamed.instances["codex-fixture"].config)?.revision).toBe(1);
    const rotated = updateEndpointEntry(renamed.instances, "codex-fixture",
      endpointUpdateSchema.parse({ expectedRevision: 1, apiKey: "rotated" }));
    expect(rotated.runtimeChanged).toBe(true);
    expect(endpointFromConfig(rotated.instances["codex-fixture"].config)?.revision).toBe(2);
    expect(rotated.instances["claude-fixture"]).toBe(created["claude-fixture"]);
    expect(created["codex-fixture"].environment?.[ENDPOINT_API_KEY_ENV]).toBe("fixture-secret");
    expect(() => updateEndpointEntry(rotated.instances, "codex-fixture",
      endpointUpdateSchema.parse({ expectedRevision: 1, apiKey: "rotated" }))).toThrow();
  });
  it("requires new key on address or provider identity change", () => {
    const created = createEndpointEntries(legacy, request(), options).instances;
    for (const endpointPatch of [{ baseUrl: "https://other.test/v1" }, { provider: "kimi" }]) {
      expect(() => updateEndpointEntry(created, "codex-fixture",
        endpointUpdateSchema.parse({ expectedRevision: 1, endpointPatch }))).toThrow();
    }
    const same = updateEndpointEntry(created, "codex-fixture",
      endpointUpdateSchema.parse({ expectedRevision: 1, endpointPatch: { baseUrl: "https://example.test/v1///" } }));
    expect(same.runtimeChanged).toBe(false);
    expect(() => updateEndpointEntry(created, "official",
      endpointUpdateSchema.parse({ expectedRevision: 1, displayName: "x" }))).toThrow();
  });
  it("updates CLI with revision protection and supports reset without changing siblings", () => {
    expect(endpointUpdateSchema.safeParse({ expectedRevision: 1, cli: "/opt/custom codex" }).success).toBe(true);
    const created = createEndpointEntries(legacy, request(), options).instances;
    const custom = updateEndpointEntry(created, "codex-fixture",
      endpointUpdateSchema.parse({ expectedRevision: 1, cli: "/opt/custom codex" }));
    expect(custom.runtimeChanged).toBe(true);
    expect(endpointFromConfig(custom.instances["codex-fixture"].config)?.revision).toBe(2);
    expect(custom.instances["codex-fixture"].config).toMatchObject({ cli: "/opt/custom codex" });
    const reset = updateEndpointEntry(custom.instances, "codex-fixture",
      endpointUpdateSchema.parse({ expectedRevision: 2, cli: "" }));
    expect(reset.runtimeChanged).toBe(true);
    expect(endpointFromConfig(reset.instances["codex-fixture"].config)?.revision).toBe(3);
    expect(reset.instances["codex-fixture"].config).not.toHaveProperty("cli");
    expect(reset.instances["claude-fixture"]).toBe(created["claude-fixture"]);
    expect(endpointUpdateSchema.safeParse({ expectedRevision: 1, cli: "  " }).success).toBe(false);
  });
  it("rejects driver mismatch and generated id collisions", () => {
    const created = createEndpointEntries(legacy, request(), options).instances;
    expect(() => publicEndpointInfo({ ...created["codex-fixture"], driver: "claudeAgent" })).toThrow();
    expect(() => createEndpointEntries(legacy, request(), { ...options, newInstanceId: () => "official" })).toThrow();
  });
  it("projects only public configuration and a keyConfigured flag", () => {
    const created = createEndpointEntries(legacy, request(), options).instances;
    const info = publicEndpointInfo(created["codex-fixture"]);
    expect(info.keyConfigured).toBe(true);
    expect(info.check).toEqual({ state: "unverified" });
    expect(JSON.stringify(info)).not.toContain("fixture-secret");
    expect(JSON.stringify(info)).not.toContain("11111111");
    expect(JSON.stringify(info)).not.toContain("/tmp");
    info.catalog.options[0].label = "changed";
    expect(endpointFromConfig(created["codex-fixture"].config)?.catalog.options[0].label).toBe("Main");
  });
  it("projects configured models and their effort variants without official defaults", () => {
    const catalog = endpointModelCatalog(endpointConnectionSchema.parse(codexFixture()));
    expect(catalog.default).toBe("main");
    expect(catalog.options.map((item) => item.id)).toEqual(["main", "small"]);
    expect(catalog.options[0]).toMatchObject({ custom: true, contextWindow: 10000, variants: [{ id: "high" }] });
  });
  it("provides all four validated presets with conservative Kimi effort metadata", () => {
    expect(endpointPresets).toHaveLength(4);
    for (const preset of endpointPresets) {
      expect(endpointConnectionSchema.safeParse(preset.endpoint).success).toBe(true);
      expect(preset.sources.length).toBeGreaterThan(0);
      if (preset.endpoint.provider === "kimi") {
        expect(preset.endpoint.catalog.options.map((model) => model.id)).toEqual(["kimi-k3.1-pro"]);
        expect(preset.endpoint.catalog.options[0].effortLevels).toEqual([]);
      }
    }
  });
  it("records the supplied DeepSeek 1M interpretation explicitly", () => {
    const model = endpointPresets.find((preset) => preset.id === "claude-deepseek")?.endpoint.catalog.options
      .find((option) => option.id === "deepseek-flash[1m]");
    expect(model?.contextWindow).toBe(1_048_576);
  });
});
