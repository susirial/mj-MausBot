import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { endpointConnectionSchema, ENDPOINT_API_KEY_ENV } from "../engine-endpoints.ts";
import { compileEndpointLaunch, isEndpointProtectedEnvName, prepareEndpointFiles, type EndpointLaunchInput } from "./endpoint-launch.ts";
import { PROVIDER_CREDENTIAL_ENV, WORKSPACE_CREDENTIAL_ENV } from "../credential-env.ts";

function endpointFixture(runtime: "codex" | "claude") {
  const base = {
    version: 1, revision: 1, provider: "custom", baseUrl: "https://example.test/v1/",
    catalog: { default: "main", options: [
      { id: "main", label: "Main", source: "configured", contextWindow: 10000,
        inputModalities: ["text", "image"], effortLevels: ["high"], nativeSearch: "supported" },
      { id: "small", label: "Small", source: "configured", contextWindow: 5000,
        inputModalities: ["text"], effortLevels: [], nativeSearch: "unknown" },
    ] }, backgroundModel: "small", defaultEffort: "high",
  };
  return runtime === "codex" ? { ...base, runtime, protocol: "responses", webSearch: "disabled" }
    : { ...base, runtime, protocol: "anthropic", autoCompactTokens: 4000,
      roleModels: { opus: "main", sonnet: "main", haiku: "small", fable: "main", subagent: "small" } };
}
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
function input(runtime: "codex" | "claude" = "codex"): EndpointLaunchInput {
  return { dataDir: "/tmp/endpoint-test", instanceId: "fixture", apiKey: "launch-secret",
    endpoint: endpointConnectionSchema.parse(endpointFixture(runtime)),
    model: "main", purpose: "turn", cliVersion: runtime === "codex" ? "0.167.0" : "2.1.319",
    supportedEffortLevels: ["high"] };
}
describe("endpoint launch", () => {
  it("compiles complete Codex overrides without key in argv", () => {
    const launch = compileEndpointLaunch(input());
    expect(launch.runtime).toBe("codex");
    if (launch.runtime !== "codex") return;
    expect(launch.env.CODEX_HOME).toBe("/tmp/endpoint-test/providers/fixture/codex");
    expect(launch.env[ENDPOINT_API_KEY_ENV]).toBe("launch-secret");
    expect(launch.modelProvider).toBe("omb_endpoint");
    expect(launch.model).toBe("main");
    expect(launch.effort).toBe("high");
    expect(launch.providerArgs).toEqual(expect.arrayContaining([
      'model_provider="omb_endpoint"', 'model_providers.omb_endpoint.wire_api="responses"',
      'model_providers.omb_endpoint.requires_openai_auth=false',
      'model_providers.omb_endpoint.supports_websockets=false',
      'model_providers.omb_endpoint.base_url="https://example.test/v1"',
      'model_providers.omb_endpoint.env_key="OPENMAUSBOT_ENDPOINT_API_KEY"',
      'model_catalog_json="/tmp/endpoint-test/providers/fixture/codex/models.json"',
      "model_context_window=10000",
    ]));
    expect(JSON.stringify(launch.providerArgs)).not.toContain("launch-secret");
    expect(JSON.stringify(launch.modelCatalog)).not.toContain("launch-secret");
  });
  it("uses background model without forcing low or the main model's default effort", () => {
    const launch = compileEndpointLaunch({ ...input(), purpose: "background" });
    expect(launch.model).toBe("small");
    expect(launch.effort).toBeUndefined();
    if (launch.runtime === "codex") expect(launch.providerArgs).toContain("model_context_window=5000");
    expect(() => compileEndpointLaunch({ ...input(), purpose: "background", effort: "high" })).toThrow();
  });
  it("rejects invalid selected models or efforts and omits unconfirmed effort", () => {
    expect(() => compileEndpointLaunch({ ...input(), model: "missing" })).toThrow();
    expect(() => compileEndpointLaunch({ ...input(), effort: "max" })).toThrow();
    expect(() => compileEndpointLaunch({ ...input(), supportedEffortLevels: ["low"], effort: "high" })).toThrow();
    expect(compileEndpointLaunch({ ...input(), supportedEffortLevels: [] }).effort).toBeUndefined();
    expect(compileEndpointLaunch({ ...input(), supportedEffortLevels: undefined, cliVersion: undefined }).effort).toBeUndefined();
  });
  it("clears inherited connection identity and preserves unrelated process variables", () => {
    for (const [key, value] of Object.entries({
      ANTHROPIC_API_KEY: "foreign", ANTHROPIC_AUTH_TOKEN: "foreign", CLAUDE_CODE_OAUTH_TOKEN: "foreign",
      CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "wrong", ANTHROPIC_SMALL_FAST_MODEL: "wrong",
      OPENAI_API_KEY: "foreign", OPENAI_BASE_URL: "https://wrong.test", CODEX_HOME: "/foreign",
      CLAUDE_CODE_EFFORT_LEVEL: "max", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000",
      ENDPOINT_TEST_KEEP: "preserved",
    })) vi.stubEnv(key, value);
    const before = { ...process.env };
    const launch = compileEndpointLaunch(input("claude"));
    expect(launch.runtime).toBe("claude");
    expect(launch.env.ENDPOINT_TEST_KEEP).toBe("preserved");
    expect(launch.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(launch.env.OPENAI_API_KEY).toBeUndefined();
    expect(launch.env.OPENAI_BASE_URL).toBeUndefined();
    expect(launch.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(launch.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(launch.env.CLAUDE_CODE_USE_VERTEX).toBeUndefined();
    expect(launch.env.CLAUDE_CODE_USE_FOUNDRY).toBeUndefined();
    expect(launch.env.ANTHROPIC_SMALL_FAST_MODEL).toBeUndefined();
    expect(launch.env.ANTHROPIC_AUTH_TOKEN).toBe("launch-secret");
    expect(launch.env[ENDPOINT_API_KEY_ENV]).toBeUndefined();
    expect(launch.env.ANTHROPIC_MODEL).toBe("main");
    expect(launch.env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe("main");
    expect(launch.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("small");
    expect(launch.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("4000");
    if (launch.runtime === "claude") {
      expect(launch.autoCompactTokens).toBe(4000);
      expect(JSON.stringify(launch.settings)).not.toContain("launch-secret");
    }
    expect(process.env).toEqual(before);
  });
  it("strips provider, workspace, operator, and cloud secrets including Windows aliases", () => {
    const names = [...PROVIDER_CREDENTIAL_ENV, ...WORKSPACE_CREDENTIAL_ENV,
      "ANTHROPIC_CUSTOM_HEADERS", "AWS_BEARER_TOKEN_BEDROCK", "AWS_SECRET_ACCESS_KEY",
      "AZURE_CLIENT_SECRET", "GOOGLE_APPLICATION_CREDENTIALS", "OMB_LICENSE_KEY",
      "OMB_CLOUD_UNKNOWN_TOKEN", "OPENMAUSBOT_CHATGPT_TOKEN"];
    for (const name of names) {
      vi.stubEnv(name, "foreign-secret");
      vi.stubEnv(name.toLowerCase(), "foreign-secret");
    }
    for (const runtime of ["codex", "claude"] as const) {
      const launch = compileEndpointLaunch(input(runtime));
      for (const name of names) {
        expect(isEndpointProtectedEnvName(name.toLowerCase())).toBe(true);
        expect(launch.env[name.toLowerCase()]).toBeUndefined();
        if (name !== ENDPOINT_API_KEY_ENV && name !== "ANTHROPIC_AUTH_TOKEN") expect(launch.env[name]).toBeUndefined();
      }
      expect(launch.env.OPENMAUSBOT_ENDPOINT_INSTANCE_ID).toBe("fixture");
      expect(launch.env[runtime === "codex" ? ENDPOINT_API_KEY_ENV : "ANTHROPIC_AUTH_TOKEN"]).toBe("launch-secret");
    }
  });
  it("separates homes by audience and instance and rejects traversal", () => {
    const a = compileEndpointLaunch({ ...input(), audienceKey: "team" });
    const b = compileEndpointLaunch({ ...input(), audienceKey: "member-0123456789abcdef" });
    const c = compileEndpointLaunch({ ...input(), audienceKey: "team", instanceId: "sibling" });
    expect(new Set([a.env.CODEX_HOME, b.env.CODEX_HOME, c.env.CODEX_HOME]).size).toBe(3);
    expect(a.env.CODEX_HOME).toBe("/tmp/endpoint-test/engine-homes/team/providers/fixture/codex");
    for (const instanceId of ["../escape", "/escape", ".", "a\\b"]) {
      expect(() => compileEndpointLaunch({ ...input(), instanceId })).toThrow();
    }
    expect(() => compileEndpointLaunch({ ...input(), audienceKey: "../escape" })).toThrow();
  });
  it("writes private, secret-free derived files without rewriting identical content", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "omb-endpoint-launch-"));
    directories.push(dataDir);
    for (const runtime of ["codex", "claude"] as const) {
      const call = { ...input(runtime), dataDir };
      const launch = compileEndpointLaunch(call);
      await prepareEndpointFiles(call);
      const home = launch.runtime === "codex" ? launch.env.CODEX_HOME : launch.env.CLAUDE_CONFIG_DIR;
      const files = runtime === "codex" ? ["config.toml", "models.json"] : ["settings.json"];
      for (const file of files) {
        const path = join(home, file);
        const content = await readFile(path, "utf8");
        expect(content).not.toContain("launch-secret");
        const before = await stat(path);
        expect(before.mode & 0o777).toBe(0o600);
        await prepareEndpointFiles(call);
        expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
      }
      if (runtime === "codex") {
        const catalog = JSON.parse(await readFile(join(home, "models.json"), "utf8"));
        expect(catalog.models.map((model: { slug: string }) => model.slug)).toEqual(["main", "small"]);
        expect(await readFile(join(home, "config.toml"), "utf8")).toContain("wire_api");
      }
    }
  });
});
