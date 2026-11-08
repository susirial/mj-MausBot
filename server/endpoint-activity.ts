import type { ProviderInstance } from "./contracts.ts";
import { addHeldSecretScrubber, HELD_SECRET_MASK } from "./redact.ts";

export class EndpointActivity {
  private readonly active = new Map<string, number>();
  private readonly blocked = new Set<string>();

  busy(instanceId: string): boolean { return (this.active.get(instanceId) ?? 0) > 0; }
  block(instanceId: string): void { this.blocked.add(instanceId); }
  unblock(instanceId: string): void { this.blocked.delete(instanceId); }

  async run<T>(instanceId: string, call: () => Promise<T>): Promise<T> {
    if (this.blocked.has(instanceId)) throw new Error("This connection is changing. Wait for its settings to finish saving.");
    this.active.set(instanceId, (this.active.get(instanceId) ?? 0) + 1);
    try { return await call(); }
    finally {
      const count = (this.active.get(instanceId) ?? 1) - 1;
      if (count) this.active.set(instanceId, count);
      else this.active.delete(instanceId);
    }
  }

  wrap(instance: ProviderInstance, apiKey?: string): ProviderInstance {
    const { instanceId } = instance;
    if (apiKey) {
      const remove = addHeldSecretScrubber(text => text.replaceAll(apiKey, HELD_SECRET_MASK));
      const dispose = instance.dispose.bind(instance);
      instance.dispose = async () => { await dispose(); remove(); };
    }
    for (const key of ["generateText", "generateMemoryText", "reviewPermission"] as const) {
      const call = instance[key];
      if (!call) continue;
      if (key === "generateText" || key === "generateMemoryText") {
        const text = instance[key];
        if (text) instance[key] = (prompt, options) => this.run(instanceId, () => text.call(instance, prompt, options));
      } else {
        const review = instance.reviewPermission;
        if (review) instance.reviewPermission = (prompt, signal) => this.run(instanceId, () => review.call(instance, prompt, signal));
      }
    }
    const adapter = instance.adapter;
    const warm = adapter.cacheKeepWarm;
    const compact = warm?.compact;
    Object.assign(instance, { adapter: {
      ...adapter,
      sendTurn: (input) => this.run(instanceId, () => adapter.sendTurn(input)),
      ...(warm ? { cacheKeepWarm: {
        ...warm,
        ping: (threadId, options) => this.run(instanceId, () => warm.ping(threadId, options)),
        ...(compact ? { compact: (threadId, options) => this.run(instanceId, () => compact(threadId, options)) } : {}),
      } } : {}),
    } satisfies ProviderInstance["adapter"] });
    return instance;
  }
}

export const endpointActivity = new EndpointActivity();
