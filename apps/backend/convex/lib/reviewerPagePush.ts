export type ReviewerPagePushData = {
  kind: "reviewer_substitute_page";
  pageId: string;
  title: string;
  body: string;
  expiresAt: string;
};

export function reviewerPagePushData(args: {
  pageId: string;
  roundName: string;
  tableLabel?: string;
  expiresAt: number;
}): ReviewerPagePushData {
  const body =
    args.tableLabel === undefined
      ? `${args.roundName}. Open Code2Create Ops now.`
      : `${args.roundName} at ${args.tableLabel}. Open Code2Create Ops now.`;
  return {
    kind: "reviewer_substitute_page",
    pageId: args.pageId,
    title: "Substitute request",
    body,
    expiresAt: String(args.expiresAt),
  };
}
