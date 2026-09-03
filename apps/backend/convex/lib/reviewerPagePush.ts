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
  expiresAt: number;
}): ReviewerPagePushData {
  return {
    kind: "reviewer_substitute_page",
    pageId: args.pageId,
    title: "Substitute request",
    body: `${args.roundName}. Open Code2Create Ops now.`,
    expiresAt: String(args.expiresAt),
  };
}
