import { expect, it } from "vitest";
import { effectiveEndpointResumeCursor, endpointResumeMatches } from "./endpoint-session-revision.ts";
import type { TaskRecord } from "./store.ts";

const task = {
  resumeCursors: { endpoint: "native", official: { session: "official" }, other: "other-session" },
  endpointResumeRevisions: { endpoint: 2, other: 3 },
} satisfies Pick<TaskRecord, "resumeCursors" | "endpointResumeRevisions">;

it("returns a cursor only for the same instance and revision without mutating the task", () => {
  const before = structuredClone(task);
  expect(effectiveEndpointResumeCursor(task, "endpoint", 2)).toBe("native");
  expect(endpointResumeMatches(task, "endpoint", 2)).toBe(true);
  expect(effectiveEndpointResumeCursor(task, "endpoint", 1)).toBeUndefined();
  expect(effectiveEndpointResumeCursor(task, "other", 2)).toBeUndefined();
  expect(effectiveEndpointResumeCursor(task, "missing", 2)).toBeUndefined();
  expect(endpointResumeMatches(task, "endpoint", 1)).toBe(false);
  expect(task).toEqual(before);
});

it("does not resume legacy endpoint tasks without revision metadata or infer a revision", () => {
  const legacy = { resumeCursors: { endpoint: "native" } };
  expect(effectiveEndpointResumeCursor(legacy, "endpoint", 1)).toBeUndefined();
  expect(endpointResumeMatches(legacy, "endpoint", 1)).toBe(false);
  expect(legacy).not.toHaveProperty("endpointResumeRevisions");
  expect(effectiveEndpointResumeCursor(undefined, "endpoint", 1)).toBeUndefined();
});

it.each([undefined, null, 1, {}, { session: "native" }])("rejects non-string endpoint cursors even with matching metadata, cursor=%j", (cursor) => {
  const invalid = { resumeCursors: { endpoint: cursor }, endpointResumeRevisions: { endpoint: 2 } };
  expect(effectiveEndpointResumeCursor(invalid, "endpoint", 2)).toBeUndefined();
  expect(endpointResumeMatches(invalid, "endpoint", 2)).toBe(false);
});

it("treats a string cursor as opaque rather than applying truthiness", () => {
  expect(effectiveEndpointResumeCursor({ resumeCursors: { endpoint: "" }, endpointResumeRevisions: { endpoint: 2 } }, "endpoint", 2)).toBe("");
});
