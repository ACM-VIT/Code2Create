export const mensHostelResidences = [
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
] as const;

export const ladiesHostelResidences = [
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
] as const;

export const vitHostelResidences = [
  "day_scholar",
  ...mensHostelResidences,
  ...ladiesHostelResidences,
] as const;

export type MensHostelResidence = (typeof mensHostelResidences)[number];
export type LadiesHostelResidence = (typeof ladiesHostelResidences)[number];
export type VitHostelResidence = (typeof vitHostelResidences)[number];
export type VitHostelResidenceKind = "day_scholar" | "mens" | "ladies";

export const vitHostelResidenceLabels: Record<VitHostelResidence, string> = {
  day_scholar: "Day scholar",
  mh_a: "Men's hostel · A block",
  mh_b: "Men's hostel · B block",
  mh_c: "Men's hostel · C block",
  mh_d: "Men's hostel · D block",
  mh_d_annex: "Men's hostel · D annex",
  mh_e: "Men's hostel · E block",
  mh_f: "Men's hostel · F block",
  mh_g: "Men's hostel · G block",
  mh_h: "Men's hostel · H block",
  mh_j: "Men's hostel · J block",
  mh_k: "Men's hostel · K block",
  mh_l: "Men's hostel · L block",
  mh_m: "Men's hostel · M block",
  mh_n: "Men's hostel · N block",
  mh_p: "Men's hostel · P block",
  mh_q: "Men's hostel · Q block",
  mh_r: "Men's hostel · R block",
  mh_t: "Men's hostel · T block",
  lh_a: "Ladies' hostel · A block",
  lh_b: "Ladies' hostel · B block",
  lh_c: "Ladies' hostel · C block",
  lh_d: "Ladies' hostel · D block",
  lh_e: "Ladies' hostel · E block",
  lh_f: "Ladies' hostel · F block",
  lh_g: "Ladies' hostel · G block",
  lh_h: "Ladies' hostel · H block",
  lh_j: "Ladies' hostel · J block",
  lh_s: "Ladies' hostel · S block",
};

export const vitHostelResidenceOptionLabels: Record<VitHostelResidence, string> = {
  day_scholar: "Day scholar",
  mh_a: "A block",
  mh_b: "B block",
  mh_c: "C block",
  mh_d: "D block",
  mh_d_annex: "D annex",
  mh_e: "E block",
  mh_f: "F block",
  mh_g: "G block",
  mh_h: "H block",
  mh_j: "J block",
  mh_k: "K block",
  mh_l: "L block",
  mh_m: "M block",
  mh_n: "N block",
  mh_p: "P block",
  mh_q: "Q block",
  mh_r: "R block",
  mh_t: "T block",
  lh_a: "A block",
  lh_b: "B block",
  lh_c: "C block",
  lh_d: "D block",
  lh_e: "E block",
  lh_f: "F block",
  lh_g: "G block",
  lh_h: "H block",
  lh_j: "J block",
  lh_s: "S block",
};

export function findVitHostelResidence(value: string): VitHostelResidence | null {
  return vitHostelResidences.find((residence) => residence === value) ?? null;
}

export function vitHostelResidenceKind(
  residence: VitHostelResidence,
): VitHostelResidenceKind {
  if (residence === "day_scholar") return "day_scholar";
  if (mensHostelResidences.some((block) => block === residence)) return "mens";
  return "ladies";
}

export function isVitHostelBlock(residence: VitHostelResidence) {
  return residence !== "day_scholar";
}

export function normalizeVitHostelRoomNumberInput(value: string) {
  return value.trim().replace(/\s+/g, "").toUpperCase();
}

export function isVitHostelRoomNumber(value: string) {
  return /^[A-Z0-9][A-Z0-9-]{0,9}$/.test(value) && /\d/.test(value);
}
