export type TransferCredential =
  | { kind: "one-time-token"; value: string }
  | { kind: "session-token"; value: string };

export function selectTransferCredential(
  storedSessionToken: string | null,
  oneTimeToken: string | null,
): TransferCredential | null {
  if (oneTimeToken !== null && oneTimeToken.length > 0) {
    return { kind: "one-time-token", value: oneTimeToken };
  }
  if (storedSessionToken !== null && storedSessionToken.length > 0) {
    return { kind: "session-token", value: storedSessionToken };
  }
  return null;
}

export async function completeAuthTransfer(
  credential: TransferCredential,
  operations: {
    verifyOneTimeToken: (token: string) => Promise<string>;
    storeSessionToken: (token: string) => void;
    establishSession: (token: string) => Promise<void>;
    clearSessionToken: () => void;
    removeOneTimeToken: () => void;
  },
) {
  const sessionToken =
    credential.kind === "session-token"
      ? credential.value
      : await operations.verifyOneTimeToken(credential.value);

  if (credential.kind === "one-time-token") {
    operations.storeSessionToken(sessionToken);
    operations.removeOneTimeToken();
  }
  await operations.establishSession(sessionToken);
  operations.clearSessionToken();
}

export function abandonAuthTransfer(operations: {
  clearSessionToken: () => void;
  removeOneTimeToken: () => void;
}) {
  operations.clearSessionToken();
  operations.removeOneTimeToken();
  return "idle" as const;
}
