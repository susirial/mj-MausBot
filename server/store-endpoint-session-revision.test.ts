import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { OwnedFile } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { Store, toWireTask, type BotRecord } from "./store.ts";

const selection = () => ({ instanceId: "official", model: "default" });
const endpoint = "endpoint";
const binding = { cursor: "native-session", revision: 1 };
const fixture = () => {
  const store = new Store(selection);
  const bot = store.createBot({}, { seedMessages: false });
  return { store, bot, task: store.activeTask(bot.id)! };
};
const restartTask = (botId: string, threadId: string) => new Store(selection).taskByThread(botId, threadId)!;

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

it("persists cursor and revision together in one write, including revision-only changes", () => {
  const { store, bot, task } = fixture();
  const written: BotRecord[][] = [];
  const original = OwnedFile.prototype.write;
  const write = vi.spyOn(OwnedFile.prototype, "write").mockImplementation(function (this: OwnedFile, text) {
    if (this.path === join(DATA_DIR, "bots.json")) written.push(JSON.parse(text));
    return original.call(this, text);
  });
  store.setEndpointResumeCursor(task.threadId, endpoint, binding);
  store.setEndpointResumeCursor(task.threadId, endpoint, { ...binding, revision: 2 });
  store.setEndpointResumeCursor(task.threadId, endpoint, { ...binding, revision: 2 });
  expect(written).toHaveLength(2);
  for (const [index, rows] of written.entries()) {
    expect(rows.find(row => row.id === bot.id)?.tasks?.[0]).toMatchObject({
      resumeCursors: { [endpoint]: binding.cursor },
      endpointResumeRevisions: { [endpoint]: index + 1 },
    });
  }
  write.mockRestore();
  store.setEndpointResumeCursor(task.threadId, endpoint, { ...binding, revision: 3 });
  expect(restartTask(bot.id, task.threadId)).toMatchObject({
    resumeCursors: { [endpoint]: binding.cursor }, endpointResumeRevisions: { [endpoint]: 3 },
  });
  expect(bot.resumeCursors[endpoint]).toBe(binding.cursor);
});

it("keeps background sessions independent and mirrors only the active cursor", () => {
  const { store, bot, task } = fixture();
  const background = store.createTask(bot.id, "Background", false)!;
  store.setEndpointResumeCursor(task.threadId, endpoint, binding);
  store.setEndpointResumeCursor(background.threadId, endpoint, { cursor: "background", revision: 7 });
  expect(bot.resumeCursors[endpoint]).toBe(binding.cursor);
  expect(restartTask(bot.id, background.threadId)).toMatchObject({
    resumeCursors: { [endpoint]: "background" }, endpointResumeRevisions: { [endpoint]: 7 },
  });
  store.switchTask(bot.id, background.threadId);
  expect(bot.resumeCursors[endpoint]).toBe("background");
  expect(task.endpointResumeRevisions).toEqual({ [endpoint]: 1 });
  store.setEndpointResumeCursor("missing", endpoint, binding);
  expect(bot).not.toHaveProperty("endpointResumeRevisions");
});

it("rolls back both fields and the active mirror when persistence fails", () => {
  const { store, bot, task } = fixture();
  store.setEndpointResumeCursor(task.threadId, endpoint, binding);
  const write = vi.spyOn(OwnedFile.prototype, "write").mockImplementation(() => { throw new Error("fixture disk full"); });
  try {
    expect(() => store.setEndpointResumeCursor(task.threadId, endpoint, { cursor: "next", revision: 2 })).toThrow();
    expect(task.resumeCursors[endpoint]).toBe(binding.cursor);
    expect(task.endpointResumeRevisions).toEqual({ [endpoint]: 1 });
    expect(bot.resumeCursors[endpoint]).toBe(binding.cursor);
  } finally { write.mockRestore(); }
  expect(restartTask(bot.id, task.threadId).endpointResumeRevisions).toEqual({ [endpoint]: 1 });
});

it("supports private revision patches without leaking them into task wire", () => {
  const { store, bot, task } = fixture();
  const revisions = { [endpoint]: 4 };
  store.patchTask(bot.id, task.threadId, {
    resumeCursors: { [endpoint]: binding.cursor, official: { session: "legacy" } },
    endpointResumeRevisions: revisions,
  });
  revisions[endpoint] = 99;
  expect(restartTask(bot.id, task.threadId).endpointResumeRevisions).toEqual({ [endpoint]: 4 });
  expect(toWireTask(task, bot.modelSelection)).not.toHaveProperty("endpointResumeRevisions");
  expect(toWireTask(task, bot.modelSelection)).not.toHaveProperty("resumeCursors");
});

it("renames revisions with cursors and dispatch state", () => {
  const { store, bot, task } = fixture();
  store.setEndpointResumeCursor(task.threadId, endpoint, binding);
  store.markTaskDispatched(bot.id, task.threadId, endpoint);
  store.setHandedMessages(bot.id, task.threadId, endpoint, { session: binding.cursor, through: "m1", config: "config", ids: [] });
  store.renameInstances(new Map([[endpoint, "renamed"]]));
  expect(restartTask(bot.id, task.threadId)).toMatchObject({
    resumeCursors: { renamed: binding.cursor }, endpointResumeRevisions: { renamed: 1 },
    lastInstanceId: "renamed",
  });
  expect(task.handedMessages).toHaveProperty("renamed");
  expect(task.handedMessages).not.toHaveProperty(endpoint);
});

