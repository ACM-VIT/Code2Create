import { api } from "@code2create/backend/api";
import {
  supportCaseCategoryLabels,
  supportCaseCategoryOrder,
  supportCaseStateLabels,
} from "@code2create/domain";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { randomUUID } from "expo-crypto";
import { useRef, useState } from "react";
import { useRouter } from "expo-router";
import { Platform, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  Action,
  Body,
  Card,
  ChipRow,
  Lead,
  Field,
  Meta,
  Problem,
  Row,
  Section,
  Sheet,
} from "@/components/ui";
import { describeError } from "@/lib/errors";
import { useMutationAttempt } from "@/lib/mutation-attempt";
import type { ReviewerRuntime } from "@/lib/runtime";
import { palette } from "@/theme";
import { CaseListSkeleton } from "@/components/skeletons";

type SupportCase = FunctionReturnType<typeof api.support.mine>[number];
type SupportCaseId = SupportCase["id"];
type SupportCategory = SupportCase["category"];
type SupportState = SupportCase["state"];
type CreateSelfResult = FunctionReturnType<typeof api.support.createSelf>;
type ReplySelfResult = FunctionReturnType<typeof api.support.replySelf>;

const categories = supportCaseCategoryOrder.map(
  (category) => [category, supportCaseCategoryLabels[category]] as const,
);

const quickReports: readonly (readonly [SupportCategory, string])[] = [
  ["safety", "Someone is unsafe or unwell"],
  ["scanner_device", "This phone or its scanner is misbehaving"],
  ["missing_scan", "A scan did not record"],
  ["attendance_credential", "A card or badge will not work"],
];

const stateRank: Record<SupportState, number> = {
  waiting: 0,
  open: 1,
  investigating: 2,
  resolved: 3,
  closed: 4,
};

