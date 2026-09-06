import { api } from "@code2create/backend/api";
import type { FunctionReturnType } from "convex/server";
import { useAction } from "convex/react";
import { useState } from "react";
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Svg, { Path } from "react-native-svg";

import { describeError } from "@/lib/errors";
import { palette, radius } from "@/theme";

function GithubMark({
  dim = false,
  size = 20,
}: {
  dim?: boolean;
  size?: number;
}) {
  return (
    <Svg height={size} viewBox="0 0 16 16" width={size}>
      <Path
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
        fill={dim ? palette.faint : palette.text}
      />
    </Svg>
  );
}

function FigmaMark({
  dim = false,
  size = 20,
}: {
  dim?: boolean;
  size?: number;
}) {
  const height = size;
  const width = (size * 38) / 57;
  return (
    <Svg height={height} viewBox="0 0 38 57" width={width}>
      <Path
        d="M9.5 0A9.5 9.5 0 0 0 0 9.5 9.5 9.5 0 0 0 9.5 19H19V0H9.5Z"
        fill={dim ? palette.faint : "#F24E1E"}
      />
      <Path
        d="M28.5 0H19v19h9.5a9.5 9.5 0 0 0 0-19Z"
        fill={dim ? palette.faint : "#FF7262"}
      />
      <Path
        d="M9.5 19A9.5 9.5 0 0 0 0 28.5 9.5 9.5 0 0 0 9.5 38H19V19H9.5Z"
        fill={dim ? palette.faint : "#A259FF"}
      />
      <Path
        d="M38 28.5a9.5 9.5 0 1 1-19 0 9.5 9.5 0 0 1 19 0Z"
        fill={dim ? palette.faint : "#1ABCFE"}
      />
      <Path
        d="M9.5 38A9.5 9.5 0 0 0 0 47.5 9.5 9.5 0 0 0 9.5 57c5.25 0 9.5-4.25 9.5-9.5V38H9.5Z"
        fill={dim ? palette.faint : "#0ACF83"}
      />
    </Svg>
  );
}

type ReviewWorkspace = FunctionReturnType<typeof api.reviewer.reviewWorkspace>;
type GithubEvidence = ReviewWorkspace["evidence"]["github"][number];
type GithubBrowseResult = FunctionReturnType<
  typeof api.reviewEvidenceActions.browseGithub
>;
type TeamContext = ReviewWorkspace["teamContext"];
type PriorReview = TeamContext["priorReviews"][number];