it.each([false, true])("keeps the destination cursor's own revision on rename collision, bound=%s", (bound) => {
  const { store, bot, task } = fixture();
  store.setEndpointResumeCursor(task.threadId, endpoint, binding);
  if (bound) store.setEndpointResumeCursor(task.threadId, "destination", { cursor: "destination-session", revision: 8 });
  else store.setResumeCursor(bot.id, "destination", "destination-session");
  store.renameInstances(new Map([[endpoint, "destination"]]));
  expect(task.resumeCursors).toEqual({ destination: "destination-session" });
  expect(task.endpointResumeRevisions ?? {}).toEqual(bound ? { destination: 8 } : {});
  expect(restartTask(bot.id, task.threadId).endpointResumeRevisions ?? {}).toEqual(bound ? { destination: 8 } : {});
});

it("retires only the removed instance's revision and cursor", () => {
  const { store, bot, task } = fixture();
  store.setEndpointResumeCursor(task.threadId, endpoint, binding);
  store.setEndpointResumeCursor(task.threadId, "kept", { cursor: "kept-session", revision: 2 });
  store.setResumeCursor(bot.id, "official", { session: "official-session" });
  store.retireInstances(new Set([endpoint]), selection(), { canWorkOnCloud: false, keepCloud: () => false });
  expect(restartTask(bot.id, task.threadId)).toMatchObject({
    resumeCursors: { kept: "kept-session", official: { session: "official-session" } },
    endpointResumeRevisions: { kept: 2 },
  });
  expect(task.resumeCursors).not.toHaveProperty(endpoint);
});

it.each(["contextReset", "rewind", "botReset", "switchModel", "followModel"])("clears revisions at the %s cursor reset boundary", (path) => {
  const { store, bot, task } = fixture();
  store.setEndpointResumeCursor(task.threadId, endpoint, binding);
  if (path === "botReset") store.patchBot(bot.id, { resumeCursors: {} });
  else if (path === "switchModel") store.switchTaskModel(bot.id, task.threadId, selection(), false, false, { resumeCursors: {} });
  else if (path === "followModel") {
    store.patchTask(bot.id, task.threadId, { modelSelection: { instanceId: endpoint, model: "custom" } });
    store.followBotModel(bot.id, [task.threadId], () => ({ resumeCursors: {} }));
  } else store.patchTask(bot.id, task.threadId, { resumeCursors: {}, ...(path === "rewind" ? { rewound: false } : {}) });
  expect(task.endpointResumeRevisions ?? {}).toEqual({});
  expect(restartTask(bot.id, task.threadId).endpointResumeRevisions ?? {}).toEqual({});
});

it("preserves only bindings for unchanged cursors in partial replacement patches", () => {
  const { store, bot, task } = fixture();
  store.setEndpointResumeCursor(task.threadId, endpoint, binding);
  store.setEndpointResumeCursor(task.threadId, "changed", { cursor: "old", revision: 3 });
  store.setEndpointResumeCursor(task.threadId, "removed", { cursor: "removed", revision: 5 });
  store.patchTask(bot.id, task.threadId, { resumeCursors: { [endpoint]: binding.cursor, changed: "new", official: { id: 1 } } });
  expect(task.endpointResumeRevisions).toEqual({ [endpoint]: 1 });
  expect(task.resumeCursors).toEqual({ [endpoint]: binding.cursor, changed: "new", official: { id: 1 } });
});

it("invalidates a changed endpoint cursor written by the legacy setter without changing other cursors", () => {
  const { store, bot, task } = fixture();
  store.setEndpointResumeCursor(task.threadId, endpoint, binding);
  store.setResumeCursor(bot.id, "official", { id: 1 });
  store.setResumeCursor(bot.id, endpoint, "unbound-session");
  expect(task.endpointResumeRevisions ?? {}).toEqual({});
  expect(restartTask(bot.id, task.threadId).resumeCursors).toEqual({ [endpoint]: "unbound-session", official: { id: 1 } });
});

it("starts copied task settings with empty native state unless cursor and revision are copied together", () => {
  const { store, bot, task } = fixture();
  store.setEndpointResumeCursor(task.threadId, endpoint, binding);
  const copy = store.createTask(bot.id, task.title, false, undefined, undefined, undefined, task.modelSelection)!;
  expect(copy.resumeCursors).toEqual({});
  expect(copy.endpointResumeRevisions).toBeUndefined();
  store.patchTask(bot.id, copy.threadId, {
    resumeCursors: structuredClone(task.resumeCursors),
    endpointResumeRevisions: structuredClone(task.endpointResumeRevisions),
  });
  expect(restartTask(bot.id, copy.threadId).endpointResumeRevisions).toEqual({ [endpoint]: 1 });
  store.patchTask(bot.id, copy.threadId, { resumeCursors: {} });
  const rows: BotRecord[] = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"));
  expect(rows.find(row => row.id === bot.id)?.tasks?.find(row => row.threadId === copy.threadId)?.endpointResumeRevisions ?? {}).toEqual({});
});
