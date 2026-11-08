import { expect, it } from "vitest";
import { persistEndpointInstances, type EndpointPersistence } from "./endpoint-persistence.ts";

it("commits once and reports each failed load without losing committed IDs", async () => {
  const events: string[] = [];
  const deps: EndpointPersistence = {
    save: () => { events.push("save"); },
    changing: (id, blocked) => { events.push(`${id}:${blocked}`); },
    revoke: () => { events.push("revoke"); },
    replace: async (id) => {
      if (id === "a") throw new Error("fixture load failed");
      return { instanceId: id, state: "loaded" };
    },
  };
  const result = await persistEndpointInstances(deps, ["a", "b"], {});
  expect(result).toEqual({
    committed: true, instanceIds: ["a", "b"],
    loadResults: [{ instanceId: "a", state: "unavailable", reason: "Connection could not be loaded. Check its settings." }, { instanceId: "b", state: "loaded" }],
  });
  expect(events).toEqual(["a:true", "b:true", "save", "revoke", "a:false", "b:false"]);
});

it("does not load or revoke any connection when the disk save fails", async () => {
  const events: string[] = [];
  await expect(persistEndpointInstances({
    save: () => { throw new Error("disk full"); },
    replace: async (id) => { events.push("load"); return { instanceId: id, state: "loaded" }; },
    revoke: () => { events.push("revoke"); },
    changing: (id, blocked) => { events.push(`${id}:${blocked}`); },
  }, ["a"], {})).rejects.toThrow("disk full");
  expect(events).toEqual(["a:true", "a:false"]);
});
