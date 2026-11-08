import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { parseToml } from "../toml-lite.ts";

export type FixtureFailure = "answer" | "401" | "model404" | "429" | "timeout" | "no-tool" | "no-echo";
const runtimeSchema = z.enum(["claude", "codex"]);
const requestSchema = z.object({
  model: z.string().min(1),
  tools: z.array(z.unknown()).optional(),
  messages: z.array(z.unknown()).optional(),
  input: z.union([z.string(), z.array(z.unknown())]).optional(),
}).passthrough();
const textSchema = z.object({ type: z.enum(["text", "output_text"]), text: z.string() });
const toolSchema = z.object({ type: z.literal("tool_use"), id: z.string(), name: z.literal("echo"), input: z.object({}) });
const functionSchema = z.object({ type: z.literal("function_call"), call_id: z.string(), name: z.literal("echo"), arguments: z.string() });
const responseSchema = z.object({
  model: z.string(),
  content: z.array(z.union([textSchema, toolSchema])).optional(),
  output: z.array(z.union([functionSchema, z.object({ type: z.literal("message"), content: z.array(textSchema) })])).optional(),
});
const mountSchema = z.object({ command: z.string(), args: z.array(z.string()).default([]), env: z.record(z.string(), z.string()).default({}), alwaysLoad: z.boolean().optional() });
type Mount = z.infer<typeof mountSchema>;
export interface EndpointReceipt {
  connection: string;
  instanceId: string;
  runtime: z.infer<typeof runtimeSchema>;
  model: string;
  purpose: string;
  path: string;
  home: string;
  session: string;
  authorized: boolean;
  status: number;
  body: z.infer<typeof requestSchema>;
}

