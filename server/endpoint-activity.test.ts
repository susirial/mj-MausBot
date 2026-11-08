import { expect, it } from "vitest";
import { EndpointActivity } from "./endpoint-activity.ts";
import { makeFakeDriver } from "./testing/fake-driver.ts";
import { redactSecretsInText } from "./redact.ts";

it("holds an endpoint busy until a background call settles and releases failed calls", async () => {
  const activity = new EndpointActivity();
  let release: (() => void) | undefined;
  const pending = activity.run("a", () => new Promise<void>((resolve) => { release = resolve; }));
  expect(activity.busy("a")).toBe(true);
  expect(activity.busy("b")).toBe(false);
  release?.();
  await pending;
  expect(activity.busy("a")).toBe(false);
  await expect(activity.run("a", async () => { throw new Error("fixture"); })).rejects.toThrow("fixture");
  expect(activity.busy("a")).toBe(false);
});

it("refuses new work while an endpoint is changing", async () => {
  const activity = new EndpointActivity();
  activity.block("a");
  await expect(activity.run("a", async () => "answer")).rejects.toThrow("changing");
  activity.unblock("a");
  expect(await activity.run("a", async () => "answer")).toBe("answer");
});

it("scrubs a key of any shape until the endpoint has stopped", async () => {
  const fake = makeFakeDriver();
  const instance = await fake.driver.create({ instanceId: "a", config: {}, environment: {}, enabled: true, displayName: "Endpoint" });
  new EndpointActivity().wrap(instance, "short-key");
  expect(redactSecretsInText("refused short-key")).not.toContain("short-key");
  await instance.dispose();
  expect(redactSecretsInText("short-key")).toBe("short-key");
});
