import type { ParticipantEmailSendRequest, ParticipantEmailSendResult } from "@code2create/domain";
import { sendOutboundEmail, type OutboundEmailEnvironment } from "./outbound.js";
import { participantEmailSendRequestSchema } from "./outboundContracts.js";

const retentionMs = 7 * 24 * 60 * 60_000;
const retryDelayMs = 30_000;
type Receipt = {
  fingerprint: string;
  expiresAt: number;
  result?: ParticipantEmailSendResult;
  retryAt?: number;
};

type DeliveryState = {
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  storage: {
    get(key: string): Promise<Receipt | undefined>;
    put(key: string, value: Receipt): Promise<void>;
    setAlarm(time: number): Promise<void>;
    deleteAll(): Promise<void>;
  };
};

type Dispatch = (request: ParticipantEmailSendRequest) => Promise<ParticipantEmailSendResult>;

/** One object per delivery ID. Store only the content digest and delivery receipt. */
export class OutboundEmailDelivery {
  constructor(
    private readonly state: DeliveryState,
    environment: OutboundEmailEnvironment,
    private readonly dispatch: Dispatch = request => sendOutboundEmail(request, environment),
  ) {}

  async fetch(request: Request) {
    const input = participantEmailSendRequestSchema.parse(await request.json());
    const body = JSON.stringify(input);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    const claimed = await this.state.blockConcurrencyWhile(async () => {
      const receipt = await this.state.storage.get("receipt");
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) {
          return { status: "rejected", provider: input.provider, errorCode: "email_request_id_conflict", retryable: false } as const;
        }
        if (receipt.retryAt === undefined || Date.now() < receipt.retryAt) {
          return receipt.result ?? { status: "ambiguous", provider: input.provider, errorCode: "email_dispatch_in_progress" } as const;
        }
      }
      const expiresAt = Date.now() + retentionMs;
      // Persist the claim before provider I/O. A process restart must never resend an uncertain delivery.
      await this.state.storage.put("receipt", { fingerprint, expiresAt } satisfies Receipt);
      await this.state.storage.setAlarm(expiresAt);
      return null;
    });
    if (claimed) return Response.json(claimed);
    let result: ParticipantEmailSendResult;
    try {
      result = await this.dispatch(input);
    } catch {
      result = { status: "ambiguous", provider: input.provider, errorCode: "email_provider_dispatch_ambiguous" };
    }
    await this.state.storage.put("receipt", {
      fingerprint, expiresAt: Date.now() + retentionMs, result,
      ...(result.status === "rejected" ? { retryAt: Date.now() + retryDelayMs } : {}),
    } satisfies Receipt);
    return Response.json(result);
  }

  async alarm() {
    const receipt = await this.state.storage.get("receipt");
    if (receipt && receipt.expiresAt > Date.now()) {
      await this.state.storage.setAlarm(receipt.expiresAt);
      return;
    }
    await this.state.storage.deleteAll();
  }
}