export function ProjectEvidence({
  eventSlug,
  review,
}: {
  eventSlug: string;
  review: ReviewWorkspace;
}) {
  const [linkError, setLinkError] = useState(false);
  const context = review.teamContext;
  return (
    <View style={styles.section}>
      <View style={styles.head}>
        <Text style={styles.teamName}>{context.team.name}</Text>
        <Text style={styles.trackLine}>{context.team.publicCode}</Text>
      </View>

      <View style={styles.ideaCard}>
        <Text style={styles.idea}>{review.project.initialIdea}</Text>
      </View>
      <Text style={styles.meta}>
        {context.team.memberCount} members · v{context.team.projectVersion}{" "}
        submitted {formatMoment(context.team.projectSubmittedAt)}
      </Text>

      {review.project.intakeResponses.map((response) => (
        <View key={response.ordinal}>
          <Text style={styles.question}>{response.question}</Text>
          <Text style={styles.body}>{response.answer}</Text>
        </View>
      ))}
      {review.project.additionalInformation ? (
        <View>
          <Text style={styles.question}>
            Any additional information or links you want to share (please, no
            PPTs)
          </Text>
          <Text selectable style={styles.body}>
            {review.project.additionalInformation}
          </Text>
        </View>
      ) : null}
      <View style={styles.evidenceHeader}>
        <Text style={styles.sectionLabel}>Team update</Text>
      </View>
      {review.project.latestCheckpoint ? (
        <View style={styles.evidenceCard}>
          <Text style={styles.value}>
            {review.project.latestCheckpoint.displayName}
          </Text>
          <Text style={styles.meta}>
            Submitted{" "}
            {formatMoment(review.project.latestCheckpoint.submittedAt)} ·{" "}
            {review.project.latestCheckpoint.timing.replace("_", " ")}
          </Text>
          <Text style={styles.question}>
            {review.project.latestCheckpoint.updateText}
          </Text>
          <Text style={styles.meta}>
            {review.project.latestCheckpoint.followUpQuestion}
          </Text>
          <Text style={styles.body}>
            {review.project.latestCheckpoint.followUpAnswer}
          </Text>
        </View>
      ) : (
        <Text style={styles.guidance}>No team update yet.</Text>
      )}
      <View style={styles.evidenceHeader}>
        <Text style={styles.sectionLabel}>Previous reviews</Text>
        {context.priorReviews.length > 0 ? (
          <Text style={styles.meta}>{context.priorReviews.length}</Text>
        ) : null}
      </View>
      {context.priorReviews.map((prior) => (
        <PriorReviewCard key={prior.id} prior={prior} />
      ))}
      {context.priorReviews.length === 0 ? (
        <Text style={styles.guidance}>
          This is the team&apos;s first review.
        </Text>
      ) : null}
      <View style={styles.evidenceHeader}>
        <Text style={styles.sectionLabel}>Code and design</Text>
        {review.evidence.expectedResourceCount > 0 ? (
          <Text style={styles.meta}>
            {review.evidence.capturedResourceCount} of{" "}
            {review.evidence.expectedResourceCount} captured
          </Text>
        ) : null}
      </View>
      {review.evidence.expectedResourceCount > 0 ? (
        <Text style={styles.guidance}>
          Captured when this review was fixed. Later changes do not appear here.
        </Text>
      ) : null}
      {review.evidence.github.map((repository) => (
        <GithubEvidenceCard
          eventSlug={eventSlug}
          key={repository.bindingId}
          repository={repository}
          reviewSessionId={review.id}
        />
      ))}
      {review.evidence.figmaFileUrl ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="View Figma design"
          style={styles.evidenceCard}
          onPress={() => {
            const url = review.evidence.figmaFileUrl;
            if (url) void Linking.openURL(url).catch(() => setLinkError(true));
          }}
        >
          <FigmaMark size={30} />
        </Pressable>
      ) : null}
      {linkError ? (
        <Text style={styles.guidance}>
          Couldn’t open the design link. Try again.
        </Text>
      ) : null}
      {review.evidence.expectedResourceCount === 0 &&
      !review.evidence.figmaFileUrl ? (
        <View style={styles.noEvidence}>
          <GithubMark dim size={30} />
          <FigmaMark dim size={30} />
        </View>
      ) : null}
    </View>
  );
}

function PriorReviewCard({ prior }: { prior: PriorReview }) {
  const completed = prior.outcome === "completed";
  return (
    <View style={styles.evidenceCard}>
      <View style={styles.priorHeading}>
        <Text style={styles.value}>{prior.roundName}</Text>
        <Text style={completed ? styles.priorReviewed : styles.priorCancelled}>
          {completed ? "Reviewed" : "Cancelled"}
        </Text>
      </View>
      <Text style={styles.meta}>
        {prior.panelName} · {formatMoment(prior.endedAt)}
      </Text>
      {completed ? (
        <>
          {prior.sharedFindings ? (
            <>
              <Text style={styles.question}>Panel findings</Text>
              <Text style={styles.body}>{prior.sharedFindings}</Text>
            </>
          ) : null}
          {prior.sharedCommitments ? (
            <>
              <Text style={styles.question}>Team commitments</Text>
              <Text style={styles.body}>{prior.sharedCommitments}</Text>
            </>
          ) : null}
          {!prior.sharedFindings && !prior.sharedCommitments ? (
            <Text style={styles.guidance}>
              The panel completed this review without shared notes.
            </Text>
          ) : null}
        </>
      ) : (
        <Text style={styles.guidance}>
          This review ended before the panel finished.
        </Text>
      )}
    </View>
  );
}

