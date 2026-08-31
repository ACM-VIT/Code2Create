import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultVitHostelResidenceCatalog,
  findVitHostelResidenceCatalogEntry,
  findVitHostelResidence,
  isVitHostelBlock,
  isVitHostelRoomNumber,
  ladiesHostelResidences,
  mensHostelResidences,
  normalizeVitHostelRoomNumberInput,
  vitHostelResidenceKind,
  vitHostelResidenceLabels,
  vitHostelResidenceCatalogLabel,
  vitHostelResidenceOptionLabels,
  vitHostelResidences,
} from "./hostel.ts";

test("the VIT hostel catalog is unique and fully labeled", () => {
  assert.equal(new Set(vitHostelResidences).size, vitHostelResidences.length);
  for (const residence of vitHostelResidences) {
    const label = vitHostelResidenceLabels[residence];
    const option = vitHostelResidenceOptionLabels[residence];
    assert.ok(label.length > 0, residence);
    assert.ok(option.length > 0, residence);
    assert.ok(!label.includes("_"), `${residence} still reads as a stored key`);
  }
});

test("the configurable catalogue defaults to the current hardcoded residences", () => {
  assert.deepEqual(
    defaultVitHostelResidenceCatalog.map((entry) => entry.stableKey),
    vitHostelResidences,
  );
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
  assert.deepEqual(mensHostelResidences, [
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
  ]);
  assert.equal(vitHostelResidenceKind("mh_b"), "mens");
  assert.equal(isVitHostelBlock("mh_b"), true);
});

test("S block is a ladies' hostel residence", () => {
  assert.ok(ladiesHostelResidences.includes("lh_s"));
  assert.equal(vitHostelResidenceKind("lh_s"), "ladies");
  assert.equal(vitHostelResidenceLabels.lh_s, "Ladies' hostel · S block");
  assert.equal(findVitHostelResidence("lh_s"), "lh_s");
  assert.equal(findVitHostelResidence("mh_s"), null);
});

test("the ladies' hostel catalog matches the current blocks", () => {
  assert.deepEqual(ladiesHostelResidences, [
    "lh_a",
    "lh_b",
    "lh_c",
    "lh_d",
    "lh_e",
    "lh_f",
    "lh_g",
    "lh_h",
    "lh_j",
    "lh_s",
  ]);
});

test("day scholars are a residence, not a hostel block", () => {
  assert.equal(vitHostelResidenceKind("day_scholar"), "day_scholar");
  assert.equal(isVitHostelBlock("day_scholar"), false);
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
