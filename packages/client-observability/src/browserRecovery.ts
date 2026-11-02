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
 * The asset recovery is reloading past, or null while nothing is recovering.
 * Held per asset rather than as a page-wide flag: during a deployment rollover
 * several different lazy imports can fail at once, and only the one being
 * reloaded past is noise. It lives in this page context and resets on reload.
 */
let recoveringAsset: string | null = null;

/** The empty string when recovery could not name the asset it is reloading past. */
const unidentifiedAsset = "";

/**
 * The content-hashed file a chunk-load message blames, e.g. `GamesScreen-B1c2.js`.
 * Bundlers name assets this way, and the name is what distinguishes one failed
 * import from another in a message that is otherwise identical.
 */
function chunkAssetName(text: string): string | null {
  return /[\w.-]+-[A-Za-z0-9_-]{6,}\.(?:js|mjs|css)/u.exec(text)?.[0] ?? null;
}

/**
 * Drop the chunk-load exception that recovery is about to reload past: the
 * reload is the fix, so filing a new error tracking issue for the content-hashed
 * chunk name is only noise.
 *
 * Only that asset's exception is dropped. Another lazy import failing in the
 * same rollover, or the same one failing again after an unsuccessful reload,
 * stays visible to error tracking. When recovery could not name the asset it is
 * reloading past, no exception is dropped rather than all of them.
 */
export function suppressRecoveredChunkException(event: CapturedEvent): boolean {
  if (recoveringAsset === null || recoveringAsset === unidentifiedAsset) {
    return false;
  }
  if (!isChunkLoadExceptionEvent(event)) {
    return false;
  }
  return chunkExceptionMentions(event, recoveringAsset);
}

/** Whether any exception in `event` blames `asset`. */
function chunkExceptionMentions(event: CapturedEvent, asset: string): boolean {
  const exceptionList: unknown = event.properties?.$exception_list;
  if (!Array.isArray(exceptionList)) {
    return false;
  }
  return exceptionList.some((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) {
      return false;
    }
    const value = "value" in entry && typeof entry.value === "string" ? entry.value : "";
    return value.includes(asset);
  });
}

/** The asset a `vite:preloadError` blames, for recovery to reload past. */
function preloadErrorAsset(event: Event): string {
  const payload = (event as Event & { payload?: unknown }).payload;
  return chunkAssetName(errorMessage(payload)) ?? unidentifiedAsset;
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
      recoveringAsset = preloadErrorAsset(event);
      window.location.reload();
      return;
    }

    event.preventDefault();
    if (waitingForConnectivity) {
      return;
    }
    waitingForConnectivity = true;
    const offlineAsset = preloadErrorAsset(event);
    window.addEventListener(
      "online",
      () => {
        waitingForConnectivity = false;
        const connectedAt = Date.now();
        const connectedHref = window.location.href;
        if (claimAutomaticReload(connectedHref, connectedAt)) {
          recoveringAsset = offlineAsset;
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
