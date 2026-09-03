import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultVitHostelResidenceCatalog,
  findVitHostelResidenceCatalogEntry,
  isVitHostelRoomNumber,
  normalizeVitHostelRoomNumberInput,
  vitHostelResidenceCatalogLabel,
} from "./hostel.ts";

test("the VIT hostel catalog is unique and fully labeled", () => {
  const stableKeys = defaultVitHostelResidenceCatalog.map((entry) => entry.stableKey);
  assert.equal(new Set(stableKeys).size, stableKeys.length);
  for (const entry of defaultVitHostelResidenceCatalog) {
    assert.ok(entry.label.length > 0, entry.stableKey);
    assert.ok(!entry.label.includes("_"), `${entry.stableKey} still reads as a stored key`);
  }
});

test("the configurable catalogue defaults to the initial residences", () => {
  const residence = findVitHostelResidenceCatalogEntry(
    defaultVitHostelResidenceCatalog,
    "mh_d_annex",
  );
  assert.deepEqual(residence, {
    stableKey: "mh_d_annex",
    label: "D annex",
    kind: "mens",
  });
  assert.equal(
    residence ? vitHostelResidenceCatalogLabel(residence) : null,
    "Men's hostel · D annex",
  );
});

test("the men's hostel catalog matches the current blocks", () => {
  assert.deepEqual(
    defaultVitHostelResidenceCatalog
      .filter((entry) => entry.kind === "mens")
      .map((entry) => entry.stableKey),
    [
      "mh_a",
      "mh_b",
      "mh_c",
      "mh_d",
      "mh_d_annex",
      "mh_e",
      "mh_f",
      "mh_g",
      "mh_h",
      "mh_j",
      "mh_k",
      "mh_l",
      "mh_m",
      "mh_n",
      "mh_p",
      "mh_q",
      "mh_r",
      "mh_t",
    ],
  );
});

test("S block is a ladies' hostel residence", () => {
  const residence = findVitHostelResidenceCatalogEntry(defaultVitHostelResidenceCatalog, "lh_s");
  assert.deepEqual(residence, {
    stableKey: "lh_s",
    label: "S block",
    kind: "ladies",
  });
  assert.equal(findVitHostelResidenceCatalogEntry(defaultVitHostelResidenceCatalog, "mh_s"), null);
});

test("the ladies' hostel catalog matches the current blocks", () => {
  assert.deepEqual(
    defaultVitHostelResidenceCatalog
      .filter((entry) => entry.kind === "ladies")
      .map((entry) => entry.stableKey),
    ["lh_a", "lh_b", "lh_c", "lh_d", "lh_e", "lh_f", "lh_g", "lh_h", "lh_j", "lh_s"],
  );
});

test("day scholars are a residence, not a hostel block", () => {
  assert.equal(
    findVitHostelResidenceCatalogEntry(defaultVitHostelResidenceCatalog, "day_scholar"),
    null,
  );
});

test("hostel room numbers are compact identifiers with a digit", () => {
  assert.equal(normalizeVitHostelRoomNumberInput(" 412 a "), "412A");
  assert.equal(isVitHostelRoomNumber("412"), true);
  assert.equal(isVitHostelRoomNumber("412A"), true);
  assert.equal(isVitHostelRoomNumber("G-01"), true);
  assert.equal(isVitHostelRoomNumber("BLOCK"), false);
  assert.equal(isVitHostelRoomNumber(""), false);
  assert.equal(isVitHostelRoomNumber("12345678901"), false);
});
