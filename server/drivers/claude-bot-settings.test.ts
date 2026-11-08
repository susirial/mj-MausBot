import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { botSettingsFor, withBotSettings } from "./claude-bot-settings.ts";

const root = mkdtempSync(join(tmpdir(), "omb-bot-settings-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let count = 0;
/** A bot folder holding `settings` and an empty thread folder beside it. */
function folders(settings: unknown): { file: string; bot: string; thread: string } {
  const base = join(root, String(count++)), bot = join(base, "bot"), thread = join(base, "thread");
  mkdirSync(join(bot, ".claude"), { recursive: true });
  mkdirSync(thread);
  const file = join(bot, ".claude", "settings.json");
  writeFileSync(file, typeof settings === "string" ? settings : JSON.stringify(settings));
  return { file, bot, thread };
}

const guard = { matcher: "Bash", hooks: [{ type: "command", command: "/opt/guards/no-force-push.sh", timeout: 10 }] };

describe("botSettingsFor", () => {
  it("carries only validated project settings for an endpoint", () => {
    const { file, bot } = folders({
      model: "wrong", apiKeyHelper: "echo key", awsAuthRefresh: "aws login",
      env: { ANTHROPIC_AUTH_TOKEN: "wrong", CLAUDE_CODE_USE_BEDROCK: "1", TOOL_OPTION: "yes" },
      permissions: { deny: ["Read(./.env)"] }, outputStyle: "concise", sandbox: { enabled: true },
    });
    expect(botSettingsFor(file, bot, {}, { endpoint: true, project: true })).toEqual({
      env: { TOOL_OPTION: "yes" }, permissions: { deny: ["Read(./.env)"] },
    });
  });
  it("does not merge malformed project fields over endpoint settings and permission rules", () => {
    const { file, bot } = folders({
      model: 7, apiKeyHelper: "echo wrong-key", outputStyle: 5, statusLine: "invalid",
      hooks: { PreToolUse: [guard, { matcher: 7, hooks: "invalid" }], Stop: "invalid" },
      enabledPlugins: { "guard@team": true, broken: "invalid" },
      permissions: { allow: "invalid", deny: ["Read(./.env)", 7], defaultMode: "invalid" },
      env: { ANTHROPIC_BASE_URL: "https://wrong.example", GUARD_LEVEL: "strict", BROKEN: 7 },
    });
    expect(withBotSettings(botSettingsFor(file, bot, {}, { endpoint: true, project: true }), {
      model: "endpoint-model", env: { ANTHROPIC_BASE_URL: "https://endpoint.example" },
      permissions: { deny: ["Bash"] },
    })).toEqual({
      model: "endpoint-model", env: { ANTHROPIC_BASE_URL: "https://endpoint.example", GUARD_LEVEL: "strict" },
      permissions: { deny: ["Read(./.env)", "Bash"] }, hooks: { PreToolUse: [guard] },
      enabledPlugins: { "guard@team": true },
    });
  });
  it("filters mixed-case protected env names while preserving ordinary tool settings", () => {
    const { file, bot } = folders({
      env: {
        anthropic_api_key: "wrong", Anthropic_Base_Url: "https://wrong.example",
        Claude_Code_Oauth_Token: "wrong", Claude_Code_Use_Vertex: "1",
        Omb_Claude_Inherit_User_Config: "1", omb_claude_autocompact: "200000",
        OpenMausBot_Endpoint_Api_Key: "wrong", Claude_Config_Dir: "/wrong",
        Guard_Level: "strict",
      },
    });
    expect(botSettingsFor(file, bot, {}, { endpoint: true, project: true })).toEqual({ env: { Guard_Level: "strict" } });
  });
  it("filters endpoint identity settings without losing project tools, hooks or permissions", () => {
    const { file, thread } = folders({
      apiKeyHelper: "echo project-key", model: "claude-opus-5",
      env: {
        ANTHROPIC_API_KEY: "project-key", ANTHROPIC_AUTH_TOKEN: "project-token",
        ANTHROPIC_BASE_URL: "https://wrong.example", CLAUDE_CODE_OAUTH_TOKEN: "project-oauth",
        CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_USE_FOUNDRY: "1",
        ANTHROPIC_DEFAULT_FABLE_MODEL: "wrong", CLAUDE_CODE_SUBAGENT_MODEL: "wrong",
        CLAUDE_CODE_EFFORT_LEVEL: "max", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000",
        CLAUDE_CONFIG_DIR: "/wrong", GUARD_LEVEL: "strict",
      },
      hooks: { PreToolUse: [guard] },
      permissions: { deny: ["Read(./.env)"] },
      enabledPlugins: { "guard@team": true },
    });
    expect(botSettingsFor(file, thread, {}, { endpoint: true })).toEqual({
      env: { GUARD_LEVEL: "strict" }, hooks: { PreToolUse: [guard] },
      permissions: { deny: ["Read(./.env)"] }, enabledPlugins: { "guard@team": true },
    });
    expect(botSettingsFor(file, thread, {})).toMatchObject({
      env: { ANTHROPIC_API_KEY: "project-key", CLAUDE_CODE_USE_BEDROCK: "1" },
    });
  });

  it("takes the bot's hooks, plugins, permission rules and env", () => {
    const settings = {
      hooks: { PreToolUse: [guard] },
      enabledPlugins: { "guard@team": true, "notes@team": false },
      extraKnownMarketplaces: { team: { source: { source: "directory", path: "/opt/marketplace" } } },
      permissions: { allow: ["Bash(npm test)"], ask: ["Bash(git push:*)"], deny: ["Read(./.env)"], additionalDirectories: ["/opt/shared"] },
      env: { GUARD_LEVEL: "strict" },
    };
    const { file, thread } = folders(settings);
    expect(botSettingsFor(file, thread, {})).toEqual(settings);
  });

  it("leaves behind every other field, and each entry Claude Code would refuse, so OpenMausBot's own settings still load", () => {
    const { file, thread } = folders({
      model: 123, statusLine: "x", outputStyle: 5, apiKeyHelper: "echo key", cleanupPeriodDays: "30", disableAllHooks: true,
      hooks: { PreToolUse: [guard, { matcher: 5, hooks: "x" }, { hooks: [{ command: "no type" }] }], Stop: "nope" },
      enabledPlugins: { "guard@team": true, "typo@team": "yes" },
      extraKnownMarketplaces: { team: { source: { source: "directory", path: "/opt/marketplace" } }, broken: "x" },
      permissions: { allow: "Bash", deny: ["Read(./.env)", 7], defaultMode: "bypassPermissions", disableBypassPermissionsMode: "disable" },
      env: { GUARD_LEVEL: "strict", RETRIES: 3, PATH: "/somewhere/else" },
    });
    expect(botSettingsFor(file, thread, { PATH: "/usr/bin" })).toEqual({
      hooks: { PreToolUse: [guard] },
      enabledPlugins: { "guard@team": true },
      extraKnownMarketplaces: { team: { source: { source: "directory", path: "/opt/marketplace" } } },
      permissions: { deny: ["Read(./.env)"] },
      env: { GUARD_LEVEL: "strict" },
    });
  });

  it("takes nothing from a missing file, a file that is not a JSON object, or no file at all", () => {
    const { thread } = folders({});
    for (const content of ["{ not json", "[1, 2]", "\"text\"", "null"]) {
      expect(botSettingsFor(folders(content).file, thread, {})).toEqual({});
    }
    expect(botSettingsFor(join(root, "missing", ".claude", "settings.json"), thread, {})).toEqual({});
    expect(botSettingsFor(undefined, thread, {})).toEqual({});
  });

  it("leaves the settings of the folder the turn runs in to Claude Code, which reads them itself", () => {
    const { file, bot } = folders({ hooks: { PreToolUse: [guard] } });
    expect(botSettingsFor(file, bot, {})).toEqual({});
  });

  it.skipIf(process.platform === "win32")("never reads through a link the bot could have planted, file or folder", () => {
    const outside = folders({ env: { SECRET: "from outside the bot's folder" } });
    const linkedFile = join(root, "linked-file");
    mkdirSync(join(linkedFile, ".claude"), { recursive: true });
    symlinkSync(outside.file, join(linkedFile, ".claude", "settings.json"));
    expect(botSettingsFor(join(linkedFile, ".claude", "settings.json"), outside.thread, {})).toEqual({});
    const linkedFolder = join(root, "linked-folder");
    mkdirSync(linkedFolder);
    symlinkSync(join(outside.bot, ".claude"), join(linkedFolder, ".claude"));
    expect(botSettingsFor(join(linkedFolder, ".claude", "settings.json"), outside.thread, {})).toEqual({});
  });

  it.skipIf(process.platform === "win32")("passes over a FIFO in place of the file without waiting on it", () => {
    const bot = join(root, "fifo");
    mkdirSync(join(bot, ".claude"), { recursive: true });
    expect(spawnSync("mkfifo", [join(bot, ".claude", "settings.json")]).status).toBe(0);
    expect(botSettingsFor(join(bot, ".claude", "settings.json"), folders({}).thread, {})).toEqual({});
  });
});

describe("withBotSettings", () => {
  it("merges as Claude Code merges a project's settings under --settings: lists join, OpenMausBot's own values win", () => {
    const ombStop = { matcher: "", hooks: [{ type: "command", command: "omb-hook", timeout: 5 }] };
    const botStop = { hooks: [{ type: "command", command: "/opt/notify.sh" }] };
    expect(withBotSettings(
      { hooks: { PreToolUse: [guard], Stop: [botStop] }, env: { GUARD_LEVEL: "strict", ENABLE_TOOL_SEARCH: "false" }, enabledPlugins: { "guard@team": true } },
      { hooks: { Stop: [ombStop], PostToolUse: [ombStop] }, env: { ENABLE_TOOL_SEARCH: "true" }, claudeMdExcludes: ["/home/ada/.claude/CLAUDE.md"] },
    )).toEqual({
      hooks: { PreToolUse: [guard], Stop: [botStop, ombStop], PostToolUse: [ombStop] },
      env: { GUARD_LEVEL: "strict", ENABLE_TOOL_SEARCH: "true" },
      enabledPlugins: { "guard@team": true },
      claudeMdExcludes: ["/home/ada/.claude/CLAUDE.md"],
    });
    expect(withBotSettings({ permissions: { deny: ["Read(./.env)", "WebFetch"] } }, { permissions: { deny: ["WebFetch", "Bash"] } }))
      .toEqual({ permissions: { deny: ["Read(./.env)", "WebFetch", "Bash"] } });
    expect(withBotSettings({}, { env: { ENABLE_TOOL_SEARCH: "true" } })).toEqual({ env: { ENABLE_TOOL_SEARCH: "true" } });
  });

  it("keeps a key named __proto__ as data", () => {
    const merged = withBotSettings(JSON.parse('{"env": {"__proto__": {"polluted": "yes"}}}'), { env: { A: "1" } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(merged.env)).toBe(Object.prototype);
  });
});
