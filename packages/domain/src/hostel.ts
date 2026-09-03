export type VitHostelResidenceKind = "mens" | "ladies";

export type VitHostelResidenceCatalogEntry = {
  stableKey: string;
  label: string;
  kind: VitHostelResidenceKind;
};

export const defaultVitHostelResidenceCatalog: VitHostelResidenceCatalogEntry[] = [
  { stableKey: "mh_a", label: "A block", kind: "mens" },
  { stableKey: "mh_b", label: "B block", kind: "mens" },
  { stableKey: "mh_b_annex", label: "B annex", kind: "mens" },
  { stableKey: "mh_c", label: "C block", kind: "mens" },
  { stableKey: "mh_d", label: "D block", kind: "mens" },
  { stableKey: "mh_d_annex", label: "D annex", kind: "mens" },
  { stableKey: "mh_e", label: "E block", kind: "mens" },
  { stableKey: "mh_f", label: "F block", kind: "mens" },
  { stableKey: "mh_g", label: "G block", kind: "mens" },
  { stableKey: "mh_h", label: "H block", kind: "mens" },
  { stableKey: "mh_j", label: "J block", kind: "mens" },
  { stableKey: "mh_k", label: "K block", kind: "mens" },
  { stableKey: "mh_l", label: "L block", kind: "mens" },
  { stableKey: "mh_m", label: "M block", kind: "mens" },
  { stableKey: "mh_n", label: "N block", kind: "mens" },
  { stableKey: "mh_p", label: "P block", kind: "mens" },
  { stableKey: "mh_q", label: "Q block", kind: "mens" },
  { stableKey: "mh_r", label: "R block", kind: "mens" },
  { stableKey: "mh_t", label: "T block", kind: "mens" },
  { stableKey: "lh_a", label: "A block", kind: "ladies" },
  { stableKey: "lh_b", label: "B block", kind: "ladies" },
  { stableKey: "lh_c", label: "C block", kind: "ladies" },
  { stableKey: "lh_d", label: "D block", kind: "ladies" },
  { stableKey: "lh_e", label: "E block", kind: "ladies" },
  { stableKey: "lh_f", label: "F block", kind: "ladies" },
  { stableKey: "lh_g", label: "G block", kind: "ladies" },
  { stableKey: "lh_h", label: "H block", kind: "ladies" },
  { stableKey: "lh_j", label: "J block", kind: "ladies" },
  { stableKey: "lh_s", label: "S block", kind: "ladies" },
];

export function findVitHostelResidenceCatalogEntry(
  catalog: readonly VitHostelResidenceCatalogEntry[],
  value: string,
) {
  return catalog.find((entry) => entry.stableKey === value) ?? null;
}

export function vitHostelResidenceCatalogLabel(entry: VitHostelResidenceCatalogEntry) {
  if (entry.kind === "mens") return `Men's hostel · ${entry.label}`;
  if (entry.kind === "ladies") return `Ladies' hostel · ${entry.label}`;
  return entry.label;
}

export function normalizeVitHostelRoomNumberInput(value: string) {
  return value.trim().replace(/\s+/g, "").toUpperCase();
}

export function isVitHostelRoomNumber(value: string) {
  return /^[A-Z0-9][A-Z0-9-]{0,9}$/.test(value) && /\d/.test(value);
}
