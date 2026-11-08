import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { endpointConnectionSchema } from "../engine-endpoints.ts";
import { buildCodexEndpointCatalog } from "./codex-endpoint-catalog.ts";
import { compileEndpointLaunch, prepareEndpointFiles } from "./endpoint-launch.ts";

function codexFixture() {
  return {
    version: 1, revision: 1, runtime: "codex", protocol: "responses", provider: "custom",
    baseUrl: "https://example.test/v1", catalog: { default: "main", options: [
      { id: "main", label: "Main", source: "configured", contextWindow: 10000,
        inputModalities: ["text", "image"], effortLevels: ["high"], nativeSearch: "supported" },
      { id: "small", label: "Small", source: "configured",
        inputModalities: ["text"], effortLevels: [], nativeSearch: "unknown" },
    ] }, backgroundModel: "small", defaultEffort: "high", webSearch: "disabled",
  };
}
describe("Codex endpoint native catalog", () => {
  it("generates controlled native metadata for each configured model", () => {
    const endpoint = endpointConnectionSchema.parse(codexFixture());
    if (endpoint.runtime !== "codex") throw new Error("fixture runtime");
    const result = buildCodexEndpointCatalog(endpoint, { cliVersion: "0.167.0", supportedEffortLevels: ["high"] });
    expect(result.models).toHaveLength(2);
    expect(result.models[0]).toMatchObject({
      slug: "main", display_name: "Main", context_window: 10000, input_modalities: ["text", "image"],
      supported_reasoning_levels: [{ effort: "high" }], default_reasoning_level: "high",
      shell_type: "unified_exec", apply_patch_tool_type: null, visibility: "list",
    });
    expect(result.models[1].supported_reasoning_levels).toEqual([]);
    expect(result.models[1].default_reasoning_level).toBeUndefined();
    expect(result.models[0].base_instructions).toBeTruthy();
  });
  it("never forwards arbitrary catalog fields or unconfirmed effort", () => {
    const raw = codexFixture();
    Object.assign(raw.catalog.options[0], { base_instructions: "MALICIOUS", experimental_bearer_token: "SECRET" });
    expect(endpointConnectionSchema.safeParse(raw).success).toBe(false);
    const endpoint = endpointConnectionSchema.parse(codexFixture());
    if (endpoint.runtime !== "codex") throw new Error("fixture runtime");
    const result = buildCodexEndpointCatalog(endpoint);
    expect(result.models[0].supported_reasoning_levels).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("MALICIOUS");
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
  it("rejects an explicitly unqualified CLI version", () => {
    const endpoint = endpointConnectionSchema.parse(codexFixture());
    if (endpoint.runtime !== "codex") throw new Error("fixture runtime");
    expect(() => buildCodexEndpointCatalog(endpoint, { cliVersion: "0.1.0" })).toThrow();
  });
  it.runIf(Boolean(process.env.OMB_NATIVE_CODEX_CLI))("loads the generated catalog in native Codex 0.167.0", async () => {
    const cli = process.env.OMB_NATIVE_CODEX_CLI;
    if (!cli) throw new Error("Native Codex CLI path is required");
    const dataDir = await mkdtemp(join(tmpdir(), "omb-native-endpoint-"));
    try {
      const endpoint = endpointConnectionSchema.parse({ ...codexFixture(), baseUrl: "http://127.0.0.1:1/v1" });
      const input = { dataDir, instanceId: "native-fixture", endpoint, apiKey: "native-fixture-secret",
        model: "main", purpose: "check", cliVersion: "0.167.0", supportedEffortLevels: ["high"] } satisfies Parameters<typeof compileEndpointLaunch>[0];
      await prepareEndpointFiles(input);
      const launch = compileEndpointLaunch(input);
      if (launch.runtime !== "codex") throw new Error("Expected Codex launch");
      const child = spawn(cli, ["app-server", ...launch.providerArgs], {
        cwd: dataDir, env: { ...launch.env, HOME: dataDir, USERPROFILE: dataDir, XDG_CONFIG_HOME: dataDir, RUST_LOG: "error" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      try {
        const result = await new Promise<unknown>((resolve, reject) => {
          let buffer = "", errors = "";
          const timer = setTimeout(() => reject(new Error(`Native catalog timed out: ${errors}`)), 15000);
          const finish = (error: Error | null, value?: unknown) => {
            clearTimeout(timer);
            if (error) reject(error); else resolve(value);
          };
          child.on("error", (error) => finish(error));
          child.once("exit", (code) => finish(new Error(`Native Codex exited ${code}: ${errors}`)));
          child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
          child.stdout.on("data", (chunk: Buffer) => {
            buffer += chunk.toString();
            let index;
            while ((index = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, index);
              buffer = buffer.slice(index + 1);
              if (!line.trim()) continue;
              try {
                const message = z.object({ id: z.number().optional(), result: z.unknown().optional(),
                  error: z.unknown().optional() }).parse(JSON.parse(line));
                if (message.error) { finish(new Error(JSON.stringify(message.error))); return; }
                if (message.id === 1) {
                  child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
                  child.stdin.write(`${JSON.stringify({ id: 2, method: "model/list", params: { limit: 100 } })}\n`);
                } else if (message.id === 2) finish(null, message.result);
              } catch (error) { finish(error instanceof Error ? error : new Error("Invalid native response")); }
            }
          });
          child.stdin.write(`${JSON.stringify({ id: 1, method: "initialize",
            params: { clientInfo: { name: "omb_endpoint_test", version: "1.0" } } })}\n`);
        });
        const catalog = z.object({ data: z.array(z.object({
          id: z.string(), inputModalities: z.array(z.string()),
          supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })),
        })) }).parse(result);
        expect(catalog.data.map((model) => model.id)).toEqual(["main", "small"]);
        expect(catalog.data[0].inputModalities).toEqual(["text", "image"]);
        expect(catalog.data[0].supportedReasoningEfforts).toEqual([{ reasoningEffort: "high" }]);
        expect(catalog.data[1].supportedReasoningEfforts).toEqual([]);
      } finally {
        child.kill("SIGTERM");
        await closed;
      }
    } finally { await rm(dataDir, { recursive: true, force: true }); }
  }, 25000);
});
