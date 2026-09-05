import { afterEach, expect, test, vi } from "vitest";
import type { ParticipantEmailSendRequest, ParticipantEmailSendResult } from "@code2create/domain";
import { participantEmailSendProtocolVersion } from "@code2create/domain";
import { OutboundEmailDelivery } from "./emailDispatch.js";

const input: ParticipantEmailSendRequest = {
  protocolVersion: participantEmailSendProtocolVersion, requestId: "local-delivery-one", provider: "aws_ses",
  to: "participant@example.test", subject: "Event update", text: "Please open the portal.", html: "<p>Please open the portal.</p>",
  headers: [], attachments: [],
};
const accepted: ParticipantEmailSendResult = { status: "accepted", provider: "aws_ses", messageId: "local-provider-message", initialOutcome: "queued" };
const request = (body = input) => new Request("https://email.internal/send", { method: "POST", body: JSON.stringify(body) });
afterEach(() => vi.useRealTimers());

function fixture() {
  type State = ConstructorParameters<typeof OutboundEmailDelivery>[0];
  type StoredReceipt = Parameters<State["storage"]["put"]>[1];
  const values = new Map<string, StoredReceipt>();
  let gate = Promise.resolve();
  const state: State = {
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      const result = gate.then(callback);
      gate = result.then(() => undefined, () => undefined);
      return result;
    },
    storage: {
      async get(key: string) { return values.get(key); },
      async put(key: string, value: StoredReceipt) { values.set(key, structuredClone(value)); },
      async setAlarm() {},
      async deleteAll() { values.clear(); },
    },
  };
  const environment = { EMAIL_SEND_INGRESS_SECRET: "local-fixture-secret", OUTBOUND_EMAILS: { getByName() { throw new Error("Unused in object tests"); } } };
  return { state, environment };
}

test("returns the receipt for a completed delivery after the object restarts", async () => {
  const { state, environment } = fixture();
  const send = vi.fn(async () => accepted);
  const first = new OutboundEmailDelivery(state, environment, send);
  expect(await (await first.fetch(request())).json()).toEqual(accepted);
  const restarted = new OutboundEmailDelivery(state, environment, send);
  expect(await (await restarted.fetch(request())).json()).toEqual(accepted);
  expect(send).toHaveBeenCalledOnce();
  expect(await (await restarted.fetch(request({ ...input, to: "different@example.test" }))).json())
    .toMatchObject({ status: "rejected", errorCode: "email_request_id_conflict" });
  expect(send).toHaveBeenCalledOnce();
});

test("a concurrent request cannot dispatch a delivery while its first attempt is unresolved", async () => {
  const { state, environment } = fixture();
  let finish: (value: ParticipantEmailSendResult) => void = () => { throw new Error("Promise not initialized"); };
  const pending = new Promise<ParticipantEmailSendResult>(resolve => { finish = resolve; });
  const send = vi.fn(() => pending);
  const delivery = new OutboundEmailDelivery(state, environment, send);
  const first = delivery.fetch(request());
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  const concurrent = await delivery.fetch(request());
  expect(await concurrent.json()).toMatchObject({ status: "ambiguous" });
  finish(accepted);
  await first;
  expect(send).toHaveBeenCalledOnce();
});

test.each([true, false])("a definite rejection permits a later safe retry (provider retryable=%s)", async retryable => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { state, environment } = fixture();
  const send = vi.fn<() => Promise<ParticipantEmailSendResult>>()
    .mockResolvedValueOnce({ status: "rejected", provider: "aws_ses", errorCode: "not_sent", retryable })
    .mockResolvedValue(accepted);
  const delivery = new OutboundEmailDelivery(state, environment, send);
  await delivery.fetch(request());
  await delivery.fetch(request());
  expect(send).toHaveBeenCalledOnce();
  vi.setSystemTime(Date.now() + 30_001);
  expect(await (await delivery.fetch(request())).json()).toEqual(accepted);
  expect(send).toHaveBeenCalledTimes(2);
});

test("an uncertain send is never automatically retried", async () => {
  const { state, environment } = fixture();
  const send = vi.fn(async (): Promise<ParticipantEmailSendResult> => { throw new Error("Connection closed"); });
  const delivery = new OutboundEmailDelivery(state, environment, send);
  expect(await (await delivery.fetch(request())).json()).toMatchObject({ status: "ambiguous" });
  expect(await (await delivery.fetch(request())).json()).toMatchObject({ status: "ambiguous" });
  expect(send).toHaveBeenCalledOnce();
});
