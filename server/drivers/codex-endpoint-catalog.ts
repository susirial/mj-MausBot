import type { EffortLevel } from "../../shared/wire.ts";
import type { EndpointConnection } from "../engine-endpoints.ts";

export interface CodexEndpointCatalogOptions {
  cliVersion?: string;
  supportedEffortLevels?: readonly EffortLevel[];
}

// Codex 0.167.0 ModelsResponse requires an instruction template. Never take it from endpoint input.
const BASE_INSTRUCTIONS = "You are a helpful assistant. Use the provided tools to complete the user's request. Follow the user's instructions and report results accurately.";

export function buildCodexEndpointCatalog(endpoint: Extract<EndpointConnection, { runtime: "codex" }>,
  options: CodexEndpointCatalogOptions = {}) {
  if (options.cliVersion !== undefined && !/^(?:codex-cli )?0\.167\.0$/.test(options.cliVersion.trim())) {
    throw new Error("Endpoint model catalog is qualified only for Codex 0.167.0");
  }
  return {
    models: endpoint.catalog.options.map((model, priority) => {
      const efforts = model.effortLevels.filter((effort) => options.supportedEffortLevels?.includes(effort));
      const defaultEffort = endpoint.defaultEffort && efforts.includes(endpoint.defaultEffort) ? endpoint.defaultEffort : undefined;
      return {
        slug: model.id, display_name: model.label, description: model.label,
        ...(defaultEffort !== undefined ? { default_reasoning_level: defaultEffort } : {}),
        supported_reasoning_levels: efforts.map((effort) => ({ effort, description: effort })),
        shell_type: "unified_exec", visibility: "list", supported_in_api: true, priority,
        availability_nux: null, upgrade: null,
        base_instructions: BASE_INSTRUCTIONS,
        support_verbosity: false, default_verbosity: null,
        apply_patch_tool_type: null,
        truncation_policy: { mode: "tokens", limit: 10000 },
        ...(model.contextWindow !== undefined ? { context_window: model.contextWindow, max_context_window: model.contextWindow } : {}),
        input_modalities: [...model.inputModalities],
        experimental_supported_tools: [],
        supports_reasoning_summary_parameter: false,
        supports_search_tool: model.nativeSearch === "supported",
      };
    }),
  };
}
export type CodexEndpointCatalog = ReturnType<typeof buildCodexEndpointCatalog>;
