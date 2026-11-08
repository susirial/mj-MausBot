import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { startFakeEngineEndpoint, type FixtureFailure } from "./fake-engine-endpoint.ts";

it.each(["claude", "codex"])("%s background fixture sends a real loopback request", async runtime => {
  const requests: unknown[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(runtime === "claude"
      ? { type: "message", model: "fixture-model", content: [{ type: "text", text: "HTTP fixture answer" }] }
      : { object: "response", model: "fixture-model", output: [{ type: "message", content: [{ type: "output_text", text: "HTTP fixture answer" }] }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected loopback port");
  const baseUrl = `http://127.0.0.1:${address.port}/instance/v1`;
  const path = fileURLToPath(new URL(runtime === "claude" ? "./fake-claude-cli.ts" : "./fake-codex-app-server.ts", import.meta.url));
  const args = runtime === "claude"
    ? ["--print", "--output-format", "json", "--model", "fixture-model"]
    : ["exec", "--json", "--model", "fixture-model", "-c", 'model_provider="omb_endpoint"',
      "-c", `model_providers.omb_endpoint.base_url=${JSON.stringify(baseUrl)}`,
      "-c", 'model_providers.omb_endpoint.env_key="OPENMAUSBOT_ENDPOINT_API_KEY"', "-"];
  const child = spawn(process.execPath, ["--experimental-strip-types", path, ...args], {
    env: { ...process.env, FAKE_CLAUDE_ENDPOINT: "1", FAKE_CODEX_ENDPOINT: "1",
      ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: "fixture-only-test",
      OPENMAUSBOT_ENDPOINT_API_KEY: "fixture-only-test" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "", error = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { error += chunk; });
  child.stdin.end("Reply from the endpoint");
  try {
    const [code] = await once(child, "exit");
    expect(code, error).toBe(0);
    expect(requests).toEqual([expect.objectContaining({ model: "fixture-model" })]);
    expect(output).toContain("HTTP fixture answer");
    expect(output + error).not.toContain("fixture-only-test");
  } finally {
    child.kill();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 15_000);

it.each(["claude", "codex"] as const)("%s service validates auth, models, quota, timeout, and a tool result", async runtime => {
  const service = await startFakeEngineEndpoint();
  const key = "fixture-only-service-test";
  const base = service.register("connection", runtime, key);
  const url = `${base}/${runtime === "claude" ? "messages" : "responses"}`;
  const request = (body: object, token = key, signal?: AbortSignal) => fetch(url, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: "fixture-model", ...body }), signal,
  });
  try {
    expect((await request({}, "fixture-only-wrong")).status).toBe(401);
    for (const [mode, status] of [["401", 401], ["model404", 404], ["429", 429]] satisfies Array<[FixtureFailure, number]>) {
      service.mode("connection", mode);
      expect((await request({})).status).toBe(status);
    }
    service.mode("connection", "timeout");
    await expect(request({}, key, AbortSignal.timeout(50))).rejects.toThrow();
    service.mode("connection", "answer");
    const first: unknown = await (await request({ tools: [{ name: "echo" }] })).json();
    expect(JSON.stringify(first)).toContain(runtime === "claude" ? "tool_use" : "function_call");
    const final: unknown = await (await request(runtime === "claude"
      ? { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "fixture-echo-call", content: "real-echo-result" }] }] }
      : { input: [{ type: "function_call_output", call_id: "fixture-echo-call", output: "real-echo-result" }] })).json();
    expect(JSON.stringify(final)).toContain("real-echo-result");
    expect(service.requests).toHaveLength(7);
    expect(JSON.stringify(service.requests)).not.toContain(key);
  } finally { await service.close(); }
});
