import type { Code2CreateAuthClient } from "./index";

export type AuthPopupErrorCode =
  | "POPUP_BLOCKED"
  | "POPUP_CLOSED"
  | "POPUP_SIGN_IN_FAILED"
  | "POPUP_TIMEOUT";

const authPopupNonceParameter = "authPopup";
const authPopupResultStorageKey = "code2create.auth.popup-result";
const authPopupWindowName = "code2create-google-auth";
const authPopupTimeoutMs = 5 * 60 * 1000;

export async function signInWithGooglePopup(
  authClient: Code2CreateAuthClient,
  callbackURL: string,
  transformAuthorizationUrl: (authorizationUrl: string) => string = (authorizationUrl) =>
    authorizationUrl,
): Promise<{ error: { code: AuthPopupErrorCode } | null }> {
  const popup = window.open("about:blank", authPopupWindowName, centeredPopupFeatures());
  if (popup === null) return { error: { code: "POPUP_BLOCKED" } };

  const nonce = randomPopupNonce();
  const callback = new URL(callbackURL);
  callback.searchParams.set(authPopupNonceParameter, nonce);
  const completionAbort = new AbortController();
  const completion = waitForAuthPopup(popup, nonce, completionAbort.signal);

  try {
    const result = await authClient.signIn.social({
      provider: "google",
      callbackURL: callback.toString(),
      disableRedirect: true,
    });
    const authorizationURL = result.data?.url;
    if (
      result.error !== null ||
      authorizationURL === undefined ||
      authorizationURL.length === 0
    ) {
      completionAbort.abort();
      return { error: { code: "POPUP_SIGN_IN_FAILED" } };
    }
    popup.location.assign(transformAuthorizationUrl(authorizationURL));
  } catch {
    completionAbort.abort();
    return { error: { code: "POPUP_SIGN_IN_FAILED" } };
  }

  const error = await completion;
  if (error !== null) return { error: { code: error } };
  await authClient.updateSession();
  return { error: null };
}

export function readAuthPopupNonce() {
  return new URL(window.location.href).searchParams.get(authPopupNonceParameter);
}

export function signalAuthPopupCompletion(nonce: string) {
  localStorage.setItem(authPopupResultStorageKey, nonce);
  window.close();
}

function waitForAuthPopup(
  popup: Window,
  nonce: string,
  signal: AbortSignal,
): Promise<AuthPopupErrorCode | null> {
  return new Promise((resolve) => {
    let settled = false;
    let closedPoll = 0;
    let timeout = 0;

    function onStorage(event: StorageEvent) {
      if (event.key === authPopupResultStorageKey && event.newValue === nonce) settle(null);
    }

    function onAbort() {
      settle("POPUP_SIGN_IN_FAILED");
    }

    function settle(error: AuthPopupErrorCode | null) {
      if (settled) return;
      settled = true;
      window.removeEventListener("storage", onStorage);
      signal.removeEventListener("abort", onAbort);
      window.clearInterval(closedPoll);
      window.clearTimeout(timeout);
      if (!popup.closed) popup.close();
      resolve(error);
    }

    closedPoll = window.setInterval(() => {
      if (popup.closed) settle("POPUP_CLOSED");
    }, 500);
    timeout = window.setTimeout(() => settle("POPUP_TIMEOUT"), authPopupTimeoutMs);
    window.addEventListener("storage", onStorage);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function randomPopupNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function centeredPopupFeatures() {
  const width = 500;
  const height = 600;
  const left = window.screenX + (window.outerWidth - width) / 2;
  const top = window.screenY + (window.outerHeight - height) / 2;
  return `width=${width},height=${height},left=${left},top=${top},menubar=no,toolbar=no`;
}
