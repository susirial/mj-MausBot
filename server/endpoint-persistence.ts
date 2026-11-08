import type { InstanceConfigMap } from "./contracts.ts";

export interface EndpointLoadResult {
  instanceId: string;
  state: "loaded" | "unavailable";
  reason?: string;
}

export interface EndpointCommit {
  committed: true;
  instanceIds: string[];
  loadResults: EndpointLoadResult[];
}

export interface EndpointPersistence {
  save(instances: InstanceConfigMap): void;
  replace(instanceId: string, instances: InstanceConfigMap): Promise<EndpointLoadResult>;
  changing(instanceId: string, changing: boolean): void;
  revoke(instanceIds: ReadonlySet<string>): void;
}

export async function persistEndpointInstances(
  deps: EndpointPersistence, instanceIds: string[], instances: InstanceConfigMap,
): Promise<EndpointCommit> {
  const ids = [...new Set(instanceIds)];
  for (const id of ids) deps.changing(id, true);
  try {
    deps.save(instances);
    deps.revoke(new Set(ids));
    const loadResults = await Promise.all(ids.map(async (id): Promise<EndpointLoadResult> => {
      try { return await deps.replace(id, instances); }
      catch { return { instanceId: id, state: "unavailable", reason: "Connection could not be loaded. Check its settings." }; }
    }));
    return { committed: true, instanceIds: ids, loadResults };
  } finally {
    for (const id of ids) deps.changing(id, false);
  }
}
