import { api } from "@code2create/backend/api";
import {
  supportCaseCategoryLabels,
  supportCaseCategoryOrder,
  supportCaseStateLabels,
} from "@code2create/domain";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { randomUUID } from "expo-crypto";
import { useRouter } from "expo-router";
import { useRef, useState } from "react";

import {
  Action,
  Body,
  Card,
  ChipRow,
  Field,
  Lead,
  Meta,
  Problem,
  Section,
  Sheet,
} from "@/components/ui";
import { CaseListSkeleton } from "@/components/skeletons";
import { describeError } from "@/lib/errors";
import { useMutationAttempt } from "@/lib/mutation-attempt";
import { orderStaffCases, supportFilters, type StaffCase } from "@/lib/support-desk";
import { palette } from "@/theme";

export function SupportDeskPanel({ eventSlug }: { eventSlug: string }) {
  const [filter, setFilter] = useState<(typeof supportFilters)[number][0]>("active");
  const list = useQuery(api.support.staffList, { eventSlug, state: filter });
  const router = useRouter();
  return (
    <>
      <ChipRow
        options={supportFilters}
        selected={filter}
        onSelect={setFilter}
        accent={palette.setup}
      />
      {list === undefined ? (
        <CaseListSkeleton />
      ) : (
        <>
          <Lead
            accent={palette.setup}
            value={String(list.totals.open + list.totals.investigating + list.totals.waiting)}
            unit="open cases"
            detail={`${list.totals.awaitingStaffReply} owed a reply · ${list.totals.unowned} unassigned`}
          />
          {list.canCreate ? <CreateStaffCase eventSlug={eventSlug} /> : null}
          <Section title="Help desk">
            {list.cases.length === 0 ? <Meta>No cases in this view.</Meta> : null}
            {orderStaffCases(list.cases).map((row) => (
              <Card key={row.id} onPress={() => router.push(`/help/${row.publicCode}`)}>
                <Body>
                  {row.reporterName} · {supportCaseCategoryLabels[row.category]}
                </Body>
                <Meta>
                  {row.publicCode} · {supportCaseStateLabels[row.state]}
                </Meta>
                <Meta>
                  {row.ownerName ?? "Unassigned"}
                  {row.awaitingStaffReply && row.state !== "resolved" && row.state !== "closed"
                    ? " · Owed a reply"
                    : ""}
                </Meta>
                <Meta>
                  {row.description.length > 180
                    ? `${row.description.slice(0, 180)}…`
                    : row.description}
                </Meta>
              </Card>
            ))}
          </Section>
          {list.caseLimitReached ? (
            <Meta>Showing the 80 most recently changed requests in this view.</Meta>
          ) : null}
        </>
      )}
    </>
  );
}

function CreateStaffCase({ eventSlug }: { eventSlug: string }) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<StaffCase["category"]>("queue");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const create = useMutation(api.support.createStaff);
  const attempt = useMutationAttempt<FunctionReturnType<typeof api.support.createStaff>>();
  const pending = attempt.hasPending("create-staff-case");
  const router = useRouter();
  const submit = async () => {
    if (busyRef.current || (!pending && description.trim().length < 10)) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await attempt.run("create-staff-case", () => {
        const args = {
          eventSlug,
          category,
          description: description.trim(),
          clientOperationId: randomUUID(),
        };
        return () => create(args);
      });
      setDescription("");
      setOpen(false);
      router.push(`/help/${result.publicCode}`);
    } catch (caught) {
      setError(describeError(caught, "The case could not be created."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      <Action accent={palette.setup} label="Log a walk-up issue" onPress={() => setOpen(true)} />
      <Sheet title="Log a walk-up issue" visible={open} onClose={() => setOpen(false)}>
        <ChipRow
          options={supportCaseCategoryOrder.map(
            (value) => [value, supportCaseCategoryLabels[value]] as const,
          )}
          selected={category}
          onSelect={(value) => {
            if (!busy && !pending) setCategory(value);
          }}
        />
        <Field
          label="What happened?"
          placeholder="Describe the issue and who needs help."
          value={description}
          onChangeText={setDescription}
          multiline
          maxLength={2000}
          editable={!busy && !pending}
        />
        {error ? <Problem>{error}</Problem> : null}
        {pending ? <Meta>Confirm this issue before writing another.</Meta> : null}
        <Action
          accent={palette.setup}
          label={busy ? "Saving…" : pending ? "Confirm issue" : "Log issue"}
          disabled={busy || (!pending && description.trim().length < 10)}
          onPress={submit}
        />
      </Sheet>
    </>
  );
}
