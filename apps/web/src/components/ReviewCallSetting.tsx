import { api } from "@code2create/backend/api";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { useState, type SubmitEvent } from "react";
import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { useOperationRunner } from "../lib/operations";

type Setting = NonNullable<
  FunctionReturnType<typeof api.participantReviewCalls.mine>
>;
export function ReviewCallSetting() {
  const setting = useQuery(api.participantReviewCalls.mine, { eventSlug });
  if (!setting) return null;
  return (
    <details className="border-b border-petal-line py-3.5">
      <summary className="flex cursor-pointer justify-between gap-4 text-[14px] text-fg/90">
        Review calls
        <span className="text-[12px] text-fg/50">
          {setting.enabled ? "On" : "Off"}
        </span>
      </summary>
      <CallForm key={setting.version} setting={setting} />
    </details>
  );
}
function CallForm({ setting }: { setting: Setting }) {
  const save = useMutation(api.participantReviewCalls.save);
  const attempt =
    useOperationRunner<
      FunctionReturnType<typeof api.participantReviewCalls.save>
    >();
  const [enabled, setEnabled] = useState(setting.enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = attempt.hasPending("review-call-setting");
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await attempt.run("review-call-setting", (clientOperationId) => {
        const args = {
          eventSlug,
          enabled,
          expectedVersion: setting.version,
          clientOperationId,
        };
        return () => save(args);
      });
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={submit}
      className="mt-3 flex flex-col gap-3 text-[13px] text-fg/75"
    >
      <p className="m-0">
        Allow automated calls to your saved profile number when your team is
        next or ready for review. You can turn them off here.
      </p>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy || pending}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Call me about my team’s review
      </label>
      <button
        type="submit"
        disabled={busy}
        className="self-start text-rose-light"
      >
        {busy ? "Saving…" : pending ? "Confirm earlier update" : "Save"}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}
