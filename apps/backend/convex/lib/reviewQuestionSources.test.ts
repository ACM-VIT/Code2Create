import type { ReviewQuestionSource } from "@code2create/domain";
import { describe, expect, test } from "vitest";
import {
  figmaQuestionNodes,
  reviewableSourcePath,
  reviewSourceText,
  reviewSourceBatches,
} from "./reviewQuestionSources";
import { reviewQuestionCallbackSchema } from "./reviewQuestionProtocol";

describe("review question source preparation", () => {
  test("processes every captured image separately without dropping surrounding text", () => {
    const sources: ReviewQuestionSource[] = Array.from({ length: 48 }, (_, i) => ({
      id: `frame-${i}`, kind: "figma", title: `Frame ${i}`, text: "Captured screen",
      coverage: "captured", image: { factId: `fact-${i}`, sha256: "a".repeat(64) },
    }));
    sources.splice(20, 0, { id: "structure", kind: "figma", title: "Structure", text: "Complete node data", coverage: "captured" });
    const batches = reviewSourceBatches(sources, 80000);
    expect(batches.flat()).toEqual(sources);
    expect(batches.filter((batch) => batch.some((source) => source.image))).toHaveLength(48);
    expect(batches.every((batch) => !batch.some((source) => source.image) || batch.length === 1)).toBe(true);
  });

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
  test("retains complete Figma text and every node without claiming visual inspection", () => {
    const nodes = figmaQuestionNodes(
      JSON.stringify({
        document: {
          id: "0:0",
          type: "DOCUMENT",
          name: "Product",
          children: [
            {
              id: "1:0",
              type: "FRAME",
              name: "Checkout",
              children: [
                { id: "2:0", type: "TEXT", characters: "private@example.com" },
              ],
            },
          ],
        },
      }),
      { id: "figma:file", kind: "figma", title: "Design" },
    );
    expect(nodes).toHaveLength(4);
    const text = JSON.stringify(nodes);
    expect(text).toContain("Checkout");
    expect(text).toContain("Rendered visual appearance");
    expect(text).not.toContain("private@example.com");
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
  test("traverses more than 200 Figma nodes and preserves prototype destinations", () => {
    const nodes = figmaQuestionNodes(
      JSON.stringify({
        document: {
          id: "0:0",
          type: "DOCUMENT",
          children: Array.from({ length: 450 }, (_, i) => ({
            id: `1:${i}`,
            type: "TEXT",
            characters: "a".repeat(700),
            interactions: [{ actions: [{ destinationId: "target" }] }],
          })),
        },
      }),
      { id: "figma:file", kind: "figma", title: "Design" },
    );
    expect(nodes).toHaveLength(452);
    expect(nodes.at(-1)?.text).toContain("a".repeat(700));
    expect(nodes.at(-1)?.text).toContain("target");
  });
  test("callback contract has no grading fields", () => {
    const payload = {
      protocolVersion: "review-questions-v2",
      agentVersion: "review-questions-v2",
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
