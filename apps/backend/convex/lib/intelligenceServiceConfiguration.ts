const minimumHmacSecretBytes = 32;

/** Validates one intelligence HMAC secret without exposing its value. */
export function validateIntelligenceHmacSecret(value: string, name: string) {
  const secret = value.trim();
  if (new TextEncoder().encode(secret).byteLength < minimumHmacSecretBytes) {
    throw new Error(`${name} must contain at least ${minimumHmacSecretBytes} UTF-8 bytes.`);
  }
  return secret;
}

export function requireIntelligenceHmacSecret(name: string) {
  return validateIntelligenceHmacSecret(process.env[name] ?? "", name);
}

/** Accepts only a canonical Worker origin, never a credentialed or path-bearing URL. */
export function parseIntelligenceWorkerOrigin(value: string) {
  const candidate = value.trim();
  let origin: URL;
  try {
    origin = new URL(candidate);
  } catch {
    throw new Error("INTELLIGENCE_WORKER_URL must be an absolute URL origin.");
  }
  const local =
    origin.hostname === "localhost" ||
    origin.hostname === "127.0.0.1" ||
    origin.hostname === "[::1]";
  if (origin.protocol !== "https:" && !(local && origin.protocol === "http:")) {
    throw new Error("INTELLIGENCE_WORKER_URL must use HTTPS outside local development.");
  }
  if (
    candidate !== origin.origin ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== ""
  ) {
    throw new Error(
      "INTELLIGENCE_WORKER_URL must be its canonical origin without credentials, path, query, or fragment.",
    );
  }
  return origin;
}

export function requireIntelligenceWorkerOrigin() {
  return parseIntelligenceWorkerOrigin(process.env.INTELLIGENCE_WORKER_URL ?? "");
}
