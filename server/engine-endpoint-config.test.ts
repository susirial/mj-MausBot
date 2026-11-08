import { expect, it } from "vitest";
import { instanceConfigs, instanceOwnsRouting, stripWorkspaceCredentialEnv, type AppConfig } from "./config.ts";

it("does not inject workspace credentials into an explicitly configured endpoint", () => {
  const entry = { driver: "claudeAgent", config: { endpoint: { version: 1 } }, environment: { OPENMAUSBOT_ENDPOINT_API_KEY: "fixture-private" } };
  const cfg: AppConfig = { anthropic: { key: "fixture-workspace" }, instances: { endpoint: entry } };
  expect(instanceOwnsRouting(cfg, entry)).toBe(true);
  expect(instanceConfigs(cfg).endpoint.environment).toEqual(entry.environment);
  const env = { OPENMAUSBOT_ENDPOINT_API_KEY: "fixture-private", PATH: "/usr/bin" };
  stripWorkspaceCredentialEnv(env);
  expect(env).toEqual({ PATH: "/usr/bin" });
});
