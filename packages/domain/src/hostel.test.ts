import assert from "node:assert/strict";
import test from "node:test";

import {
  findVitHostelResidence,
  isVitHostelBlock,
  isVitHostelRoomNumber,
  ladiesHostelResidences,
  mensHostelResidences,
  normalizeVitHostelRoomNumberInput,
  vitHostelResidenceKind,
  vitHostelResidenceLabels,
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

test("men's hostel includes B block and J annex", () => {
  assert.ok(mensHostelResidences.includes("mh_b"));
  assert.ok(mensHostelResidences.includes("mh_b_annex"));
  assert.ok(mensHostelResidences.includes("mh_j_annex"));
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

test("the ladies' hostel catalog includes RGT H", () => {
  assert.ok(ladiesHostelResidences.includes("lh_rgt_h"));
  assert.equal(vitHostelResidenceKind("lh_rgt_h"), "ladies");
  assert.equal(vitHostelResidenceLabels.lh_rgt_h, "Ladies' hostel · RGT H");
  assert.equal(findVitHostelResidence("lh_rgt_h"), "lh_rgt_h");
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
