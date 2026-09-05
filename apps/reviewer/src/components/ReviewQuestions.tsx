import { api } from "@code2create/backend/api";
import type { FunctionArgs } from "convex/server";
import { useQuery } from "convex/react";
import { useState } from "react";
import { Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { QuietAction, Sheet } from "@/components/ui";
import { palette } from "@/theme";

type ReviewId = FunctionArgs<
  typeof api.reviewQuestions.forReview
>["reviewSessionId"];
export function ReviewQuestions({
  eventSlug,
  reviewSessionId,
}: {
  eventSlug: string;
  reviewSessionId: ReviewId;
}) {
  const [linkError, setLinkError] = useState(false);
  const [open, setOpen] = useState(false);
  const result = useQuery(
    api.reviewQuestions.forReview,
    open ? { eventSlug, reviewSessionId } : "skip",
  );
  return (
    <>
      <QuietAction label="Review brief" onPress={() => setOpen(true)} />
      <Sheet title="Review brief" visible={open} onClose={() => setOpen(false)}>
        <Text style={styles.help}>
          Use a follow-up when it helps the conversation. These prompts are not
          scored.
        </Text>
        {linkError ? (
          <Text style={styles.help}>
            This source could not be opened. Try again from Project details.
          </Text>
        ) : null}
        <ScrollView showsVerticalScrollIndicator={false} style={styles.scroll}>
          {result?.summary ? (
            <Text style={styles.help}>{result.summary}</Text>
          ) : null}
          {result?.coverage &&
          (result.coverage.excluded || result.coverage.unavailable) ? (
            <Text style={styles.source}>
              {result.coverage.excluded} excluded items ·{" "}
              {result.coverage.unavailable} unavailable sources. See project
              details where more context is needed.
            </Text>
          ) : null}
          {result === undefined ? (
            <Text style={styles.help}>Loading…</Text>
          ) : result?.state === "ready" ? (
            result.questions.length === 0 ? (
              <Text style={styles.help}>
                No extra questions are needed. Use the fixed rubric.
              </Text>
            ) : (
              result.questions.map((question, index) => (
                <View key={question.question} style={styles.question}>
                  <Text style={styles.text}>
                    {index + 1}. {question.question}
                  </Text>
                  <Text style={styles.help}>{question.reason}</Text>
                  {question.sourceIds.map((id) => {
                    const source = result.sources.find(
                      (item) => item.id === id,
                    );
                    if (!source) return null;
                    return (
                      <View key={id}>
                        {source.url ? (
                          <QuietAction
                            label={source.title}
                            onPress={() => {
                              if (source.url)
                                void Linking.openURL(source.url).catch(() =>
                                  setLinkError(true),
                                );
                            }}
                          />
                        ) : (
                          <Text style={styles.source}>{source.title}</Text>
                        )}
                        {source.coverage !== "captured" ? (
                          <Text style={styles.source}>
                            {source.coverage === "partial"
                              ? "Partly inspected"
                              : "Content unavailable"}
                          </Text>
                        ) : null}
                      </View>
                    );
                  })}
                </View>
              ))
            )
          ) : (
            <Text style={styles.help}>
              {result &&
              ["queued", "collecting", "generating"].includes(result.state)
                ? "Questions are being prepared. Use the fixed rubric while they load."
                : "Suggested questions aren’t available for this review. Use the fixed rubric and project details."}
            </Text>
          )}
        </ScrollView>
      </Sheet>
    </>
  );
}
const styles = StyleSheet.create({
  scroll: { maxHeight: 400 },
  question: {
    gap: 10,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.faint,
  },
  text: { color: palette.text, fontSize: 17, lineHeight: 24 },
  help: { color: palette.muted, fontSize: 14, lineHeight: 21 },
  source: { color: palette.muted, fontSize: 12, lineHeight: 18 },
});
