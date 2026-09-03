import {
  admissionIntelligenceReadSignatureContext,
  operationsIntelligenceProtocolVersion,
  signServiceBody,
  type AdmissionIntelligenceReadName,
} from "@code2create/domain";
import * as v from "valibot";

import { admissionReadEnvelopeSchema, admissionReadSchemas } from "../protocol.ts";
import { readBoundedJsonResponse } from "./boundedHttpBody.ts";
import { requireStrongServiceSecret } from "./serviceSecret.ts";
import { serviceUrl } from "./serviceUrl.ts";

type AdmissionReadBindings = Pick<
  Cloudflare.Env,
  "CONVEX_INTELLIGENCE_READ_URL" | "INTELLIGENCE_READ_SECRET"
>;

export type AdmissionReadParameters = {
  capacityPeople?: number;
  query?: string;
  limit?: number;
};

const maximumAdmissionReadResponseBytes = 256 * 1_024;

/** Derives the admission route from the configured operations-read endpoint. */
function admissionReadUrl(configured: string) {
  const url = serviceUrl(configured, "Convex admission read");
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return new URL("admission-reads", url);
}

export type AdmissionReadResult = v.InferOutput<
  (typeof admissionReadSchemas)[AdmissionIntelligenceReadName]
>;

/** Performs one signed, whitelisted admission read and validates its response. */
export async function performAdmissionRead(
  name: AdmissionIntelligenceReadName,
  eventSlug: string,
  parameters: AdmissionReadParameters,
  bindings: AdmissionReadBindings,
  request: typeof fetch = fetch,
): Promise<AdmissionReadResult> {
  const secret = requireStrongServiceSecret(
    bindings.INTELLIGENCE_READ_SECRET,
    "INTELLIGENCE_READ_SECRET",
  );
  const body = JSON.stringify({
    protocolVersion: operationsIntelligenceProtocolVersion,
    read: name,
    eventSlug,
    ...(parameters.capacityPeople !== undefined
      ? { capacityPeople: parameters.capacityPeople }
      : {}),
    ...(parameters.query !== undefined ? { query: parameters.query } : {}),
    ...(parameters.limit !== undefined ? { limit: parameters.limit } : {}),
  });
  const timestamp = Date.now().toString();
  const signature = await signServiceBody({
    context: admissionIntelligenceReadSignatureContext,
    secret,
    timestamp,
    body,
  });
  const response = await request(admissionReadUrl(bindings.CONVEX_INTELLIGENCE_READ_URL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-c2c-signature": signature,
      "x-c2c-timestamp": timestamp,
    },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status !== 200) {
    throw new Error(`Convex refused the ${name} read with HTTP ${response.status}.`);
  }
  const parsedEnvelope = v.safeParse(
    admissionReadEnvelopeSchema,
    await readBoundedJsonResponse(response, maximumAdmissionReadResponseBytes),
  );
  if (!parsedEnvelope.success) {
    throw new Error(`The Convex ${name} read envelope is invalid.`);
  }
  const envelope = parsedEnvelope.output;
  if (envelope.read !== name) {
    throw new Error(`Convex answered the ${name} read with ${envelope.read} data.`);
  }
  const parsedData = v.safeParse(admissionReadSchemas[name], envelope.data);
  if (!parsedData.success) {
    throw new Error(`The Convex ${name} read data is invalid.`);
  }
  return parsedData.output;
}