export async function startFakeEngineEndpoint() {
  const connections = new Map<string, { key: string; runtime: z.infer<typeof runtimeSchema>; mode: FixtureFailure }>();
  const requests: EndpointReceipt[] = [];
  const server = createServer(async (req, res) => {
    const match = /^\/([\w-]+)\/v1\/(responses|messages)$/.exec(req.url ?? "");
    const connection = match ? connections.get(match[1]) : undefined;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST" || !match || !connection) return send(404, { error: { message: "Unknown synthetic connection" } });
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 2_000_000) return send(413, { error: { message: "Synthetic request too large" } });
    }
    const parsed = requestSchema.safeParse((() => { try { return JSON.parse(raw); } catch { return null; } })());
    if (!parsed.success) return send(400, { error: { message: "Invalid synthetic request" } });
    const authorized = req.headers.authorization === `Bearer ${connection.key}` || req.headers["x-api-key"] === connection.key;
    const status = !authorized || connection.mode === "401" ? 401
      : connection.mode === "model404" ? 404 : connection.mode === "429" ? 429
      : connection.mode === "timeout" ? 0 : 200;
    const body = requestSchema.parse(JSON.parse(JSON.stringify(parsed.data).replaceAll(connection.key, "[REDACTED]")));
    requests.push({
      connection: match[1], instanceId: String(req.headers["x-fixture-instance"] ?? ""),
      runtime: connection.runtime, model: body.model, body, status, authorized,
      purpose: String(req.headers["x-fixture-purpose"] ?? "unknown"),
      path: req.url ?? "", home: String(req.headers["x-fixture-home"] ?? ""), session: String(req.headers["x-fixture-session"] ?? ""),
    });
    if ((match[2] === "responses") !== (connection.runtime === "codex")) return send(400, { error: { message: "Wrong endpoint protocol" } });
    if (status === 0) return;
    if (status !== 200) return send(status, { error: {
      type: status === 404 ? "model_not_found" : status === 429 ? "rate_limit_error" : "authentication_error",
      message: status === 404 ? "model_not_found: synthetic model unavailable" : status === 429 ? "synthetic rate limit" : "synthetic credentials rejected",
    } });
    const input = JSON.stringify(body.messages ?? body.input ?? "");
    const hasResult = /tool_result|function_call_output/.test(input);
    const wantsTool = Boolean(body.tools?.length) && !hasResult && connection.mode !== "no-tool";
    const id = "fixture-echo-call";
    const text = hasResult ? connection.mode === "no-echo" ? "Finished without echoing the result" : extractToolText(body.messages ?? body.input) : `endpoint answer ${match[1]} ${body.model}`;
    if (connection.runtime === "claude") return send(200, {
      id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: body.model,
      content: wantsTool ? [{ type: "tool_use", id, name: "echo", input: {} }] : [{ type: "text", text }],
      stop_reason: wantsTool ? "tool_use" : "end_turn", usage: { input_tokens: 10, output_tokens: 5 },
    });
    return send(200, {
      id: `resp_${randomUUID()}`, object: "response", status: "completed", model: body.model,
      output: wantsTool ? [{ type: "function_call", call_id: id, name: "echo", arguments: "{}" }]
        : [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a loopback port");
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url, requests,
    register(connection: string, runtime: z.infer<typeof runtimeSchema>, key: string) {
      if (!/^[\w-]+$/.test(connection) || !key.startsWith("fixture-only-")) throw new Error("Synthetic connection and key required");
      connections.set(connection, { runtime, key, mode: "answer" });
      return `${url}/${connection}/v1`;
    },
    mode(connection: string, mode: FixtureFailure) {
      const entry = connections.get(connection);
      if (!entry) throw new Error("Unknown synthetic connection");
      entry.mode = mode;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

function extractToolText(input: unknown): string {
  const blocks = z.array(z.object({
    type: z.string().optional(), output: z.string().optional(),
    content: z.union([z.string(), z.array(z.unknown())]).optional(),
  }).passthrough()).safeParse(input);
  if (!blocks.success) return "";
  for (const block of blocks.data) {
    if (block.type === "function_call_output" && block.output) return block.output;
    if (Array.isArray(block.content)) {
      const nested = z.array(z.object({ type: z.string(), content: z.string().optional() }).passthrough()).safeParse(block.content);
      const result = nested.success ? nested.data.find(item => item.type === "tool_result") : undefined;
      if (result?.content) return result.content;
    }
  }
  return "";
}

function codexOverrides(): Map<string, unknown> {
  const values = new Map<string, unknown>();
  for (let index = 2; index < process.argv.length; index++) {
    if (process.argv[index - 1] !== "-c") continue;
    const arg = process.argv[index], separator = arg.indexOf("=");
    if (separator < 0) continue;
    const value: unknown = parseToml(`value = ${arg.slice(separator + 1)}`).value;
    values.set(arg.slice(0, separator), value);
  }
  return values;
}

async function callMcp(mount: Mount, name: string, args: object): Promise<string> {
  const child = spawn(mount.command, mount.args, {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...mount.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const frames = createInterface({ input: child.stdout });
  const failure = () => { for (const entry of pending.values()) entry.reject(new Error("Tool protocol process exited")); };
  child.on("error", failure);
  child.on("exit", failure);
  frames.on("line", line => {
    const frame = z.object({ id: z.number().optional(), result: z.unknown().optional(), error: z.unknown().optional() }).safeParse(JSON.parse(line));
    if (!frame.success || frame.data.id === undefined) return;
    const entry = pending.get(frame.data.id);
    if (!entry) return;
    pending.delete(frame.data.id);
    if (frame.data.error) entry.reject(new Error("Tool protocol RPC rejected"));
    else entry.resolve(frame.data.result);
  });
  let id = 0;
  const rpc = (method: string, params: object) => new Promise<unknown>((resolve, reject) => {
    id += 1;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const timer = setTimeout(failure, 5_000);
  try {
    await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "endpoint-fixture", version: "1" } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const tools = z.object({ tools: z.array(z.object({ name: z.string() }).passthrough()) }).parse(await rpc("tools/list", {}));
    if (!tools.tools.some(tool => tool.name === name)) throw new Error(`Tool protocol ${name} unavailable`);
    const result = z.object({ isError: z.boolean().optional(), content: z.array(textSchema) }).parse(await rpc("tools/call", { name, arguments: args }));
    if (result.isError) throw new Error("Tool protocol echo failed");
    return result.content.map(item => item.text).join("");
  } finally {
    clearTimeout(timer);
    frames.close();
    const exited = new Promise<void>(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("exit", () => resolve()));
    child.kill();
    await exited;
  }
}

export async function runFakeEndpointCli(runtime: z.infer<typeof runtimeSchema>): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (name: string) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
  const overrides = runtime === "codex" ? codexOverrides() : new Map<string, unknown>();
  const mcpConfig: Record<string, Record<string, unknown>> = {};
  for (const [name, value] of overrides) {
    const match = /^mcp_servers\.([^.]+)\.([^.]+)$/.exec(name);
    if (match) (mcpConfig[match[1]] ??= {})[match[2]] = value;
  }
  const provider = z.string().parse(overrides.get("model_provider") ?? "omb_endpoint");
  const baseUrl = z.string().parse(runtime === "claude" ? process.env.ANTHROPIC_BASE_URL : overrides.get(`model_providers.${provider}.base_url`));
  const endpoint = new URL(baseUrl);
  // Opt-in fixtures cannot contact a vendor even if production routing regresses.
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("Endpoint fixture refuses non-loopback routing");
  }
  const keyName = runtime === "codex" ? z.string().parse(overrides.get(`model_providers.${provider}.env_key`)) : "ANTHROPIC_AUTH_TOKEN";
  const key = z.string().startsWith("fixture-only-").parse(process.env[keyName]);
  let model = arg("--model") ?? process.env.ANTHROPIC_MODEL ?? "";
  let threadId = arg("--resume") ?? arg("--session-id") ?? `fixture-thread-${randomUUID()}`;
  let turnId = "";
  const home = (runtime === "codex" ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR) ?? "";
  const toolMode = process.env.FAKE_ENDPOINT_TOOL_MODE;
  const rollout = runtime === "codex" && toolMode === "unsupported" ? join(home, "fixture-rollout.jsonl") : undefined;
  if (rollout) writeFileSync(rollout, "", { mode: 0o600 });
  const background = argv[0] === "exec" || ["text", "json"].includes(arg("--output-format") ?? "");
  const mounts = new Map<string, Mount>();
  let permissionMount: Mount | undefined;
  if (runtime === "claude" && arg("--mcp-config")) {
    const config = z.object({ mcpServers: z.record(z.string(), z.unknown()) }).parse(JSON.parse(readFileSync(z.string().parse(arg("--mcp-config")), "utf8")));
    const mount = mountSchema.safeParse(config.mcpServers.endpoint_check);
    if (mount.success) mounts.set("endpoint_check", mount.data);
    const permission = mountSchema.safeParse(config.mcpServers.ogb);
    if (permission.success) permissionMount = permission.data;
  } else if (runtime === "codex") {
    const forwarded = z.array(z.string()).parse(overrides.get("mcp_servers.endpoint_check.env_vars") ?? []);
    const env = Object.fromEntries(forwarded.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]]));
    const mount = mountSchema.safeParse({
      command: overrides.get("mcp_servers.endpoint_check.command"),
      args: overrides.get("mcp_servers.endpoint_check.args"),
      env: { ...env, ...z.record(z.string(), z.string()).parse(overrides.get("mcp_servers.endpoint_check.env") ?? {}) },
    });
    if (mount.success) mounts.set("endpoint_check", mount.data);
  }
  const out = (body: unknown) => process.stdout.write(`${JSON.stringify(body)}\n`);
  const approvals = new Map<string, (value: unknown) => void>();
  const approveEcho = async () => {
    if (runtime === "claude") {
      if (!permissionMount) throw new Error("Tool approval proxy unavailable");
      const response = z.object({ behavior: z.enum(["allow", "deny"]) }).parse(JSON.parse(
        await callMcp(permissionMount, "approve", { tool_name: "mcp__endpoint_check__echo", input: {} }),
      ));
      return response.behavior === "allow";
    }
    const id = `fixture-approval-${randomUUID()}`;
    const response = new Promise<unknown>(resolve => approvals.set(id, resolve));
    out({ jsonrpc: "2.0", id, method: "mcpServer/elicitation/request", params: {
      threadId, turnId, serverName: "endpoint_check", mode: "form",
      _meta: { codex_approval_kind: "mcp_tool_call", tool_params: {} },
      message: 'Allow the endpoint_check MCP server to run tool "echo"?',
      requestedSchema: { type: "object", properties: {} },
    } });
    const result = z.object({ action: z.enum(["accept", "decline", "cancel"]) }).parse(await response);
    return result.action === "accept";
  };
  const request = async (body: z.infer<typeof requestSchema>) => {
    let response: Response;
    try {
      response = await fetch(`${baseUrl.replace(/\/$/, "")}/${runtime === "codex" ? "responses" : "messages"}`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}`,
          "x-fixture-home": home, "x-fixture-session": threadId, "x-fixture-instance": process.env.OPENMAUSBOT_ENDPOINT_INSTANCE_ID ?? "",
          "x-fixture-purpose": background ? "background" : mounts.has("endpoint_check") ? "tools" : "answer" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(2_500),
      });
    } catch { throw new Error("Endpoint connection timed out"); }
    if (!response.ok) throw new Error(`Endpoint HTTP ${response.status} ${response.status === 404 ? "model_not_found" : response.status === 429 ? "rate limit" : "credentials rejected"}`);
    return responseSchema.parse(await response.json());
  };
  const turn = async (prompt: string): Promise<string> => {
    const mounted = mounts.get("endpoint_check");
    const tool = toolMode === "startup-failed" || runtime === "claude" && mounted?.alwaysLoad !== true ? undefined : mounted;
    const first = await request(runtime === "claude"
      ? { model, max_tokens: 128, messages: [{ role: "user", content: prompt }], ...(tool ? { tools: [{ name: "echo", description: "Synthetic echo", input_schema: { type: "object" } }] } : {}) }
      : { model, input: prompt, ...(tool ? { tools: [{ type: "function", name: "echo", parameters: { type: "object" } }] } : {}) });
    let reply = first;
    if (first.content?.some(item => item.type === "tool_use") || first.output?.some(item => item.type === "function_call")) {
      if (!tool) throw new Error("Tool protocol unconfigured");
      if (rollout) {
        appendFileSync(rollout, `${JSON.stringify({ type: "response_item", payload: {
          type: "function_call_output", call_id: "fixture-echo-call", output: "unsupported call: echo",
        } })}\n`);
        return "The tool could not be routed.";
      }
      if (!(await approveEcho())) throw new Error("Tool protocol approval denied");
      const content = await callMcp(tool, "echo", {});
      if (runtime === "claude") {
        out({ type: "assistant", session_id: threadId, message: { model, content: first.content } });
        out({ type: "user", session_id: threadId, message: { content: [{ type: "tool_result", tool_use_id: "fixture-echo-call", content }] } });
      } else {
        out({ jsonrpc: "2.0", method: "item/completed", params: { threadId, turnId,
          item: { id: "fixture-echo-call", type: "mcpToolCall", server: "endpoint_check", tool: "echo", arguments: {}, status: "completed", result: { content: [{ type: "text", text: content }] } } } });
      }
      reply = await request(runtime === "claude"
        ? { model, max_tokens: 128, messages: [{ role: "assistant", content: first.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: "fixture-echo-call", content }] }] }
        : { model, input: [{ type: "function_call_output", call_id: "fixture-echo-call", output: content }] });
    }
    return runtime === "claude" ? (reply.content ?? []).flatMap(item => item.type === "text" || item.type === "output_text" ? [item.text] : []).join("")
      : (reply.output ?? []).flatMap(item => item.type === "message" ? item.content.map(block => block.text) : []).join("");
  };
  if (background) {
    let prompt = "";
    for await (const chunk of process.stdin) prompt += chunk;
    try {
      const text = await turn(prompt);
      if (runtime === "claude") {
        if (arg("--output-format") === "text") process.stdout.write(text);
        else out({ type: "result", subtype: "success", is_error: false, result: text, modelUsage: { [model]: { inputTokens: 10, outputTokens: 5 } } });
      } else {
        out({ type: "thread.started", thread_id: threadId });
        out({ type: "item.completed", item: { id: "answer", type: "agent_message", text } });
        out({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Endpoint protocol failure";
      if (runtime === "claude") out({ type: "result", is_error: true, result: message });
      else out({ type: "turn.failed", error: { message } });
      process.exitCode = 1;
    }
    return;
  }
  const frameSchema = z.object({ id: z.union([z.number(), z.string()]).optional(), method: z.string().optional(),
    type: z.string().optional(), params: z.record(z.string(), z.unknown()).optional(), message: z.unknown().optional() }).passthrough();
  const lines = createInterface({ input: process.stdin });
  let active: Promise<void> | undefined;
  const notify = (method: string, params: object) => out({ jsonrpc: "2.0", method, params: { threadId, turnId, ...params } });
  const start = (prompt: string) => {
    active = (async () => {
      if (runtime === "claude") out({ type: "system", subtype: "init", session_id: threadId, model, tools: [...mounts.keys()].map(name => `mcp__${name}__echo`), mcp_servers: [...mounts.keys()].map(name => ({ name, status: toolMode === "startup-failed" ? "failed" : "connected" })) });
      try {
        const text = await turn(prompt);
        if (runtime === "claude") {
          out({ type: "assistant", session_id: threadId, message: { model, content: [{ type: "text", text }], stop_reason: "end_turn" } });
          out({ type: "result", subtype: "success", is_error: false, result: text, session_id: threadId, usage: { input_tokens: 10, output_tokens: 5 } });
        } else {
          notify("item/completed", { item: { id: "answer", type: "agentMessage", text } });
          notify("turn/completed", { turn: { id: turnId, status: "completed" } });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Endpoint protocol failure";
        if (runtime === "claude") {
          out({ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: message }] }, error: "unknown", is_api_error_message: true });
          out({ type: "result", subtype: "success", is_error: true, result: message, terminal_reason: "api_error" });
        } else {
          notify("error", { error: { message }, willRetry: false });
          notify("turn/completed", { turn: { id: turnId, status: "failed", error: { message } } });
        }
      }
    })();
  };
  for await (const line of lines) {
    const frame = frameSchema.parse(JSON.parse(line));
    const approval = frame.id === undefined ? undefined : approvals.get(String(frame.id));
    if (approval) {
      approvals.delete(String(frame.id));
      approval(frame.result);
      continue;
    }
    const result = (value: unknown) => out({ jsonrpc: "2.0", id: frame.id, result: value });
    if (runtime === "claude") {
      if (frame.type !== "user") continue;
      const message = z.object({ content: z.union([z.string(), z.array(z.unknown())]) }).parse(frame.message);
      start(typeof message.content === "string" ? message.content : JSON.stringify(message.content));
      continue;
    }
    const params = frame.params ?? {};
    switch (frame.method) {
      case "initialize": result({ userAgent: "codex_cli_rs/0.166.0" }); break;
      case "account/read": result({ account: null, requiresOpenaiAuth: false }); break;
      case "model/list": result({ data: [{ id: model || "fixture-model", displayName: model || "Fixture model", isDefault: true, hidden: false }], nextCursor: null }); break;
      case "config/read": result({ config: { approval_policy: "never", sandbox_mode: "read-only", shell_environment_policy: { include_only: null, exclude: [], inherit: "all", ignore_default_excludes: false }, features: { shell_snapshot: overrides.get("features.shell_snapshot") }, mcp_servers: mcpConfig }, origins: {} }); break;
      case "thread/start":
      case "thread/resume":
        model = z.string().parse(params.model);
        threadId = typeof params.threadId === "string" ? params.threadId : `fixture-thread-${randomUUID()}`;
        result({ thread: { id: threadId, ...(rollout ? { path: rollout } : {}) }, model, sandbox: params.sandbox === "danger-full-access"
          ? { type: "dangerFullAccess" } : params.sandbox === "workspace-write"
            ? { type: "workspaceWrite", networkAccess: false, writableRoots: [], excludeTmpdirEnvVar: false, excludeSlashTmp: false }
            : { type: "readOnly" } });
        for (const name of Object.keys(mcpConfig)) {
          if (mcpConfig[name].enabled !== false) out({ jsonrpc: "2.0", method: "mcpServer/startupStatus/updated",
            params: { threadId: null, name, status: toolMode === "startup-failed" ? "failed" : "ready", error: null, failureReason: null } });
        }
        break;
      case "turn/start":
        if (typeof params.model === "string") model = params.model;
        turnId = `fixture-turn-${randomUUID()}`;
        result({ turn: { id: turnId, status: "inProgress" } });
        notify("turn/started", { turn: { id: turnId, status: "inProgress" } });
        start(JSON.stringify(params.input));
        break;
      case "turn/interrupt": result({}); break;
      default: if (frame.id !== undefined) result({});
    }
  }
  for (const resolve of approvals.values()) resolve({ action: "decline" });
  await active;
}
