import { expect, it } from "vitest";
import { newEventId } from "./contracts.ts";
import { makeFakeDriver } from "./testing/fake-driver.ts";
import { checkEngineEndpoint, endpointCheckFailure } from "./engine-endpoint-check.ts";
import { assertToolScopeSupported } from "../shared/tool-scope-support.ts";
import type { SendTurnInput } from "./contracts.ts";

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
  expect(await checkEngineEndpoint({ instance, revision: 1, model: "model-b", kind: "tools" })).toMatchObject({ state: "failed", reason: "protocol" });
  await instance.dispose();
});
