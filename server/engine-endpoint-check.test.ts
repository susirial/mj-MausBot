import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { newEventId } from "./contracts.ts";
import { makeFakeDriver } from "./testing/fake-driver.ts";
import { checkEngineEndpoint, endpointCheckFailure } from "./engine-endpoint-check.ts";
import { assertToolScopeSupported } from "../shared/tool-scope-support.ts";
import type { SendTurnInput } from "./contracts.ts";
import type { RuntimeEvent } from "./contracts.ts";

beforeEach(() => { vi.spyOn(console, "info").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

async function toolCheck(options: {
  tool?: string; server?: string; echo?: boolean; receipt?: "wrong" | "missing";
  requestType?: "permission" | "question"; origin?: "tool" | "output"; requiresExplicitApproval?: boolean;
  outcome?: "unavailable" | "rejected" | "throw";
  termination?: "timeout" | "reject";
  events?: Array<(base: RuntimeEvent["threadId"]) => RuntimeEvent>;
} = {}) {
  const fake = makeFakeDriver();
  const instance = await fake.driver.create({ instanceId: "a", config: {}, environment: {}, enabled: true, displayName: "Endpoint" });
  const decisions: string[] = [];
  let toolRan = false;
  let input: SendTurnInput | undefined;
  Object.assign(instance.adapter, {
    closeSession: async () => {},
    respondToRequest: async (_threadId: string, _requestId: string, response: { behavior: string }) => {
      decisions.push(response.behavior);
      if (options.outcome === "throw") throw new Error("Approval unavailable");
      return options.outcome ?? (response.behavior === "allow" ? "allowed-once" : "rejected");
    },
    sendTurn: async (turn: SendTurnInput) => {
      input = turn;
      const emit = fake.created.get("a")!.emit;
      const base = { eventId: newEventId(), provider: "fake", threadId: turn.threadId, createdAt: new Date().toISOString() };
      for (const event of options.events ?? []) emit(event(turn.threadId));
      emit({ ...base, type: "request.opened", requestId: "echo", requestType: options.requestType ?? "permission",
        tool: options.tool ?? "echo", summary: "Synthetic MCP approval",
        origin: options.origin, requiresExplicitApproval: options.requiresExplicitApproval,
        ...(options.server ? { toolIdentity: { kind: "mcp", server: options.server, name: "echo" } } : {}) });
      await Promise.resolve();
      const spec = turn.integrations?.custom?.endpoint_check;
      if (!spec || !("command" in spec)) throw new Error("Missing echo mount");
      if (decisions.at(-1) === "allow" && options.receipt !== "missing" && !options.outcome) {
        const child = spawnSync(spec.command, spec.args, {
          env: { ...process.env, ...spec.env, ...(options.receipt === "wrong" ? { OPENMAUSBOT_CHECK_NONCE: "wrong-nonce" } : {}) },
          input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: {} } })}\n`,
          encoding: "utf8", timeout: 5_000,
        });
        expect(child.status, child.stderr).toBe(0);
        toolRan = existsSync(spec.env.OPENMAUSBOT_CHECK_RECEIPT);
        expect(readFileSync(spec.env.OPENMAUSBOT_CHECK_RECEIPT, "utf8")).toBe(options.receipt === "wrong" ? "wrong-nonce" : spec.env.OPENMAUSBOT_CHECK_NONCE);
      }
      emit({ ...base, type: "item.completed", itemType: "assistant_text",
        text: options.echo !== false && toolRan ? spec.env.OPENMAUSBOT_CHECK_NONCE : "Finished" });
      if (options.termination === "reject") throw new Error("Synthetic turn rejection.");
      if (options.termination !== "timeout") emit({ ...base, type: "turn.completed", ok: true });
      return { turnId: "check" };
    },
  });
  try {
    const result = await checkEngineEndpoint({ instance, revision: 1, model: "model-b", kind: "tools",
      ...(options.termination === "timeout" ? { timeoutMs: 1_000 } : {}) });
    return { result, decisions, toolRan, input };
  } finally { await instance.dispose(); }
}

it.each([
  ["401 Unauthorized", "credentials"], ["model_not_found", "model"],
  ["429 quota exceeded", "rate_limit"], ["timed out", "timeout"], ["unsupported tool protocol", "protocol"],
  ["404 /v1/responses", "protocol"],
])("classifies %s without asking for an official sign-in", (message, reason) => {
  expect(endpointCheckFailure(message)).toBe(reason);
});

it("checks the selected main model through a fresh turn", async () => {
  const fake = makeFakeDriver();
  const instance = await fake.driver.create({ instanceId: "a", config: {}, environment: {}, enabled: true, displayName: "Endpoint" });
  let selected: string | undefined;
  let closed = false;
  Object.assign(instance.adapter, { closeSession: async () => { closed = true; } });
  Object.assign(instance.adapter, { sendTurn: async (input: SendTurnInput) => {
    assertToolScopeSupported("codex", input.toolScope);
    assertToolScopeSupported("claudeAgent", input.toolScope);
    selected = input.model;
    const base = { eventId: newEventId(), provider: "fake", threadId: input.threadId, createdAt: new Date().toISOString() };
    const emit = fake.created.get("a")?.emit;
    emit?.({ ...base, type: "item.completed", itemType: "assistant_text", text: "OK" });
    emit?.({ ...base, type: "turn.completed", ok: true });
    return { turnId: "check" };
  } });
  expect(await checkEngineEndpoint({ instance, revision: 1, model: "model-b", kind: "answer" })).toMatchObject({ state: "passed", model: "model-b" });
  expect(selected).toBe("model-b");
  expect(closed).toBe(true);
  await instance.dispose();
});

it("does not claim tool verification when the model only answers", async () => {
  const fake = makeFakeDriver();
  const instance = await fake.driver.create({ instanceId: "a", config: {}, environment: {}, enabled: true, displayName: "Endpoint" });
  Object.assign(instance.adapter, { sendTurn: async (input: SendTurnInput) => {
    assertToolScopeSupported("codex", input.toolScope);
    assertToolScopeSupported("claudeAgent", input.toolScope);
    fake.created.get("a")?.emit({ eventId: newEventId(), provider: "fake", threadId: input.threadId, createdAt: new Date().toISOString(), type: "turn.completed", ok: true });
    return { turnId: "check" };
  } });
  expect(await checkEngineEndpoint({ instance, revision: 1, model: "model-b", kind: "tools" })).toMatchObject({ state: "failed", reason: "other", code: "tool_not_called" });
  await instance.dispose();
});

it("allows Codex's bare echo only when the driver identifies the check server", async () => {
  const { result, decisions, toolRan } = await toolCheck({ server: "endpoint_check" });
  expect(decisions).toEqual(["allow"]);
  expect(toolRan).toBe(true);
  expect(result).toMatchObject({ state: "passed", kind: "tools" });
});

it.each([
  { tool: "echo" },
  { tool: "echo", server: "unrelated" },
  { tool: "mcp__endpoint_check__echo", server: "unrelated" },
  { tool: "mcp__endpoint_check__echo" },
])("denies tools without the check server identity %j", async options => {
  const { result, decisions, toolRan } = await toolCheck(options);
  expect(decisions).toEqual(["deny"]);
  expect(toolRan).toBe(false);
  expect(result).toMatchObject({ state: "failed", code: "tool_denied" });
});

it.each(["mcp__endpoint_check__echo", "endpoint_check.echo"])("accepts a qualified check name %s", async tool => {
  expect((await toolCheck({ tool, server: "endpoint_check" })).result.state).toBe("passed");
});

it.each([
  [{ receipt: "missing" }, "tool_not_called"],
  [{ receipt: "wrong" }, "tool_receipt_mismatch"],
  [{ echo: false }, "tool_answer_missing"],
] as const)("distinguishes incomplete roundtrips %j", async (options, code) => {
  expect((await toolCheck({ tool: "endpoint_check.echo", server: "endpoint_check", ...options })).result).toMatchObject({ state: "failed", code });
});

it("preloads just the check mount for Claude and uses its exposed name", async () => {
  const { input } = await toolCheck({ tool: "mcp__endpoint_check__echo", server: "endpoint_check" });
  expect(input).toMatchObject({ preloadMcpServers: ["endpoint_check"] });
});

it("reports the check MCP startup failure rather than a missing call", async () => {
  const { result } = await toolCheck({ tool: "endpoint_check.echo", server: "endpoint_check", receipt: "missing", events: [
    threadId => ({ eventId: newEventId(), provider: "fake", threadId, createdAt: new Date().toISOString(),
      type: "session.started", sessionId: "check", mcpFailed: ["endpoint_check"] }),
  ] });
  expect(result).toMatchObject({ state: "failed", code: "mcp_startup_failed" });
});

it("reports structured unsupported-call evidence without treating every notice as a failure", async () => {
  const event = (key: string) => (threadId: string): RuntimeEvent => ({
    eventId: newEventId(), provider: "fake", threadId, createdAt: new Date().toISOString(),
    type: "runtime.notice", message: "Synthetic notice", text: { key, params: { tools: "echo" } },
  });
  expect((await toolCheck({ tool: "endpoint_check.echo", server: "endpoint_check", receipt: "missing", events: [event("chat.notice.codexUnsupportedOne")] })).result)
    .toMatchObject({ state: "failed", code: "tool_unsupported" });
  expect((await toolCheck({ tool: "endpoint_check.echo", server: "endpoint_check", events: [event("chat.notice.other")] })).result.state).toBe("passed");
});

it("ignores failures belonging to other check threads or MCP servers", async () => {
  const { result } = await toolCheck({ tool: "endpoint_check.echo", server: "endpoint_check", events: [
    threadId => ({ eventId: newEventId(), provider: "fake", threadId, createdAt: new Date().toISOString(),
      type: "session.started", sessionId: "check", mcpFailed: ["unrelated"] }),
    () => ({ eventId: newEventId(), provider: "fake", threadId: "other", createdAt: new Date().toISOString(),
      type: "runtime.error", message: "401 Unauthorized" }),
  ] });
  expect(result.state).toBe("passed");
});

it.each([
  { requestType: "question" }, { origin: "output" }, { requiresExplicitApproval: true },
] as const)("does not authorize an echo-shaped request outside execution permission %j", async options => {
  const { result, decisions } = await toolCheck({ server: "endpoint_check", ...options });
  expect(decisions).toEqual(["deny"]);
  expect(result).toMatchObject({ state: "failed", code: "tool_denied" });
});

it.each(["unavailable", "rejected", "throw"] as const)("reports a %s approval response", async outcome => {
  expect((await toolCheck({ server: "endpoint_check", outcome })).result).toMatchObject({ state: "failed", code: "tool_approval_failed" });
});

it("logs approval decisions and proof booleans without private receipt or nonce", async () => {
  const { result, input } = await toolCheck({ server: "endpoint_check" });
  const output = vi.mocked(console.info).mock.calls.map(call => String(call[0])).join("\n");
  expect(output).toContain('"decision":"allow"');
  expect(output).toContain('"outcome":"allowed-once"');
  expect(output).toContain('"receipt":"matched"');
  expect(output).toContain('"answerEcho":true');
  const spec = input?.integrations?.custom?.endpoint_check;
  if (!spec || !("command" in spec)) throw new Error("Missing echo mount");
  expect(output).not.toContain(spec.env.OPENMAUSBOT_CHECK_NONCE);
  expect(output).not.toContain(spec.env.OPENMAUSBOT_CHECK_RECEIPT);
  expect(result).toMatchObject({ checkId: expect.stringMatching(/^endpoint-check-/) });
});

it.each(["timeout", "reject"] as const)("retains observed tool proof when the turn ends by %s", async termination => {
  const { result, input } = await toolCheck({ server: "endpoint_check", termination });
  expect(result).toMatchObject({ state: "failed", reason: termination === "timeout" ? "timeout" : "other" });
  const output = vi.mocked(console.info).mock.calls.map(call => String(call[0])).join("\n");
  expect(output).toContain('"receipt":"matched"');
  expect(output).toContain('"answerEcho":true');
  const spec = input?.integrations?.custom?.endpoint_check;
  if (!spec || !("command" in spec)) throw new Error("Missing echo mount");
  expect(existsSync(spec.env.OPENMAUSBOT_CHECK_RECEIPT)).toBe(false);
});
