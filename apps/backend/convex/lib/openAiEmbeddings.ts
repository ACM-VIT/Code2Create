import { z } from "zod";

import { readBoundedJsonResponse } from "./boundedHttpBody";
import type { AiEmbeddingTelemetry } from "./posthog";

const embeddingResponse = z.object({
  data: z.array(z.object({
    embedding: z.array(z.number()),
    index: z.number().int().nonnegative(),
  }).passthrough()),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional(),
  }).passthrough().optional(),
}).passthrough();

export class OpenAiEmbeddingError extends Error {
  readonly status: number | undefined;
  readonly timedOut: boolean;

  constructor(
    message: string,
    status: number | undefined,
    timedOut: boolean,
  ) {
    super(message);
    this.name = "OpenAiEmbeddingError";
    this.status = status;
    this.timedOut = timedOut;
  }
}

function isTimeoutError(error: unknown) {
  return error instanceof Error
    && (error.name === "AbortError" || error.name === "TimeoutError");
}

function canRetry(error: unknown) {
  if (!(error instanceof OpenAiEmbeddingError)) return false;
  return error.timedOut
    || error.status === undefined
    || error.status === 429
    || error.status >= 500;
}

async function requestOpenAiEmbeddings(args: {
  apiKey: string;
  model: "text-embedding-3-small";
  input: string | string[];
  timeoutMs: number;
}) {
  let response: Response;
  const timeoutSignal = AbortSignal.timeout(args.timeoutMs);
  try {
    response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        authorization: `Bearer ${args.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: args.model,
        encoding_format: "float",
        input: args.input,
      }),
      signal: timeoutSignal,
    });
  } catch (error) {
    const timedOut = timeoutSignal.aborted || isTimeoutError(error);
    throw new OpenAiEmbeddingError(
      timedOut ? "The embedding request timed out." : "The embedding request failed.",
      undefined,
      timedOut,
    );
  }
  if (!response.ok) {
    throw new OpenAiEmbeddingError(
      `The embedding provider returned HTTP ${response.status}.`,
      response.status,
      false,
    );
  }
  const parsed = embeddingResponse.safeParse(
    await readBoundedJsonResponse(response, 16 * 1_024 * 1_024),
  );
  if (!parsed.success) {
    throw new OpenAiEmbeddingError(
      "The embedding provider returned an invalid response.",
      response.status,
      false,
    );
  }
  const requestId = response.headers.get("x-request-id")?.trim();
  const remainingRequestsHeader = response.headers
    .get("x-ratelimit-remaining-requests")
    ?.trim();
  const remainingRequests = remainingRequestsHeader === undefined
    ? undefined
    : Number(remainingRequestsHeader);
  const requestResetHeader = response.headers.get("x-ratelimit-reset-requests")?.trim();
  const requestReset = requestResetHeader && requestResetHeader.length <= 40
    ? requestResetHeader
    : undefined;
  return {
    data: parsed.data.data,
    ...(parsed.data.usage?.prompt_tokens !== undefined
      ? { inputTokens: parsed.data.usage.prompt_tokens }
      : parsed.data.usage?.total_tokens !== undefined
        ? { inputTokens: parsed.data.usage.total_tokens }
        : {}),
    ...(requestId ? { requestId } : {}),
    ...(remainingRequests !== undefined
      && Number.isSafeInteger(remainingRequests)
      && remainingRequests >= 0
      ? { remainingRequests }
      : {}),
    ...(requestReset ? { requestReset } : {}),
  };
}

export async function createOpenAiEmbeddings(args: {
  apiKey: string;
  model: "text-embedding-3-small";
  input: string | string[];
  timeoutMs: number;
  maximumAttempts?: 1 | 2;
  telemetry?: {
    traceId: string;
    sessionId?: string | undefined;
    distinctId?: string | undefined;
    operation: string;
    capture: (telemetry: AiEmbeddingTelemetry) => Promise<void>;
  } | undefined;
}) {
  const maximumAttempts = args.maximumAttempts ?? 1;
  const startedAt = Date.now();
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      const response = await requestOpenAiEmbeddings(args);
      if (args.telemetry) {
        await args.telemetry.capture({
          ...args.telemetry,
          model: args.model,
          provider: "openai",
          durationMs: Date.now() - startedAt,
          isError: false,
          inputTokens: response.inputTokens,
          inputCount: Array.isArray(args.input) ? args.input.length : 1,
          providerRequestId: response.requestId,
        });
      }
      return response;
    } catch (error) {
      if (attempt === maximumAttempts || !canRetry(error)) {
        if (args.telemetry) {
          const status = error instanceof OpenAiEmbeddingError ? error.status : undefined;
          await args.telemetry.capture({
            ...args.telemetry,
            model: args.model,
            provider: "openai",
            durationMs: Date.now() - startedAt,
            isError: true,
            errorCategory: error instanceof OpenAiEmbeddingError && error.timedOut
              ? "provider_timed_out"
              : status === 429
                ? "provider_rate_limited"
                : status === undefined
                  ? "provider_request_failed"
                  : `provider_http_${status}`,
            inputCount: Array.isArray(args.input) ? args.input.length : 1,
          });
        }
        throw error;
      }
    }
  }
  throw new Error("The embedding request exhausted its attempts.");
}
