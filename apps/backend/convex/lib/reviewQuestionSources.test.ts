import { describe, expect, test } from "vitest";
import {
  reviewableSourcePath,
  reviewSourceText,
  reviewSourceBatches,
} from "./reviewQuestionSources";
import { reviewQuestionCallbackSchema } from "./reviewQuestionProtocol";

describe("review question source preparation", () => {

  test("omits credential, generated and dependency files", () => {
    for (const path of [
      ".env",
      ".env.local",
      "secrets.json",
      "node_modules/lib/main.ts",
      "dist/main.js",
    ])
      expect(reviewableSourcePath(path)).toBe(false);
    for (const path of [
      "README.md",
      "src/app.tsx",
      "docs/architecture.md",
      "package.json",
      "src/credentials.ts",
      "pnpm-lock.yaml",
      ".env.example",
      "app.R",
      "logic.ex",
      "Makefile",
    ])
      expect(reviewableSourcePath(path)).toBe(true);
    expect(
      reviewSourceText(
        "Contact example@vitstudent.ac.in. ghp_1234567890abcdefghijklmnop",
      ),
    ).not.toContain("example@");
    expect(reviewSourceText("ghp_1234567890abcdefghijklmnop")).toBe(
      "[credential removed]",
    );
  });
  test("all files and long content survive request batching, including Unicode", () => {
    const texts = Array.from({ length: 240 }, (_, i) => ({
      id: `file:${i}`,
      kind: "github" as const,
      title: `src/feature${i}.ts`,
      text: `${i}:` + "🤝x\n".repeat(i === 4 ? 90000 : 30),
      coverage: "captured" as const,
    }));
    const batches = reviewSourceBatches(texts, 80000);
    expect(batches.length).toBeGreaterThan(4);
    for (const source of texts)
      expect(
        batches
          .flat()
          .filter(
            (chunk) =>
              chunk.id === source.id ||
              chunk.id.startsWith(`${source.id}:chunk:`),
          )
          .map((chunk) => chunk.text)
          .join(""),
      ).toBe(source.text);
    for (const batch of batches)
      expect(batch.reduce((n, s) => n + s.text.length, 0)).toBeLessThanOrEqual(
        80000,
      );
    expect(
      reviewSourceText(
        "const deadline = 1800000000000; const ratio = 12345678;",
      ),
    ).toContain("1800000000000");
  });
  test("callback contract has no grading fields", () => {
    const payload = {
      protocolVersion: "review-questions-v3",
      agentVersion: "review-questions-v3",
      jobId: "job",
      attempt: 1,
      sourceChecksum: "a".repeat(64),
      payloadChecksum: "b".repeat(64),
      status: "ready",
      partId: "final",
      partAttempt: 1,
      questions: [
        {
          question: "Why did you choose this architecture?",
          reason: "The README describes two services.",
          criterionKey: "technical_execution",
          sourceIds: ["project"],
        },
      ],
    };
    expect(reviewQuestionCallbackSchema.safeParse(payload).success).toBe(true);
    expect(
      reviewQuestionCallbackSchema.safeParse({ ...payload, score: 4 }).success,
    ).toBe(false);
    expect(
      reviewQuestionCallbackSchema.safeParse({
        ...payload,
        questions: [{ ...payload.questions[0], rating: 4 }],
      }).success,
    ).toBe(false);
  });
});
