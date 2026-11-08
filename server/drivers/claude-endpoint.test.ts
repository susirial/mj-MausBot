import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DATA_DIR, NATIVE_DIR } from "../config.ts";
import type { SendTurnInput } from "../contracts.ts";
import { engineHomes } from "../engine-homes/engine-homes.ts";
import { flushNativeLog } from "./native.ts";
import { recordEvents } from "../testing/events.ts";
import { ClaudeDriver } from "./claude.ts";
import { endpointCheckFailure } from "../engine-endpoint-check.ts";

const cli = join(dirname(fileURLToPath(import.meta.url)), "../testing/fake-claude-cli.ts");
const roots: string[] = [];
const instances: Awaited<ReturnType<typeof ClaudeDriver.create>>[] = [];
afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.dispose();
  engineHomes.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omb-claude-endpoint-"));
  roots.push(root);
  return root;
}

const endpoint = {
  version: 1, revision: 1, runtime: "claude", protocol: "anthropic", provider: "custom",
  baseUrl: "https://endpoint.example/anthropic",
  catalog: {
    default: "deepseek-flash[1m]",
    options: ["deepseek-flash[1m]", "deepseek-flash"].map(id => ({
      id, label: id, source: "configured", inputModalities: ["text"],
      effortLevels: ["high"], nativeSearch: "unknown", contextWindow: 1000000,
    })),
  },
  backgroundModel: "deepseek-flash", defaultEffort: "high", autoCompactTokens: 400000,
  roleModels: { opus: "deepseek-flash", sonnet: "deepseek-flash[1m]", haiku: "deepseek-flash",
    fable: "deepseek-flash", subagent: "deepseek-flash" },
};

async function create(root: string, environment: Record<string, string> = {}, endpointConfig: unknown = endpoint) {
  const instance = await ClaudeDriver.create({
    instanceId: `claude-endpoint-${root.split("/").at(-1)}`, displayName: "Endpoint fixture", enabled: true,
    config: ClaudeDriver.decodeConfig({ cli, endpoint: endpointConfig, requireApiKey: true }),
    environment: {
      HOME: root, FAKE_CLAUDE_AUTH: "out", FAKE_CLAUDE_VERSION: "2.1.319",
      OPENMAUSBOT_ENDPOINT_API_KEY: "fixture-endpoint-key",
      ...environment,
    },
  });
  roots.push(join(DATA_DIR, "providers", instance.instanceId));
  instances.push(instance);
  return instance;
}

