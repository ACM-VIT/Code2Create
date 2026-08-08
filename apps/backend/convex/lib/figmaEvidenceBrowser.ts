const maximumNodeIdLength = 256;
const maximumNodeNameLength = 1_024;
const maximumProviderValueLength = 256;
const maximumDescriptionLength = 1_000;
const maximumTextPreviewLength = 320;
const maximumChildrenPerPage = 60;
const maximumInteractions = 24;
const maximumFlowStartingPoints = 24;
const maximumStyleReferences = 24;
const maximumBreadcrumbs = 64;

type ProviderRecord = Record<string, unknown>;

export type FigmaNodeSummary = {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  childCount: number;
  interactionCount: number;
  width?: number;
  height?: number;
  layoutMode?: string;
  componentId?: string;
  textPreview?: string;
};

export type FigmaNodeBreadcrumb = {
  id: string;
  name: string;
  type: string;
};

export type FigmaNodeInteraction = {
  trigger: string;
  action: string;
  navigation?: string;
  destinationNodeId?: string;
};

export type FigmaFlowStartingPoint = {
  name: string;
  nodeId: string;
};

export type FigmaStyleReference = {
  kind: string;
  styleId: string;
};

export type FigmaComponentReference = {
  nodeId: string;
  name?: string;
  description?: string;
  key?: string;
  remote?: boolean;
  componentSetId?: string;
};

export type FigmaNodeDetails = FigmaNodeSummary & {
  locked?: boolean;
  opacity?: number;
  blendMode?: string;
  x?: number;
  y?: number;
  horizontalConstraint?: string;
  verticalConstraint?: string;
  horizontalSizing?: string;
  verticalSizing?: string;
  primaryAxisAlignment?: string;
  counterAxisAlignment?: string;
  itemSpacing?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  cornerRadius?: number;
  strokeWeight?: number;
  fillCount: number;
  strokeCount: number;
  effectCount: number;
  annotationCount: number;
  textCharacterCount?: number;
  textPreviewTruncated?: boolean;
  component?: FigmaComponentReference;
  styleReferences: FigmaStyleReference[];
};

export type FigmaEvidenceBrowserPage = {
  current: FigmaNodeDetails;
  breadcrumbs: FigmaNodeBreadcrumb[];
  breadcrumbsTruncated: boolean;
  children: FigmaNodeSummary[];
  childOffset: number;
  totalChildren: number;
  previousOffset?: number;
  nextOffset?: number;
  interactions: FigmaNodeInteraction[];
  interactionsTruncated: boolean;
  flowStartingPoints: FigmaFlowStartingPoint[];
  flowStartingPointsTruncated: boolean;
};

export class FigmaEvidenceBrowseError extends Error {
  readonly code:
    | "artifact_invalid"
    | "node_id_invalid"
    | "node_not_found"
    | "offset_invalid";

