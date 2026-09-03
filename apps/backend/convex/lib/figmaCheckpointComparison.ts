export type FigmaComparableFact<FactId extends string> = {
  factId: FactId;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  pageName: string;
  semanticHash: string;
  renderState: "pending" | "available" | "failed";
};

export type FigmaComparisonState = "added" | "removed" | "changed" | "unchanged" | "uncertain";

export type FigmaComparisonRow<FactId extends string> = {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  pageName: string;
  state: FigmaComparisonState;
  currentFactId?: FactId;
  currentRenderState?: "pending" | "available" | "failed";
  previousFactId?: FactId;
  previousRenderState?: "pending" | "available" | "failed";
};

export type FigmaCheckpointComparison<FactId extends string> = {
  rows: FigmaComparisonRow<FactId>[];
  counts: Record<FigmaComparisonState, number>;
};

const stateOrder: Record<FigmaComparisonState, number> = {
  changed: 0,
  added: 1,
  removed: 2,
  uncertain: 3,
  unchanged: 4,
};

function factsByNode<FactId extends string>(facts: FigmaComparableFact<FactId>[]) {
  const byNode = new Map<string, FigmaComparableFact<FactId>>();
  for (const fact of facts) {
    if (byNode.has(fact.nodeId)) {
      throw new Error("A Figma checkpoint contains the same preview node more than once.");
    }
    byNode.set(fact.nodeId, fact);
  }
  return byNode;
}

export function compareFigmaCheckpointFacts<FactId extends string>(args: {
  current: FigmaComparableFact<FactId>[];
  previous: FigmaComparableFact<FactId>[];
  currentTruncated: boolean;
  previousTruncated: boolean;
}): FigmaCheckpointComparison<FactId> {
  const currentByNode = factsByNode(args.current);
  const previousByNode = factsByNode(args.previous);
  const nodeIds = new Set([...currentByNode.keys(), ...previousByNode.keys()]);
  const rows: FigmaComparisonRow<FactId>[] = [];
  const counts: Record<FigmaComparisonState, number> = {
    added: 0,
    removed: 0,
    changed: 0,
    unchanged: 0,
    uncertain: 0,
  };

  for (const nodeId of nodeIds) {
    const current = currentByNode.get(nodeId);
    const previous = previousByNode.get(nodeId);
    let state: FigmaComparisonState;
    if (current && previous) {
      state = current.semanticHash === previous.semanticHash ? "unchanged" : "changed";
    } else if (current) {
      state = args.previousTruncated ? "uncertain" : "added";
    } else {
      state = args.currentTruncated ? "uncertain" : "removed";
    }
    const display = current ?? previous;
    if (!display) throw new Error("A Figma comparison row has no source fact.");
    counts[state] += 1;
    rows.push({
      nodeId,
      nodeName: display.nodeName,
      nodeType: display.nodeType,
      pageName: display.pageName,
      state,
      ...(current
        ? { currentFactId: current.factId, currentRenderState: current.renderState }
        : {}),
      ...(previous
        ? { previousFactId: previous.factId, previousRenderState: previous.renderState }
        : {}),
    });
  }

  rows.sort(
    (left, right) =>
      stateOrder[left.state] - stateOrder[right.state] ||
      left.pageName.localeCompare(right.pageName) ||
      left.nodeName.localeCompare(right.nodeName) ||
      left.nodeId.localeCompare(right.nodeId),
  );
  return { rows, counts };
}
