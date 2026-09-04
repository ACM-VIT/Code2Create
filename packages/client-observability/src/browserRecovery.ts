const automaticReloadGuardKey = "code2create:chunk-reload";
const automaticReloadGuardWindowMs = 30_000;

type AutomaticReloadAttempt = {
  href: string;
  attemptedAt: number;
};

const chunkLoadFailurePatterns = [
  /chunkloaderror/iu,
  /loading (?:css )?chunk [\w-]+ failed/iu,
  /failed to fetch dynamically imported module/iu,
  /error loading dynamically imported module/iu,
  /importing a module script failed/iu,
  /unable to preload css/iu,
];

export function isChunkLoadFailure(error: unknown): boolean {
  const message = errorMessage(error);
  return chunkLoadFailurePatterns.some((pattern) => pattern.test(message));
}

export function automaticChunkReloadIsAvailable(
  storedAttempt: string | null,
  href: string,
  now: number,
): boolean {
  const attempt = parseAutomaticReloadAttempt(storedAttempt);
  return (
    attempt === null ||
    attempt.href !== href ||
    now - attempt.attemptedAt >= automaticReloadGuardWindowMs
  );
}

type CapturedEvent = {
  event: string;
  properties?: { $exception_list?: unknown };
};

export function isChunkLoadExceptionEvent(event: CapturedEvent): boolean {
  if (event.event !== "$exception") {
    return false;
  }
  const exceptionList = event.properties?.$exception_list;
  if (!Array.isArray(exceptionList)) {
    return false;
  }
  return exceptionList.some(exceptionEntryIsChunkLoadFailure);
}

function exceptionEntryIsChunkLoadFailure(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }
  const type = "type" in entry && typeof entry.type === "string" ? entry.type : "";
  const value = "value" in entry && typeof entry.value === "string" ? entry.value : "";
  return isChunkLoadFailure(`${type}: ${value}`);
}

/**
 * A chunk-load exception should not be captured once recovery has claimed the
 * reload for this URL: the reload is the fix, so filing a new error tracking
 * issue per content-hashed chunk name is only noise.
 */
export function suppressRecoveredChunkException(event: CapturedEvent): boolean {
  if (typeof window === "undefined" || !isChunkLoadExceptionEvent(event)) {
    return false;
  }
  let storedAttempt: string | null;
  try {
    storedAttempt = window.sessionStorage.getItem(automaticReloadGuardKey);
  } catch {
    return false;
  }
  return !automaticChunkReloadIsAvailable(storedAttempt, window.location.href, Date.now());
}

/**
 * Vite emits `vite:preloadError` when a lazy route asset cannot be fetched. A
 * page reload is required because React.lazy and the browser module loader keep
 * the rejected import. This installs one guarded recovery for the current URL,
 * waiting for connectivity when the device is offline.
 */
export function installBrowserChunkRecovery(): void {
  if (typeof window === "undefined") {
    return;
  }

  let waitingForConnectivity = false;

  window.addEventListener("vite:preloadError", (event) => {
    const now = Date.now();
    const href = window.location.href;
    if (!automaticReloadAvailableInSession(href, now)) {
      return;
    }

    if (window.navigator.onLine) {
      if (!claimAutomaticReload(href, now)) {
        return;
      }
      event.preventDefault();
      window.location.reload();
      return;
    }

    event.preventDefault();
    if (waitingForConnectivity) {
      return;
    }
    waitingForConnectivity = true;
    window.addEventListener(
      "online",
      () => {
        waitingForConnectivity = false;
        const connectedAt = Date.now();
        const connectedHref = window.location.href;
        if (claimAutomaticReload(connectedHref, connectedAt)) {
          window.location.reload();
        }
      },
      { once: true },
    );
  });
}

function automaticReloadAvailableInSession(href: string, now: number): boolean {
  try {
    return automaticChunkReloadIsAvailable(
      window.sessionStorage.getItem(automaticReloadGuardKey),
      href,
      now,
    );
  } catch {
    return false;
  }
}

function claimAutomaticReload(href: string, attemptedAt: number): boolean {
  try {
    const storedAttempt = window.sessionStorage.getItem(automaticReloadGuardKey);
    if (!automaticChunkReloadIsAvailable(storedAttempt, href, attemptedAt)) {
      return false;
    }
    window.sessionStorage.setItem(
      automaticReloadGuardKey,
      JSON.stringify({ href, attemptedAt } satisfies AutomaticReloadAttempt),
    );
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return typeof error === "string" ? error : "";
}

function parseAutomaticReloadAttempt(value: string | null): AutomaticReloadAttempt | null {
  if (value === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "href" in parsed &&
      typeof parsed.href === "string" &&
      "attemptedAt" in parsed &&
      typeof parsed.attemptedAt === "number" &&
      Number.isFinite(parsed.attemptedAt)
    ) {
      return { href: parsed.href, attemptedAt: parsed.attemptedAt };
    }
    return null;
  } catch {
    return null;
  }
}
