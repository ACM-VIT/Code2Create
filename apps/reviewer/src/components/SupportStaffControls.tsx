import { api } from "@code2create/backend/api";
import { supportCaseStateLabels, type SupportCaseState } from "@code2create/domain";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { randomUUID } from "expo-crypto";
import { useRef, useState } from "react";

import { Action, ChipRow, Field, Meta, Problem, Row, Section, Sheet } from "@/components/ui";
import { describeError } from "@/lib/errors";
import { useMutationAttempt } from "@/lib/mutation-attempt";
import { supportStatusChoices } from "@/lib/support-desk";
import { palette } from "@/theme";

type Detail = NonNullable<FunctionReturnType<typeof api.support.detailByPublicCode>>;
type UpdateArgs = FunctionArgs<typeof api.support.updateStaff>;
const slot = "update-staff-case";

export function SupportStaffControls({ detail, eventSlug }: { detail: Detail; eventSlug: string }) {
  const supportCase = detail.supportCase;
  const owners = useQuery(api.support.owners, { eventSlug });
  const update = useMutation(api.support.updateStaff);
  const attempt = useMutationAttempt<FunctionReturnType<typeof api.support.updateStaff>>();
  const pending = attempt.hasPending(slot);
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const [message, setMessage] = useState("");
  const [draft, setDraft] = useState<{ version: number; state: SupportCaseState } | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const clearsComposer = useRef(false);
  const state = draft?.version === supportCase.version ? draft.state : supportCase.state;
  const nextState = state === supportCase.state ? undefined : state;
  const wrote = message.trim().length >= 2;

  const perform = async (
    change: Pick<UpdateArgs, "reason"> &
      Partial<
        Pick<
          UpdateArgs,
          "nextOwnerPersonId" | "clearOwner" | "nextState" | "publicNote" | "internalNote"
        >
      >,
    clearComposer = false,
  ) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await attempt.run(slot, () => {
        clearsComposer.current = clearComposer;
        const args = {
          eventSlug,
          supportCaseId: supportCase.id,
          expectedVersion: supportCase.version,
          clearOwner: false,
          ...change,
          clientOperationId: randomUUID(),
        };
        return () => update(args);
      });
      if (clearsComposer.current) {
        setMessage("");
        setDraft(null);
      }
      setAssigning(false);
    } catch (caught) {
      setError(describeError(caught, "The case could not be updated."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const save = () =>
    perform(
      {
        ...(nextState !== undefined ? { nextState } : {}),
        ...(wrote && mode === "reply" ? { publicNote: message.trim() } : {}),
        ...(wrote && mode === "note" ? { internalNote: message.trim() } : {}),
        reason: [
          ...(wrote
            ? [mode === "reply" ? "Replied to the reporter" : "Added an internal note"]
            : []),
          ...(nextState !== undefined
            ? [`Moved case to ${supportCaseStateLabels[nextState]}`]
            : []),
        ].join(". "),
      },
      true,
    );

  return (
    <Section title="Manage case">
      <Action
        accent={palette.setup}
        label={supportCase.ownerName ? "Change owner" : "Assign owner"}
        disabled={busy || pending}
        onPress={() => setAssigning(true)}
      />
      <Sheet title="Assign owner" visible={assigning} onClose={() => setAssigning(false)}>
        <Meta>Choose yourself to take the case, or hand it to another staff member.</Meta>
        {owners === undefined ? (
          <Meta>Loading staff…</Meta>
        ) : owners.length === 0 ? (
          <Meta>No eligible staff are available.</Meta>
        ) : null}
        {owners?.map((owner) => (
          <Row
            key={owner.personId}
            label={owner.displayName}
            detail={
              owner.personId === supportCase.ownerPersonId ? "Current owner" : "Assign this case"
            }
            onPress={() => {
              if (!busy && !pending && owner.personId !== supportCase.ownerPersonId) {
                void perform({
                  nextOwnerPersonId: owner.personId,
                  reason: `Assigned case to ${owner.displayName}`,
                });
              }
            }}
          />
        ))}
        {supportCase.ownerPersonId ? (
          <Action
            label="Return to unassigned"
            disabled={busy || pending}
            onPress={() =>
              perform({
                clearOwner: true,
                reason: "Returned case to the unassigned help desk queue",
              })
            }
          />
        ) : null}
        {busy ? <Meta>Saving owner…</Meta> : null}
        {error ? <Problem>{error}</Problem> : null}
        {pending ? <Action label="Confirm earlier change" disabled={busy} onPress={save} /> : null}
      </Sheet>
      <Meta>Status</Meta>
      <ChipRow
        options={supportStatusChoices(supportCase.state).map(
          (value) => [value, supportCaseStateLabels[value]] as const,
        )}
        selected={state}
        onSelect={(value) => {
          if (!busy && !pending) setDraft({ version: supportCase.version, state: value });
        }}
      />
      <ChipRow
        options={[
          ["reply", "Reply to reporter"],
          ["note", "Internal note"],
        ]}
        selected={mode}
        onSelect={(value) => {
          if (!busy && !pending) setMode(value);
        }}
      />
      <Field
        label={mode === "reply" ? "Reply to reporter" : "Internal note · staff only"}
        multiline
        maxLength={2000}
        placeholder={
          mode === "reply" ? "Write to the person who reported this." : "Add context for staff."
        }
        value={message}
        onChangeText={setMessage}
        editable={!busy && !pending}
      />
      {error ? <Problem>{error}</Problem> : null}
      {pending ? <Meta>Confirm the earlier change before making another.</Meta> : null}
      <Action
        accent={palette.setup}
        label={busy ? "Saving…" : pending ? "Confirm earlier change" : "Save case"}
        disabled={busy || (!pending && !wrote && nextState === undefined)}
        onPress={save}
      />
    </Section>
  );
}