describe("additive Claude endpoints", () => {
  it("retires one check session while leaving another endpoint session intact", async () => {
    const instance = await create(fixture(), { FAKE_CLAUDE_TOOL_CALLS: "[]" });
    expect(instance.adapter.closeSession).toBeTypeOf("function");
    const events = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "check-session", text: "hi" });
      await events.until(event => event.threadId === "check-session" && event.type === "turn.completed");
      await instance.adapter.sendTurn({ threadId: "other-session", text: "hi" });
      await events.until(event => event.threadId === "other-session" && event.type === "turn.completed");
      expect(instance.adapter.cacheKeepWarm?.hold("check-session", null)).toBe(true);
      expect(instance.adapter.cacheKeepWarm?.hold("other-session", null)).toBe(true);
      await instance.adapter.closeSession?.("check-session");
      expect(instance.adapter.cacheKeepWarm?.hold("check-session", null)).toBe(false);
      expect(instance.adapter.cacheKeepWarm?.hold("other-session", null)).toBe(true);
    } finally { events.stop(); }
  });
  it("decodes only explicit endpoint configs and rejects malformed or mismatched runtimes", () => {
    expect(ClaudeDriver.decodeConfig({ endpoint })).toMatchObject({ endpoint });
    expect(() => ClaudeDriver.decodeConfig({ endpoint: { ...endpoint, runtime: "codex" } })).toThrow();
    expect(() => ClaudeDriver.decodeConfig({ endpoint: { ...endpoint, backgroundModel: "missing" } })).toThrow();
    expect(() => ClaudeDriver.decodeConfig({ endpoint: null })).toThrow();
    expect(() => ClaudeDriver.decodeConfig({ endpoint, managed: true })).toThrow();
    expect(ClaudeDriver.decodeConfig({ endpointModels: ["old-model"], configDir: "/tmp/old-endpoint" }))
      .toEqual({ cli: "claude", permissionMode: "acceptEdits", endpointModels: ["old-model"], configDir: "/tmp/old-endpoint" });
  });

  it("uses the configured key and catalog without official auth or discovery", async () => {
    const root = fixture(), probeLog = join(root, "probes");
    const instance = await create(root, { FAKE_CLAUDE_PROBE_LOG: probeLog });
    expect(await instance.snapshot()).toMatchObject({ state: "available" });
    expect(instance.models.default).toBe(endpoint.catalog.default);
    expect(instance.models.options.map(option => option.id)).toEqual(endpoint.catalog.options.map(option => option.id));
    await instance.refreshModels?.();
    expect(readFileSync(probeLog, "utf8")).not.toContain("auth ");
    expect(instance.models.options.every(option => option.custom)).toBe(true);
  });

  it("marks a keyed endpoint unavailable when the CLI cannot enforce settings isolation", async () => {
    const instance = await create(fixture(), { FAKE_CLAUDE_VERSION: "1.0.100" });
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("--setting-sources") });
  });

  it("does not accept official credentials when the endpoint key is missing", async () => {
    const instance = await create(fixture(), { OPENMAUSBOT_ENDPOINT_API_KEY: "", ANTHROPIC_API_KEY: "official-key" });
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable" });
    await expect(instance.generateText!("short background")).rejects.toThrow(/endpoint.*key/i);
    await expect(instance.adapter.sendTurn({ threadId: "endpoint-no-key", text: "hi" })).rejects.toThrow(/endpoint.*key/i);
  });

  it("launches a turn with isolated routing and authoritative settings while preserving permission rules", async () => {
    const root = fixture(), dump = join(root, "turn.json"), project = join(root, "project"), bot = join(root, "bot");
    for (const folder of [project, bot]) mkdirSync(join(folder, ".claude"), { recursive: true });
    writeFileSync(join(project, ".claude/settings.json"), JSON.stringify({
      env: { ANTHROPIC_API_KEY: "project-key", ANTHROPIC_BASE_URL: "https://wrong.example" },
      apiKeyHelper: "echo project-key", model: "claude-opus-5", permissions: { deny: ["Read(./.env)", 7], allow: "invalid", defaultMode: 7 },
      outputStyle: 7, statusLine: "invalid", hooks: { Stop: "invalid" },
    }));
    writeFileSync(join(bot, ".claude/settings.json"), JSON.stringify({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "project-oauth", GUARD_LEVEL: "strict" }, permissions: { deny: ["WebFetch"] },
    }));
    const instance = await create(root, {
      FAKE_CLAUDE_DUMP: dump, ANTHROPIC_API_KEY: "official-key", CLAUDE_CODE_OAUTH_TOKEN: "official-oauth",
      CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_DEFAULT_OPUS_MODEL: "wrong", OMB_CLAUDE_AUTOCOMPACT: "200000",
      OMB_CLAUDE_INHERIT_USER_CONFIG: "1",
    });
    const events = recordEvents(instance.adapter);
    try {
      await instance.snapshot();
      await instance.adapter.sendTurn({
        threadId: `endpoint-${root.split("/").at(-1)}`, text: "hi", cwd: project,
        botSettingsFile: join(bot, ".claude/settings.json"), model: endpoint.catalog.default, effort: "high",
      });
      await events.until(event => event.type === "turn.completed");
      const launch = JSON.parse(readFileSync(dump, "utf8"));
      expect(launch.env.ANTHROPIC_AUTH_TOKEN).toBe("fixture-endpoint-key");
      expect(launch.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(launch.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(launch.env.CLAUDE_CODE_USE_VERTEX).not.toBe("1");
      expect(launch.env.CLAUDE_CONFIG_DIR).toContain(join(DATA_DIR, "providers", instance.instanceId));
      expect(launch.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(endpoint.roleModels.opus);
      expect(launch.argv[launch.argv.indexOf("--model") + 1]).toBe(endpoint.catalog.default);
      expect(launch.argv[launch.argv.indexOf("--autocompact") + 1]).toBe("400000");
      expect(launch.settings.env.ANTHROPIC_BASE_URL).toBe(endpoint.baseUrl);
      expect(launch.settings.model).toBe(endpoint.catalog.default);
      expect(launch.settings.env.GUARD_LEVEL).toBe("strict");
      expect(launch.settings.permissions.deny).toContain("WebFetch");
      expect(launch.settings.permissions.deny).toContain("Read(./.env)");
      expect(launch.settings.permissions.deny.every((rule: unknown) => typeof rule === "string")).toBe(true);
      expect(launch.settings.permissions.allow).toBeUndefined();
      expect(launch.settings.permissions.defaultMode).toBeUndefined();
      expect(launch.settings.outputStyle).toBeUndefined();
      expect(launch.settings.statusLine).toBeUndefined();
      expect(launch.argv[launch.argv.indexOf("--setting-sources") + 1]).toBe("");
      expect(JSON.stringify(launch.settings)).not.toContain("fixture-endpoint-key");
      expect(JSON.stringify(launch.argv)).not.toContain("fixture-endpoint-key");
      expect(instance.startAuthentication).toBeUndefined();
      expect(launch.settings.apiKeyHelper).not.toBe("echo project-key");
    } finally { events.stop(); }
  });

  it("uses backgroundModel and never falls back to an official model", async () => {
    const root = fixture(), dump = join(root, "background.json");
    const instance = await create(root, { FAKE_CLAUDE_TEXT_DUMP: dump });
    await instance.generateText!("short background");
    const launch = JSON.parse(readFileSync(dump, "utf8"));
    expect(launch.argv[launch.argv.indexOf("--model") + 1]).toBe(endpoint.backgroundModel);
    expect(launch.env.ANTHROPIC_AUTH_TOKEN).toBe("fixture-endpoint-key");
    const settings = JSON.parse(launch.argv[launch.argv.indexOf("--settings") + 1]);
    expect(settings.model).toBe(endpoint.backgroundModel);
    expect(settings.alwaysThinkingEnabled).toBeUndefined();
    expect(launch.argv[launch.argv.indexOf("--autocompact") + 1]).toBe("400000");
    await expect(instance.generateText!("short background", { model: "claude-haiku-5-5" })).rejects.toThrow(/model/i);
  });

  it("checks an explicitly selected alternate model without substituting backgroundModel", async () => {
    const root = fixture(), dump = join(root, "background.json");
    const instance = await create(root, { FAKE_CLAUDE_TEXT_DUMP: dump });
    await instance.generateText!("check the selected model", { model: endpoint.catalog.default });
    const launch = JSON.parse(readFileSync(dump, "utf8"));
    expect(launch.argv[launch.argv.indexOf("--model") + 1]).toBe(endpoint.catalog.default);
    expect(launch.env.ANTHROPIC_MODEL).toBe(endpoint.catalog.default);
    expect(JSON.parse(launch.argv[launch.argv.indexOf("--settings") + 1]).model).toBe(endpoint.catalog.default);
    expect(launch.env.ANTHROPIC_AUTH_TOKEN).toBe("fixture-endpoint-key");
  });

  it("reports a rejected endpoint key without official login recovery and keeps the redacted error", async () => {
    const root = fixture();
    mkdirSync(NATIVE_DIR, { recursive: true });
    const instance = await create(root, { FAKE_CLAUDE_MODE: "api-error", FAKE_CLAUDE_API_ERROR_KIND: "authentication_failed",
      FAKE_CLAUDE_API_ERROR: "401 unauthorized fixture-endpoint-key", FAKE_CLAUDE_API_ERROR_STATUS: "401" });
    const events = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: `refused-${root.split("/").at(-1)}`, text: "hello",
        model: endpoint.catalog.default, startupRecovery: true });
      await events.until(event => event.type === "turn.completed");
      const error = events.events.find(event => event.type === "runtime.error");
      expect(error).toMatchObject({ message: expect.stringContaining("401 unauthorized") });
      expect(error?.type === "runtime.error" && error.setup).not.toBe(true);
      expect(JSON.stringify(error)).not.toContain("fixture-endpoint-key");
      expect(JSON.stringify(error)).not.toMatch(/run \/login|sign.?in|reconnect your account/i);
      const threadId = `refused-${root.split("/").at(-1)}`;
      flushNativeLog(threadId);
      expect(readFileSync(join(NATIVE_DIR, `${threadId}.ndjson`), "utf8")).not.toContain("fixture-endpoint-key");
    } finally { events.stop(); }
  });

  it("rejects unsupported effort and unknown models without spawning or substituting a model", async () => {
    const instance = await create(fixture());
    await expect(instance.adapter.sendTurn({ threadId: "bad-effort", text: "hello", model: endpoint.catalog.default, effort: "max" }))
      .rejects.toThrow(/effort/i);
    await expect(instance.adapter.sendTurn({ threadId: "bad-model", text: "hello", model: "claude-sonnet-5" }))
      .rejects.toThrow(/model/i);
  });

  it.each([
    ["Endpoint HTTP 404 model_not_found fixture-endpoint-key", "model"],
    ["Endpoint HTTP 404 /anthropic/messages fixture-endpoint-key", "protocol"],
  ])("preserves endpoint error classification for %s", async (text, reason) => {
    const instance = await create(fixture(), { FAKE_CLAUDE_MODE: "api-error",
      FAKE_CLAUDE_API_ERROR_KIND: "unknown", FAKE_CLAUDE_API_ERROR: text, FAKE_CLAUDE_API_ERROR_STATUS: "404" });
    const events = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "endpoint-error", text: "hello", model: endpoint.catalog.default });
      await events.until(event => event.type === "turn.completed");
      const error = events.events.find(event => event.type === "runtime.error");
      expect(error?.type).toBe("runtime.error");
      if (error?.type !== "runtime.error") throw new Error("Missing endpoint error");
      expect(endpointCheckFailure(error.message)).toBe(reason);
      expect(error.message).not.toContain("fixture-endpoint-key");
    } finally { events.stop(); }
  });

  it("rejects images on a text-only endpoint model, including steering", async () => {
    const root = fixture(), path = join(root, "image.png"), data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    writeFileSync(path, data);
    const images = [{ path, mime: "image/png", bytes: data.length }] satisfies NonNullable<SendTurnInput["images"]>;
    const instance = await create(root);
    await expect(instance.adapter.sendTurn({ threadId: "text-only-images", text: "describe", model: endpoint.catalog.default, images }))
      .rejects.toThrow(/image.*not supported|does not support images/i);
    await instance.adapter.sendTurn({ threadId: "text-only-steer", text: "hello", model: endpoint.catalog.default });
    expect(await instance.adapter.steer!("text-only-steer", "describe", images)).toBe("refused");
  });

  it("allows images when the selected endpoint model declares image input", async () => {
    const root = fixture(), dump = join(root, "turn.json"), path = join(root, "image.png"), data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    writeFileSync(path, data);
    const instance = await create(root, { FAKE_CLAUDE_DUMP: dump }, { ...endpoint, catalog: { ...endpoint.catalog,
      options: endpoint.catalog.options.map(option => ({ ...option, inputModalities: option.id === endpoint.catalog.default ? ["text", "image"] : ["text"] })),
    } });
    const events = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "endpoint-image-supported", text: "describe", model: endpoint.catalog.default,
        images: [{ path, mime: "image/png", bytes: data.length }] });
      await events.until(event => event.type === "turn.completed");
      expect(JSON.parse(readFileSync(dump, "utf8")).prompt.message.content[0].type).toBe("image");
    } finally { events.stop(); }
  });

  it("omits unconfirmed effort on older CLIs and rejects an explicit effort request", async () => {
    const root = fixture(), dump = join(root, "background.json");
    const instance = await create(root, { FAKE_CLAUDE_VERSION: "2.1.232", FAKE_CLAUDE_TEXT_DUMP: dump });
    await instance.generateText!("hello");
    expect(JSON.parse(readFileSync(dump, "utf8")).argv).not.toContain("--effort");
    await expect(instance.adapter.sendTurn({ threadId: "old-effort-cli", text: "hello", model: endpoint.catalog.default, effort: "high" }))
      .rejects.toThrow(/effort/i);
  });

  it("keeps concurrent instances on their own keys and directories", async () => {
    const a = fixture(), b = fixture(), dumpA = join(a, "turn.json"), dumpB = join(b, "turn.json");
    const instances = await Promise.all([
      create(a, { FAKE_CLAUDE_DUMP: dumpA, OPENMAUSBOT_ENDPOINT_API_KEY: "fixture-key-a" }),
      create(b, { FAKE_CLAUDE_DUMP: dumpB, OPENMAUSBOT_ENDPOINT_API_KEY: "fixture-key-b" }),
    ]);
    const recorders = instances.map(instance => recordEvents(instance.adapter));
    try {
      await Promise.all(instances.map((instance, index) => instance.adapter.sendTurn({
        threadId: `parallel-${index}-${a.split("/").at(-1)}`, text: "hello", model: endpoint.catalog.default,
      })));
      await Promise.all(recorders.map(recorder => recorder.until(event => event.type === "turn.completed")));
      const launchA = JSON.parse(readFileSync(dumpA, "utf8")), launchB = JSON.parse(readFileSync(dumpB, "utf8"));
      expect(launchA.env.ANTHROPIC_AUTH_TOKEN).toBe("fixture-key-a");
      expect(launchB.env.ANTHROPIC_AUTH_TOKEN).toBe("fixture-key-b");
      expect(launchA.env.CLAUDE_CONFIG_DIR).not.toBe(launchB.env.CLAUDE_CONFIG_DIR);
    } finally { for (const recorder of recorders) recorder.stop(); }
  });

  it("restarts a retained process when sanitized project settings change", async () => {
    const root = fixture(), dump = join(root, "turn.json"), project = join(root, "project");
    mkdirSync(join(project, ".claude"), { recursive: true });
    const file = join(project, ".claude/settings.json");
    writeFileSync(file, JSON.stringify({ env: { PROJECT_GUARD: "first" } }));
    const instance = await create(root, { FAKE_CLAUDE_DUMP: dump });
    const events = recordEvents(instance.adapter), threadId = `project-${root.split("/").at(-1)}`;
    try {
      const first = await instance.adapter.sendTurn({ threadId, text: "hello", cwd: project, model: endpoint.catalog.default });
      await events.until(event => event.type === "turn.completed" && event.turnId === first.turnId);
      const before = JSON.parse(readFileSync(dump, "utf8"));
      writeFileSync(file, JSON.stringify({ env: { PROJECT_GUARD: "second" } }));
      const second = await instance.adapter.sendTurn({ threadId, text: "again", cwd: project, model: endpoint.catalog.default });
      await events.until(event => event.type === "turn.completed" && event.turnId === second.turnId);
      const after = JSON.parse(readFileSync(dump, "utf8"));
      expect(after.settings.env.PROJECT_GUARD).toBe("second");
      expect(after.pid).not.toBe(before.pid);
    } finally { events.stop(); }
  });

  it("keeps audience endpoint homes intact through the final spawn transformation", async () => {
    const root = fixture(), dump = join(root, "turn.json");
    engineHomes.start({ dataDir: DATA_DIR, serverHome: root, env: { HOME: root },
      audienceOf: threadId => `member:${threadId}`, threads: () => [] });
    const instance = await create(root, { FAKE_CLAUDE_DUMP: dump });
    const events = recordEvents(instance.adapter), homes: string[] = [];
    try {
      for (const suffix of ["a", "b"]) {
        const threadId = `audience-${suffix}-${root.split("/").at(-1)}`;
        const scope = engineHomes.within(threadId, () => engineHomes.scope());
        roots.push(join(DATA_DIR, "engine-homes", scope!));
        await engineHomes.within(threadId, () => instance.adapter.sendTurn({
          threadId, text: "hello", model: endpoint.catalog.default,
        }));
        await events.until(event => event.type === "turn.completed" && event.threadId === threadId);
        const launch = JSON.parse(readFileSync(dump, "utf8"));
        homes.push(launch.env.CLAUDE_CONFIG_DIR);
        expect(launch.env.CLAUDE_CONFIG_DIR).toBe(join(DATA_DIR, "engine-homes", scope!, "providers", instance.instanceId, "claude"));
        expect(launch.env.ANTHROPIC_AUTH_TOKEN).toBe("fixture-endpoint-key");
      }
      expect(homes[0]).not.toBe(homes[1]);
    } finally { events.stop(); }
  });
});
