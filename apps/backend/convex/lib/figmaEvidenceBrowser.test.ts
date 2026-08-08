import assert from "node:assert/strict";
import test from "node:test";

import {
  browseFigmaEvidence,
  FigmaEvidenceBrowseError,
} from "./figmaEvidenceBrowser.ts";

function fixture(extraChildren = 0) {
  const generatedChildren = Array.from({ length: extraChildren }, (_, index) => ({
    id: `9:${index}`,
    name: `Generated ${index}`,
    type: "RECTANGLE",
    absoluteBoundingBox: { x: index, y: index, width: 20, height: 20 },
  }));
  return JSON.stringify({
    name: "Project file",
    version: "version-1",
    components: {
      "3:1": {
        key: "component-key",
        name: "Primary button",
        description: "The main action",
        remote: false,
      },
    },
    componentSets: {},
    document: {
      id: "0:0",
      name: "Document",
      type: "DOCUMENT",
      children: [
        {
          id: "1:0",
          name: "App",
          type: "CANVAS",
          flowStartingPoints: [{ name: "Main flow", nodeId: "2:0" }],
          children: [
            {
              id: "2:0",
              name: "Home",
              type: "FRAME",
              layoutMode: "VERTICAL",
              layoutSizingHorizontal: "FIXED",
              layoutSizingVertical: "HUG",
              primaryAxisAlignItems: "MIN",
              counterAxisAlignItems: "CENTER",
              itemSpacing: 12,
              paddingTop: 24,
              paddingRight: 16,
              paddingBottom: 24,
              paddingLeft: 16,
              opacity: 0.9,
              absoluteBoundingBox: { x: 100, y: 200, width: 390, height: 844 },
              styles: { fills: "style-fill", text: "style-text" },
              interactions: [
                {
                  trigger: { type: "ON_CLICK" },
                  actions: [
                    {
                      type: "NODE",
                      navigation: "NAVIGATE",
                      destinationId: "4:0",
                    },
                  ],
                },
              ],
              children: [
                {
                  id: "3:0",
                  name: "Heading",
                  type: "TEXT",
                  characters: "  Build   something useful  ",
                },
                {
                  id: "3:2",
                  name: "Button instance",
                  type: "INSTANCE",
                  componentId: "3:1",
                },
                ...generatedChildren,
              ],
            },
          ],
        },
      ],
    },
  });
}

test("opens the immutable document at its root", () => {
  const result = browseFigmaEvidence(fixture(), "version-1", undefined, 0);

  assert.equal(result.current.id, "0:0");
  assert.equal(result.current.type, "DOCUMENT");
  assert.equal(result.totalChildren, 1);
  assert.deepEqual(result.breadcrumbs, [
    { id: "0:0", name: "Document", type: "DOCUMENT" },
  ]);
});

test("returns layer properties, prototype links, text, and component context", () => {
  const frame = browseFigmaEvidence(fixture(), "version-1", "2:0", 0);

  assert.equal(frame.current.layoutMode, "VERTICAL");
  assert.equal(frame.current.width, 390);
  assert.equal(frame.current.height, 844);
  assert.equal(frame.current.itemSpacing, 12);
  assert.deepEqual(frame.current.styleReferences, [
    { kind: "fills", styleId: "style-fill" },
    { kind: "text", styleId: "style-text" },
  ]);
  assert.deepEqual(frame.interactions, [
    {
      trigger: "ON_CLICK",
      action: "NODE",
      navigation: "NAVIGATE",
      destinationNodeId: "4:0",
    },
  ]);
  assert.equal(frame.children[0]?.textPreview, "Build something useful");

  const instance = browseFigmaEvidence(fixture(), "version-1", "3:2", 0);
  assert.deepEqual(instance.current.component, {
    nodeId: "3:1",
    name: "Primary button",
    description: "The main action",
    key: "component-key",
    remote: false,
  });
});

test("paginates large direct-child lists without changing the selected node", () => {
  const first = browseFigmaEvidence(fixture(61), "version-1", "2:0", 0);
  assert.equal(first.children.length, 60);
  assert.equal(first.nextOffset, 60);
  assert.equal(first.totalChildren, 63);

  const second = browseFigmaEvidence(fixture(61), "version-1", "2:0", 60);
  assert.equal(second.current.id, "2:0");
  assert.equal(second.children.length, 3);
  assert.equal(second.previousOffset, 0);
  assert.equal(second.nextOffset, undefined);
});

test("rejects a layer that is not part of the checkpoint", () => {
  assert.throws(
    () => browseFigmaEvidence(fixture(), "version-1", "missing", 0),
    (error) =>
      error instanceof FigmaEvidenceBrowseError && error.code === "node_not_found",
  );
});

test("rejects an artifact from a different provider version", () => {
  assert.throws(
    () => browseFigmaEvidence(fixture(), "version-2", undefined, 0),
    (error) =>
      error instanceof FigmaEvidenceBrowseError && error.code === "artifact_invalid",
  );
});