function GithubEvidenceCard({
  eventSlug,
  reviewSessionId,
  repository,
}: {
  eventSlug: string;
  reviewSessionId: ReviewWorkspace["id"];
  repository: GithubEvidence;
}) {
  const browseGithub = useAction(api.reviewEvidenceActions.browseGithub);
  const [result, setResult] = useState<GithubBrowseResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const browse = async (path: string) => {
    if (busy || !repository.snapshot) return;
    setBusy(true);
    setError(null);
    try {
      setResult(
        await browseGithub({
          eventSlug,
          reviewSessionId,
          bindingId: repository.bindingId,
          path,
        }),
      );
    } catch (caught) {
      setError(
        errorMessage(caught, "The pinned repository could not be opened."),
      );
    } finally {
      setBusy(false);
    }
  };

  const snapshot = repository.snapshot;
  return (
    <View style={styles.evidenceCard}>
      <View style={styles.providerRow}>
        <GithubMark />
        <Text numberOfLines={1} style={[styles.value, styles.providerName]}>
          {repository.repositoryName}
        </Text>
      </View>
      <Text style={styles.meta}>
        {repositoryKindName(repository.kind)} · {repository.purpose}
      </Text>
      <Text style={styles.meta}>
        {repository.trackedBranch}
        {repository.rootPath ? `/${repository.rootPath}` : ""} ·{" "}
        {evidenceState(repository.stateAtCapture)}
      </Text>
      {snapshot ? (
        <>
          <Text style={styles.fact}>
            {shortSha(snapshot.headSha)} · topic{" "}
            {evidenceState(snapshot.topicState)} · {snapshot.completeness}
          </Text>
          <Text style={styles.meta}>
            {snapshot.commitCount} commits · +{snapshot.additions} −
            {snapshot.deletions} · {snapshot.changedFiles} files
          </Text>
          {snapshot.languageBytes.length > 0 ? (
            <Text style={styles.meta}>
              {snapshot.languageBytes
                .slice(0, 5)
                .map((item) => item.language)
                .join(", ")}
            </Text>
          ) : null}
          <Text style={styles.meta}>
            Captured {formatMoment(snapshot.capturedAt)}
          </Text>
          {!result ? (
            <EvidenceButton
              disabled={busy}
              label={busy ? "Opening…" : "Browse pinned files"}
              onPress={() => browse("")}
            />
          ) : (
            <GithubBrowser busy={busy} onBrowse={browse} result={result} />
          )}
        </>
      ) : (
        <Text style={styles.error}>
          No repository snapshot was available at this checkpoint.
        </Text>
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

function GithubBrowser({
  busy,
  onBrowse,
  result,
}: {
  busy: boolean;
  onBrowse: (path: string) => Promise<void>;
  result: GithubBrowseResult;
}) {
  if (result.kind === "directory") {
    return (
      <View style={styles.browser}>
        <View style={styles.browserHeading}>
          <Text style={styles.fact}>/{result.path}</Text>
          {result.path ? (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => void onBrowse(parentPath(result.path))}
            >
              <Text style={styles.textButton}>Up</Text>
            </Pressable>
          ) : null}
        </View>
        {result.entries.map((entry) => (
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            key={`${entry.type}:${entry.path}`}
            onPress={() => void onBrowse(entry.path)}
            style={styles.fileRow}
          >
            <Text numberOfLines={1} style={styles.fileName}>
              {entry.type === "directory" ? "› " : ""}
              {entry.name}
            </Text>
            <Text style={styles.meta}>
              {entry.type === "file" ? formatBytes(entry.size) : entry.type}
            </Text>
          </Pressable>
        ))}
        {result.entries.length === 0 ? (
          <Text style={styles.meta}>This directory is empty.</Text>
        ) : null}
        {result.truncated ? (
          <Text style={styles.error}>
            Directory limit reached; some entries are not shown.
          </Text>
        ) : null}
      </View>
    );
  }
  if (result.kind === "text_file") {
    return (
      <View style={styles.browser}>
        <View style={styles.browserHeading}>
          <Text numberOfLines={1} style={styles.fact}>
            {result.path}
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => void onBrowse(parentPath(result.path))}
          >
            <Text style={styles.textButton}>Back</Text>
          </Pressable>
        </View>
        <Text style={styles.meta}>
          {shortSha(result.sha)} · {formatBytes(result.size)}
        </Text>
        <ScrollView horizontal style={styles.codeViewport}>
          <Text selectable style={styles.code}>
            {result.text || "Empty file"}
          </Text>
        </ScrollView>
      </View>
    );
  }
  return (
    <View style={styles.browser}>
      <View style={styles.browserHeading}>
        <Text numberOfLines={1} style={styles.fact}>
          {result.path}
        </Text>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => void onBrowse(parentPath(result.path))}
        >
          <Text style={styles.textButton}>Back</Text>
        </Pressable>
      </View>
      <Text style={styles.meta}>
        {result.type} · {formatBytes(result.size)} ·{" "}
        {evidenceState(result.reason)}
      </Text>
    </View>
  );
}

function EvidenceButton({
  label,
  onPress,
  disabled,
  secondary = false,
}: {
  label: string;
  onPress: () => void | Promise<void>;
  disabled: boolean;
  secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        secondary ? styles.secondaryButton : null,
        disabled ? styles.disabled : null,
      ]}
    >
      <Text
        style={[
          styles.buttonText,
          secondary ? styles.secondaryButtonText : null,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function parentPath(path: string) {
  const segments = path.split("/").filter(Boolean);
  segments.pop();
  return segments.join("/");
}

function repositoryKindName(value: GithubEvidence["kind"]) {
  if (value === "full_product") return "Full product";
  if (value === "frontend") return "Frontend";
  if (value === "backend_api") return "Backend API";
  if (value === "mobile_app") return "Mobile app";
  if (value === "desktop_app") return "Desktop app";
  if (value === "ai_ml") return "AI / ML";
  if (value === "data_pipeline") return "Data pipeline";
  if (value === "hardware_firmware") return "Hardware / firmware";
  if (value === "infrastructure") return "Infrastructure";
  if (value === "library_sdk") return "Library / SDK";
  if (value === "docs_research") return "Docs / research";
  return "Other";
}

function shortSha(value: string) {
  return value.slice(0, 8);
}

function formatMoment(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}

function formatBytes(value: number) {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${Math.ceil(value / 1_024)} KB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`;
}

function evidenceState(value: string) {
  return value.toLowerCase().replaceAll("_", " ");
}

function errorMessage(caught: unknown, fallback: string) {
  return describeError(caught, fallback);
}

const styles = StyleSheet.create({
  section: { gap: 12, paddingTop: 8 },
  head: { gap: 4 },
  teamName: {
    color: palette.text,
    fontSize: 24,
    fontWeight: "600",
    letterSpacing: -0.5,
  },
  trackLine: { color: palette.muted, fontSize: 14, lineHeight: 20 },
  ideaCard: {
    backgroundColor: palette.tile,
    borderRadius: radius.tile,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginTop: 4,
  },
  sectionLabel: {
    color: palette.muted,
    fontSize: 13,
    fontWeight: "600",
  },
  idea: { color: palette.text, fontSize: 17, lineHeight: 25 },
  question: {
    color: palette.muted,
    fontSize: 14,
    lineHeight: 21,
    marginTop: 8,
  },
  body: { color: palette.muted, fontSize: 15, lineHeight: 22 },
  guidance: { color: palette.faint, fontSize: 13, lineHeight: 19 },
  meta: { color: palette.faint, fontSize: 13, lineHeight: 18 },
  value: { color: palette.text, fontSize: 16, lineHeight: 22 },
  fact: { color: palette.muted, fontSize: 14, lineHeight: 20 },
  error: { color: palette.urgent, fontSize: 13, lineHeight: 19 },
  evidenceHeader: {
    marginTop: 14,
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 12,
  },
  evidenceCard: {
    borderTopWidth: 1,
    borderTopColor: palette.tile,
    paddingTop: 12,
    gap: 5,
  },
  providerRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  providerName: { flex: 1 },
  noEvidence: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 22,
    paddingVertical: 18,
  },
  priorHeading: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 12,
  },
  priorReviewed: { color: palette.judging, fontSize: 13, lineHeight: 18 },
  priorCancelled: { color: palette.faint, fontSize: 13, lineHeight: 18 },
  browser: {
    marginTop: 7,
    gap: 8,
    borderWidth: 1,
    borderColor: palette.tile,
    borderRadius: radius.tile,
    padding: 10,
  },
  browserHeading: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  fileRow: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: palette.tile,
  },
  fileName: {
    color: palette.muted,
    fontSize: 13,
    lineHeight: 18,
    flexShrink: 1,
  },
  textButton: {
    color: palette.muted,
    fontSize: 13,
    textDecorationLine: "underline",
  },
  codeViewport: {
    maxHeight: 360,
    backgroundColor: palette.background,
    borderRadius: radius.tile,
    padding: 10,
  },
  code: {
    color: palette.text,
    fontFamily: "monospace",
    fontSize: 12,
    lineHeight: 18,
  },
  button: {
    height: 40,
    borderRadius: radius.control,
    backgroundColor: palette.judging,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 16,
    alignSelf: "flex-start",
    marginTop: 5,
  },
  buttonText: { color: palette.onJudging, fontSize: 14, fontWeight: "600" },
  secondaryButton: { backgroundColor: palette.tile },
  secondaryButtonText: { color: palette.text, fontWeight: "400" },
  disabled: { opacity: 0.5 },
});