  constructor(
    code: FigmaEvidenceBrowseError["code"],
    message: string,
  ) {
    super(message);
    this.name = "FigmaEvidenceBrowseError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is ProviderRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximumLength: number) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, maximumLength);
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordField(record: ProviderRecord, key: string) {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function arrayField(record: ProviderRecord, key: string) {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function requiredNode(value: unknown): ProviderRecord {
  if (!isRecord(value)) {
    throw new FigmaEvidenceBrowseError(
      "artifact_invalid",
      "The fixed Figma checkpoint has an invalid node tree.",
    );
  }
  const id = boundedString(value.id, maximumNodeIdLength);
  const type = boundedString(value.type, maximumProviderValueLength);
  if (!id || !type) {
    throw new FigmaEvidenceBrowseError(
      "artifact_invalid",
      "The fixed Figma checkpoint has an invalid node tree.",
    );
  }
  return value;
}

function nodeId(node: ProviderRecord) {
  const id = boundedString(node.id, maximumNodeIdLength);
  if (!id) {
    throw new FigmaEvidenceBrowseError(
      "artifact_invalid",
      "The fixed Figma checkpoint contains a node without an ID.",
    );
  }
  return id;
}

function nodeType(node: ProviderRecord) {
  const type = boundedString(node.type, maximumProviderValueLength);
  if (!type) {
    throw new FigmaEvidenceBrowseError(
      "artifact_invalid",
      "The fixed Figma checkpoint contains a node without a type.",
    );
  }
  return type;
}

function nodeName(node: ProviderRecord) {
  return boundedString(node.name, maximumNodeNameLength) ?? nodeType(node);
}

function nodeChildren(node: ProviderRecord) {
  const value = node.children;
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new FigmaEvidenceBrowseError(
      "artifact_invalid",
      "The fixed Figma checkpoint has an invalid child list.",
    );
  }
  return value.map(requiredNode);
}

function textDetails(node: ProviderRecord) {
  if (typeof node.characters !== "string") return undefined;
  const compact = node.characters.replaceAll(/\s+/gu, " ").trim();
  return {
    characterCount: node.characters.length,
    preview: compact.slice(0, maximumTextPreviewLength),
    truncated: compact.length > maximumTextPreviewLength,
  };
}

function boundingBox(node: ProviderRecord) {
  const box = recordField(node, "absoluteBoundingBox");
  if (!box) return undefined;
  const x = finiteNumber(box.x);
  const y = finiteNumber(box.y);
  const width = finiteNumber(box.width);
  const height = finiteNumber(box.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return { x, y, width, height };
}

function interactionCount(node: ProviderRecord) {
  return arrayField(node, "interactions").length;
}

function summary(node: ProviderRecord): FigmaNodeSummary {
  const box = boundingBox(node);
  const text = textDetails(node);
  const layoutMode = boundedString(node.layoutMode, maximumProviderValueLength);
  const componentId = boundedString(node.componentId, maximumNodeIdLength);
  return {
    id: nodeId(node),
    name: nodeName(node),
    type: nodeType(node),
    visible: node.visible !== false,
    childCount: nodeChildren(node).length,
    interactionCount: interactionCount(node),
    ...(box ? { width: box.width, height: box.height } : {}),
    ...(layoutMode ? { layoutMode } : {}),
    ...(componentId ? { componentId } : {}),
    ...(text?.preview ? { textPreview: text.preview } : {}),
  };
}

function componentReference(
  file: ProviderRecord,
  node: ProviderRecord,
): FigmaComponentReference | undefined {
  const type = nodeType(node);
  const referencedId =
    boundedString(node.componentId, maximumNodeIdLength) ??
    (type === "COMPONENT" || type === "COMPONENT_SET" ? nodeId(node) : undefined);
  if (!referencedId) return undefined;
  const collection =
    type === "COMPONENT_SET"
      ? recordField(file, "componentSets")
      : recordField(file, "components");
  const metadata = collection ? recordField(collection, referencedId) : undefined;
  const name = metadata
    ? boundedString(metadata.name, maximumNodeNameLength)
    : undefined;
  const description = metadata
    ? boundedString(metadata.description, maximumDescriptionLength)
    : undefined;
  const key = metadata
    ? boundedString(metadata.key, maximumProviderValueLength)
    : undefined;
  const componentSetId = metadata
    ? boundedString(metadata.componentSetId, maximumNodeIdLength)
    : undefined;
  const remote = metadata && typeof metadata.remote === "boolean" ? metadata.remote : undefined;
  return {
    nodeId: referencedId,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(key ? { key } : {}),
    ...(remote !== undefined ? { remote } : {}),
    ...(componentSetId ? { componentSetId } : {}),
  };
}

function styleReferences(node: ProviderRecord) {
  const styles = recordField(node, "styles");
  if (!styles) return [];
  return Object.entries(styles)
    .flatMap(([kind, value]) => {
      const styleId = boundedString(value, maximumProviderValueLength);
      const normalizedKind = boundedString(kind, maximumProviderValueLength);
      return styleId && normalizedKind ? [{ kind: normalizedKind, styleId }] : [];
    })
    .toSorted((left, right) => left.kind.localeCompare(right.kind))
    .slice(0, maximumStyleReferences);
}

function nodeDetails(file: ProviderRecord, node: ProviderRecord): FigmaNodeDetails {
  const base = summary(node);
  const box = boundingBox(node);
  const constraints = recordField(node, "constraints");
  const text = textDetails(node);
  const component = componentReference(file, node);
  const locked = typeof node.locked === "boolean" ? node.locked : undefined;
  const opacity = finiteNumber(node.opacity);
  const itemSpacing = finiteNumber(node.itemSpacing);
  const paddingTop = finiteNumber(node.paddingTop);
  const paddingRight = finiteNumber(node.paddingRight);
  const paddingBottom = finiteNumber(node.paddingBottom);
  const paddingLeft = finiteNumber(node.paddingLeft);
  const cornerRadius = finiteNumber(node.cornerRadius);
  const strokeWeight = finiteNumber(node.strokeWeight);
  const blendMode = boundedString(node.blendMode, maximumProviderValueLength);
  const horizontalConstraint = constraints
    ? boundedString(constraints.horizontal, maximumProviderValueLength)
    : undefined;
  const verticalConstraint = constraints
    ? boundedString(constraints.vertical, maximumProviderValueLength)
    : undefined;
  const horizontalSizing = boundedString(
    node.layoutSizingHorizontal,
    maximumProviderValueLength,
  );
  const verticalSizing = boundedString(
    node.layoutSizingVertical,
    maximumProviderValueLength,
  );
  const primaryAxisAlignment = boundedString(
    node.primaryAxisAlignItems,
    maximumProviderValueLength,
  );
  const counterAxisAlignment = boundedString(
    node.counterAxisAlignItems,
    maximumProviderValueLength,
  );
  return {
    ...base,
    ...(locked !== undefined ? { locked } : {}),
    ...(opacity !== undefined ? { opacity } : {}),
    ...(blendMode ? { blendMode } : {}),
    ...(box ? { x: box.x, y: box.y } : {}),
    ...(horizontalConstraint ? { horizontalConstraint } : {}),
    ...(verticalConstraint ? { verticalConstraint } : {}),
    ...(horizontalSizing ? { horizontalSizing } : {}),
    ...(verticalSizing ? { verticalSizing } : {}),
    ...(primaryAxisAlignment ? { primaryAxisAlignment } : {}),
    ...(counterAxisAlignment ? { counterAxisAlignment } : {}),
    ...(itemSpacing !== undefined ? { itemSpacing } : {}),
    ...(paddingTop !== undefined ? { paddingTop } : {}),
    ...(paddingRight !== undefined ? { paddingRight } : {}),
    ...(paddingBottom !== undefined ? { paddingBottom } : {}),
    ...(paddingLeft !== undefined ? { paddingLeft } : {}),
    ...(cornerRadius !== undefined ? { cornerRadius } : {}),
    ...(strokeWeight !== undefined ? { strokeWeight } : {}),
    fillCount: arrayField(node, "fills").length,
    strokeCount: arrayField(node, "strokes").length,
    effectCount: arrayField(node, "effects").length,
    annotationCount: arrayField(node, "annotations").length,
    ...(text
      ? {
          textCharacterCount: text.characterCount,
          textPreviewTruncated: text.truncated,
        }
      : {}),
    ...(component ? { component } : {}),
    styleReferences: styleReferences(node),
  };
}

function nodePath(root: ProviderRecord, requestedNodeId: string | undefined) {
  if (!requestedNodeId || requestedNodeId === nodeId(root)) return [root];
  const stack: Array<{
    node: ProviderRecord;
    children: ProviderRecord[];
    nextChildIndex: number;
  }> = [{ node: root, children: nodeChildren(root), nextChildIndex: 0 }];
  while (stack.length > 0) {
    const current = stack.at(-1);
    if (!current) break;
    if (nodeId(current.node) === requestedNodeId) {
      return stack.map((item) => item.node);
    }
    const child = current.children[current.nextChildIndex];
    if (child) {
      current.nextChildIndex += 1;
      stack.push({ node: child, children: nodeChildren(child), nextChildIndex: 0 });
    } else {
      stack.pop();
    }
  }
  throw new FigmaEvidenceBrowseError(
    "node_not_found",
    "That layer is not present in the fixed Figma checkpoint.",
  );
}

function interactionSummaries(node: ProviderRecord) {
  const summaries: FigmaNodeInteraction[] = [];
  let discovered = 0;
  for (const interaction of arrayField(node, "interactions")) {
    if (!isRecord(interaction)) continue;
    const triggerRecord = recordField(interaction, "trigger");
    const trigger =
      (triggerRecord
        ? boundedString(triggerRecord.type, maximumProviderValueLength)
        : undefined) ?? "unknown";
    for (const actionValue of arrayField(interaction, "actions")) {
      if (!isRecord(actionValue)) continue;
      discovered += 1;
      if (summaries.length >= maximumInteractions) continue;
      const action = boundedString(actionValue.type, maximumProviderValueLength) ?? "unknown";
      const navigation = boundedString(
        actionValue.navigation,
        maximumProviderValueLength,
      );
      const destinationNodeId = boundedString(
        actionValue.destinationId,
        maximumNodeIdLength,
      );
      summaries.push({
        trigger,
        action,
        ...(navigation ? { navigation } : {}),
        ...(destinationNodeId ? { destinationNodeId } : {}),
      });
    }
  }
  return { summaries, truncated: discovered > summaries.length };
}

function flowStartingPoints(node: ProviderRecord) {
  const points: FigmaFlowStartingPoint[] = [];
  let discovered = 0;
  for (const value of arrayField(node, "flowStartingPoints")) {
    if (!isRecord(value)) continue;
    const name = boundedString(value.name, maximumNodeNameLength);
    const targetNodeId = boundedString(value.nodeId, maximumNodeIdLength);
    if (!name || !targetNodeId) continue;
    discovered += 1;
    if (points.length < maximumFlowStartingPoints) {
      points.push({ name, nodeId: targetNodeId });
    }
  }
  return { points, truncated: discovered > points.length };
}

function breadcrumbs(path: ProviderRecord[]) {
  const all = path.map((node) => ({
    id: nodeId(node),
    name: nodeName(node),
    type: nodeType(node),
  }));
  if (all.length <= maximumBreadcrumbs) {
    return { values: all, truncated: false };
  }
  return {
    values: [all[0], ...all.slice(-(maximumBreadcrumbs - 1))].filter(
      (value): value is FigmaNodeBreadcrumb => value !== undefined,
    ),
    truncated: true,
  };
}

export function browseFigmaEvidence(
  rawJson: string,
  expectedProviderVersionId: string,
  requestedNodeId: string | undefined,
  childOffset: number,
): FigmaEvidenceBrowserPage {
  if (!Number.isSafeInteger(childOffset) || childOffset < 0) {
    throw new FigmaEvidenceBrowseError(
      "offset_invalid",
      "The Figma layer page is invalid.",
    );
  }
  const normalizedNodeId = requestedNodeId?.trim();
  if (
    normalizedNodeId !== undefined &&
    (normalizedNodeId.length < 1 || normalizedNodeId.length > maximumNodeIdLength)
  ) {
    throw new FigmaEvidenceBrowseError(
      "node_id_invalid",
      "Choose a layer from the fixed Figma checkpoint.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new FigmaEvidenceBrowseError(
      "artifact_invalid",
      "The fixed Figma checkpoint could not be parsed.",
    );
  }
  if (!isRecord(parsed)) {
    throw new FigmaEvidenceBrowseError(
      "artifact_invalid",
      "The fixed Figma checkpoint has an invalid root.",
    );
  }
  if (
    boundedString(parsed.version, maximumProviderValueLength) !==
    expectedProviderVersionId
  ) {
    throw new FigmaEvidenceBrowseError(
      "artifact_invalid",
      "The fixed Figma checkpoint does not match its recorded provider version.",
    );
  }
  const root = requiredNode(parsed.document);
  const path = nodePath(root, normalizedNodeId);
  const current = path.at(-1);
  if (!current) {
    throw new FigmaEvidenceBrowseError(
      "artifact_invalid",
      "The fixed Figma checkpoint has no document node.",
    );
  }
  const allChildren = nodeChildren(current);
  if (childOffset > allChildren.length) {
    throw new FigmaEvidenceBrowseError(
      "offset_invalid",
      "The Figma layer page is no longer available.",
    );
  }
  const visibleChildren = allChildren.slice(
    childOffset,
    childOffset + maximumChildrenPerPage,
  );
  const nextOffset = childOffset + visibleChildren.length;
  const interactionResult = interactionSummaries(current);
  const flowResult = flowStartingPoints(current);
  const breadcrumbResult = breadcrumbs(path);
  return {
    current: nodeDetails(parsed, current),
    breadcrumbs: breadcrumbResult.values,
    breadcrumbsTruncated: breadcrumbResult.truncated,
    children: visibleChildren.map(summary),
    childOffset,
    totalChildren: allChildren.length,
    ...(childOffset > 0
      ? { previousOffset: Math.max(0, childOffset - maximumChildrenPerPage) }
      : {}),
    ...(nextOffset < allChildren.length ? { nextOffset } : {}),
    interactions: interactionResult.summaries,
    interactionsTruncated: interactionResult.truncated,
    flowStartingPoints: flowResult.points,
    flowStartingPointsTruncated: flowResult.truncated,
  };
}