export function SupportPanel({
  canCreate,
  runtime,
}: {
  canCreate: boolean;
  runtime: ReviewerRuntime;
}) {
  const eventSlug = runtime.configuration.eventSlug;
  const cases = useQuery(api.support.mine, { eventSlug });
  const createCase = useMutation(api.support.createSelf);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [quickAreaHeight, setQuickAreaHeight] = useState(0);
  const [reporting, setReporting] = useState(false);
  const [category, setCategory] = useState<SupportCategory>("reviewer_device");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const createAttempt = useMutationAttempt<CreateSelfResult>();
  const createPending = createAttempt.hasPending("create-support-case");

  const sorted = cases
    ? [...cases].sort((left, right) => stateRank[left.state] - stateRank[right.state])
    : undefined;
  const open = sorted?.filter((row) => row.state !== "resolved" && row.state !== "closed") ?? [];
  const submit = async () => {
    const normalizedDescription = description.trim();
    if (busyRef.current || normalizedDescription.length < 10) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await createAttempt.run("create-support-case", () => {
        const args = {
          eventSlug,
          category,
          description: normalizedDescription,
          clientOperationId: randomUUID(),
        };
        return () => createCase(args);
      });
      setDescription("");
      setReporting(false);
      router.push(`/help/${result.publicCode}`);
    } catch (caught) {
      setError(errorMessage(caught, "The case could not be created."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  if (sorted === undefined) return <CaseListSkeleton />;

  const quickCount =
    quickAreaHeight === 0
      ? 2
      : Math.max(2, Math.min(quickReports.length, Math.floor((quickAreaHeight - 34) / 66)));

  return (
    <View
      style={[
        styles.fixedRoot,
        Platform.OS === "android" ? { paddingBottom: 18 + insets.bottom } : { paddingBottom: 18 },
      ]}
    >
      <Lead
        accent={palette.setup}
        detail={
          open.length > 0
            ? "The help desk replies here."
            : "Nothing of yours is waiting on the help desk."
        }
        unit={open.length === 1 ? "open case" : "open cases"}
        value={String(open.length)}
      />

      {sorted.length > 0 ? (
        <Section
          title="Your cases"
          {...(open.length > 0
            ? {
                lead: `${open.length} still ${open.length === 1 ? "open" : "open"} — the help desk replies here.`,
              }
            : { lead: "Everything you reported is resolved." })}
        >
          {sorted.map((supportCase) => (
            <Card
              key={supportCase.id}
              onPress={() => router.push(`/help/${supportCase.publicCode}`)}
            >
              <View style={styles.row}>
                <Text style={styles.code}>{supportCase.publicCode}</Text>
                <Text style={styles.state}>{supportCaseStateLabels[supportCase.state]}</Text>
              </View>
              <Meta>{supportCaseCategoryLabels[supportCase.category]}</Meta>
            </Card>
          ))}
        </Section>
      ) : null}

      <View
        style={styles.quickArea}
        onLayout={(event) => setQuickAreaHeight(event.nativeEvent.layout.height)}
      >
        {canCreate ? (
          <Section title="Something wrong?">
            {quickReports.slice(0, quickCount).map(([value, label]) => (
              <Row
                key={value}
                label={label}
                onPress={() => {
                  if (!createPending) setCategory(value);
                  setReporting(true);
                }}
              />
            ))}
          </Section>
        ) : null}
      </View>

      {canCreate ? (
        <Action
          accent={palette.setup}
          label="Report something else"
          onPress={() => setReporting(true)}
        />
      ) : null}

      {canCreate ? (
        <Sheet
          onClose={() => {
            setReporting(false);
          }}
          title="Report a problem"
          visible={reporting}
        >
          <ChipRow
            accent={palette.setup}
            onSelect={(value: SupportCategory) => {
              if (!createPending) setCategory(value);
            }}
            options={categories}
            selected={category}
          />
          <Field
            editable={!busy && !createPending}
            label="What happened"
            maxLength={2000}
            multiline
            onChangeText={(value) => {
              setDescription(value);
            }}
            placeholder="Short and factual is enough."
            value={description}
          />
          {error ? <Problem>{error}</Problem> : null}
          {createPending ? <Meta>Confirm the earlier report before writing another.</Meta> : null}
          <Action
            accent={palette.setup}
            disabled={busy || description.trim().length < 10}
            label={busy ? "Sending…" : createPending ? "Confirm report" : "Send to the help desk"}
            onPress={submit}
          />
        </Sheet>
      ) : null}
    </View>
  );
}

type SupportCaseDetailResult = NonNullable<
  FunctionReturnType<typeof api.support.detailByPublicCode>
>;

export function SupportCaseDetail({
  detail,
  eventSlug,
  supportCaseId,
}: {
  detail: SupportCaseDetailResult;
  eventSlug: string;
  supportCaseId: SupportCaseId;
}) {
  const reply = useMutation(api.support.replySelf);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const replyAttempt = useMutationAttempt<ReplySelfResult>();
  const replyPending = replyAttempt.hasPending("reply-to-support-case");

  const sendReply = async () => {
    const normalizedMessage = message.trim();
    if (busyRef.current || normalizedMessage.length < 2) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await replyAttempt.run("reply-to-support-case", () => {
        const args = {
          eventSlug,
          supportCaseId,
          expectedVersion: detail.supportCase.version,
          message: normalizedMessage,
          clientOperationId: randomUUID(),
        };
        return () => reply(args);
      });
      setMessage("");
    } catch (caught) {
      setError(errorMessage(caught, "The reply could not be sent."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <>
      <Card>
        <View style={styles.row}>
          <Meta>{supportCaseCategoryLabels[detail.supportCase.category]}</Meta>
          <Text style={styles.state}>{supportCaseStateLabels[detail.supportCase.state]}</Text>
        </View>
        <Body>{detail.supportCase.description}</Body>
      </Card>

      {detail.actions.map((action) => (
        <Card key={action.id}>
          <View style={styles.row}>
            <Text style={styles.actor}>{action.actorName}</Text>
            <Meta>{formatTime(action.createdAt)}</Meta>
          </View>
          <Meta>{actionLabel(action.kind, action.nextState)}</Meta>
          {action.body && action.kind !== "opened" ? <Body>{action.body}</Body> : null}
        </Card>
      ))}

      {detail.supportCase.canReply ? (
        <>
          <Field
            editable={!busy && !replyPending}
            label="Reply"
            maxLength={2000}
            multiline
            onChangeText={(value) => {
              setMessage(value);
            }}
            placeholder="Add anything that would help."
            value={message}
          />
          {error ? <Problem>{error}</Problem> : null}
          <Action
            accent={palette.setup}
            disabled={busy || message.trim().length < 2}
            label={busy ? "Sending…" : replyPending ? "Confirm reply" : "Send reply"}
            onPress={sendReply}
          />
        </>
      ) : (
        <Meta>This case is closed. Report a new one if it comes back.</Meta>
      )}
    </>
  );
}

function actionLabel(
  kind: NonNullable<FunctionReturnType<typeof api.support.detail>>["actions"][number]["kind"],
  nextState?: SupportState,
) {
  if (kind === "opened") return "Case opened";
  if (kind === "reporter_reply") return "You replied";
  if (kind === "public_note") return "The help desk replied";
  if (kind === "state_changed") {
    return `Now ${supportCaseStateLabels[nextState ?? "open"].toLowerCase()}`;
  }
  return "Case updated";
}

function formatTime(value: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    value,
  );
}

function errorMessage(caught: unknown, fallback: string) {
  return describeError(caught, fallback);
}

const styles = StyleSheet.create({
  fixedRoot: { flex: 1, paddingHorizontal: 20, paddingTop: 14, gap: 18 },
  quickArea: { flex: 1 },
  row: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 12 },
  code: { color: palette.text, fontSize: 17, fontWeight: "600" },
  state: { color: palette.muted, fontSize: 15 },
  actor: { color: palette.text, fontSize: 15, fontWeight: "600" },
});
