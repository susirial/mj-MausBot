import type { EndpointModel } from "../shared/engine-endpoint.ts";
import { endpointConnectionSchema, type EndpointConnection } from "./engine-endpoints.ts";

export interface EndpointPreset {
  id: string;
  label: string;
  endpoint: EndpointConnection;
  sources: string[];
}

function model(id: string, label: string, capabilities: Partial<Omit<EndpointModel, "id" | "label" | "source">> = {}): EndpointModel {
  return { id, label, source: "preset", inputModalities: ["text"], effortLevels: [],
    nativeSearch: "unknown", ...capabilities };
}
const deepseekSources = ["https://api-docs.deepseek.com/guides/anthropic_api",
  "2026-11-08-independent-connections-design.md#5"];
const kimiSources = ["https://platform.kimi.com/docs/api/responses.md",
  "2026-11-08-independent-connections-design.md#5"];
const kimiModel = model("kimi-k3.1-pro", "Kimi K3.1 Pro", {
  contextWindow: 1_048_576, inputModalities: ["text", "image"], nativeSearch: "supported",
});
const common = { version: 1, revision: 1 };
// The supplied DeepSeek guide's 786432-token compaction setting treats 1M as 1048576,
// rather than 1000000. This is a preset interpretation, not runtime-confirmed capacity.
const DEEPSEEK_1M_CONTEXT = 1_048_576;

export const endpointPresets: EndpointPreset[] = [
  { id: "codex-deepseek", label: "Codex - DeepSeek", sources: deepseekSources,
    endpoint: endpointConnectionSchema.parse({
      ...common, runtime: "codex", protocol: "responses", provider: "deepseek",
      baseUrl: "https://api.deepseek.com/", backgroundModel: "deepseek-flash", webSearch: "disabled",
      catalog: { default: "deepseek-flash", options: [
        model("deepseek-flash", "DeepSeek Flash"), model("deepseek-v4-pro", "DeepSeek V4 Pro"),
      ] },
    }) },
  { id: "claude-deepseek", label: "Claude Code - DeepSeek", sources: deepseekSources,
    endpoint: endpointConnectionSchema.parse({
      ...common, runtime: "claude", protocol: "anthropic", provider: "deepseek",
      baseUrl: "https://api.deepseek.com/anthropic", backgroundModel: "deepseek-flash",
      roleModels: { opus: "deepseek-v4-pro", sonnet: "deepseek-flash", haiku: "deepseek-flash",
        fable: "deepseek-flash", subagent: "deepseek-flash" },
      catalog: { default: "deepseek-flash[1m]", options: [
        model("deepseek-flash[1m]", "DeepSeek Flash 1M", { contextWindow: DEEPSEEK_1M_CONTEXT }),
        model("deepseek-flash", "DeepSeek Flash"), model("deepseek-v4-pro", "DeepSeek V4 Pro"),
      ] },
    }) },
  { id: "codex-kimi", label: "Codex - Kimi", sources: kimiSources,
    endpoint: endpointConnectionSchema.parse({
      ...common, runtime: "codex", protocol: "responses", provider: "kimi",
      baseUrl: "https://api.moonshot.cn/v1", backgroundModel: "kimi-k3.1-pro", webSearch: "disabled",
      catalog: { default: "kimi-k3.1-pro", options: [kimiModel] },
    }) },
  { id: "claude-kimi", label: "Claude Code - Kimi", sources: kimiSources,
    endpoint: endpointConnectionSchema.parse({
      ...common, runtime: "claude", protocol: "anthropic", provider: "kimi",
      baseUrl: "https://api.moonshot.cn/anthropic", backgroundModel: "kimi-k3.1-pro",
      roleModels: { opus: "kimi-k3.1-pro", sonnet: "kimi-k3.1-pro", haiku: "kimi-k3.1-pro",
        fable: "kimi-k3.1-pro", subagent: "kimi-k3.1-pro" },
      catalog: { default: "kimi-k3.1-pro", options: [kimiModel] },
    }) },
];
