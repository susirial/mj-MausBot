import type { TaskRecord } from "./store.ts";

type EndpointResumeState = Pick<TaskRecord, "resumeCursors" | "endpointResumeRevisions">;

export function effectiveEndpointResumeCursor(
  task: EndpointResumeState | undefined,
  instanceId: string,
  revision: number,
): string | undefined {
  const cursor = task?.resumeCursors[instanceId];
  return typeof cursor === "string" && task?.endpointResumeRevisions?.[instanceId] === revision ? cursor : undefined;
}

export function endpointResumeMatches(
  task: EndpointResumeState | undefined,
  instanceId: string,
  revision: number,
): boolean {
  return effectiveEndpointResumeCursor(task, instanceId, revision) !== undefined;
}
