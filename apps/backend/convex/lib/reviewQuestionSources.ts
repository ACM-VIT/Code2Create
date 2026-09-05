import { z } from "zod";
import type { ReviewQuestionSource } from "@code2create/domain";

/** Preserve numeric constants, source structure, and node IDs; remove contacts and credentials. */
export function reviewSourceText(text: string) {
  return text
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu,
      "[private key removed]",
    )
    .replace(
      /\b(?:gh[pousr]_|github_pat_|figd_|sk[-_]|api[-_])[A-Za-z0-9_-]{12,}\b/gu,
      "[credential removed]",
    )
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[email removed]")
    .replace(
      /((?:password|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*)["'][^"'\n]+["']/giu,
      '$1"[credential removed]"',
    )
    .replace(
      /((?:phone|mobile|telephone)\s*[:=]\s*["']?)(?:\+?\d[\s().-]*){8,15}/giu,
      "$1[phone removed]",
    );
}
export function excludedSourceReason(path: string) {
  if (
    /(^|\/)(?:\.git|node_modules|vendor|dist|build|coverage|\.next)(\/|$)/iu.test(
      path,
    )
  )
    return "generated or installed dependency";
  if (
    /(^|\/)(?:\.env(?:\..*)?|(?:secrets?|credentials)\.json|.*\.(?:pem|p12|pfx|key)|id_(?:rsa|ed25519))$/iu.test(
      path,
    ) &&
    !/\.env\.(?:example|sample|template)$/iu.test(path)
  )
    return "credential material";
  if (
    /\.(?:png|jpe?g|gif|webp|ico|avif|heic|mp[34]|wav|ogg|mov|pdf|zip|gz|tar|woff2?|ttf|eot|exe|dll|so|dylib|sqlite|db|bin|class|jar|pyc)$/iu.test(
      path,
    )
  )
    return "binary asset; contents require a suitable viewer";
  return null;
}
export function reviewableSourcePath(path: string) {
  return excludedSourceReason(path) === null;
}

/** Limits bound a request, never the number of files or total coverage. */
export function splitReviewSource(
  source: ReviewQuestionSource,
  characters: number,
): ReviewQuestionSource[] {
  if (!Number.isSafeInteger(characters) || characters < 1000)
    throw new Error("Invalid source chunk size.");
  if (source.text.length <= characters) return [source];
  const chunks: ReviewQuestionSource[] = [];
  let offset = 0;
  let line = 1;
  while (offset < source.text.length) {
    let end = Math.min(source.text.length, offset + characters);
    if (
      end < source.text.length &&
      /[\uD800-\uDBFF]/u.test(source.text[end - 1] ?? "")
    )
      end--;
    const text = source.text.slice(offset, end);
    const endLine = line + (text.match(/\n/g)?.length ?? 0);
    chunks.push({
      ...source,
      id: `${source.id}:chunk:${chunks.length + 1}`,
      title: `${source.title.slice(0, 440)} · lines ${line}–${endLine}`,
      ...(source.url?.includes("/blob/")
        ? { url: `${source.url}#L${line}-L${endLine}` }
        : {}),
      text,
    });
    offset = end;
    line = endLine;
  }
  return chunks;
}
export function reviewSourceBatches(
  sources: ReviewQuestionSource[],
  characters: number,
) {
  const batches: ReviewQuestionSource[][] = [];
  let batch: ReviewQuestionSource[] = [];
  let size = 0;
  let bytes = 0;
  for (const source of sources.flatMap((source) =>
    splitReviewSource(source, Math.min(40000, Math.floor(characters / 2))),
  )) {
    const sourceBytes = new TextEncoder().encode(
      JSON.stringify(source),
    ).byteLength;
    if (
      batch.length &&
      (size + source.text.length > characters ||
        bytes + sourceBytes > 300000 ||
        batch.length === 80)
    ) {
      batches.push(batch);
      batch = [];
      size = 0;
      bytes = 0;
    }
    batch.push(source);
    size += source.text.length;
    bytes += sourceBytes;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
const figmaNode = z
  .object({
    id: z.string(),
    type: z.string(),
    name: z.string().optional(),
    children: z.array(z.unknown()).optional(),
  })
  .loose();
/** Every node, complete text, properties, interactions, and parent relationship. */
export function figmaQuestionNodes(
  raw: string,
  source: Omit<ReviewQuestionSource, "text" | "coverage">,
) {
  const file = z
    .object({
      document: z.unknown(),
      components: z.unknown().optional(),
      componentSets: z.unknown().optional(),
      styles: z.unknown().optional(),
    })
    .parse(JSON.parse(raw));
  const sources: ReviewQuestionSource[] = [
    {
      ...source,
      id: `${source.id}:metadata`,
      text: reviewSourceText(
        JSON.stringify({
          components: file.components,
          componentSets: file.componentSets,
          styles: file.styles,
          scope:
            "Complete stored document structure. Rendered visual appearance and runtime behavior have not been inspected.",
        }),
      ),
      coverage: "captured",
    },
  ];
  const stack: { value: unknown; parentId: string | null }[] = [
    { value: file.document, parentId: null },
  ];
  while (stack.length) {
    const item = stack.pop();
    if (!item) break;
    const node = figmaNode.parse(item.value);
    const { children, ...properties } = node;
    sources.push({
      ...source,
      id: `${source.id}:node:${node.id}`,
      title:
        `${source.title.slice(0, 350)} · ${node.name ?? node.type} (${node.id})`.slice(
          0,
          500,
        ),
      ...(source.url
        ? {
            url: `${source.url}${source.url.includes("?") ? "&" : "?"}node-id=${encodeURIComponent(node.id)}`,
          }
        : {}),
      text: reviewSourceText(
        JSON.stringify({ parentId: item.parentId, ...properties }),
      ),
      coverage: "captured",
    });
    for (let i = (children?.length ?? 0) - 1; i >= 0; i--)
      stack.push({ value: children?.[i], parentId: node.id });
  }
  return sources;
}
