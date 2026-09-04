import assert from "node:assert/strict";
import test from "node:test";
import { selectAdmissionShortlist, shortlistNeighbourPairs, shortlistProfileSchema, validateShortlistPair, validateShortlistProfile, type ShortlistCandidate, type ShortlistComparison } from "./admissionShortlist.ts";

const profile = shortlistProfileSchema.parse({ user: "Residents", problem: "Missed pickups", workflow: "Report a missed collection", mechanism: "Route verified reports to an assigned collector", deliverable: "Working report and acknowledgement", distinction: "Offline acknowledgements", domain: "civic", aiRole: "none", sourceRefs: ["initial_idea"], premise: { assessment: "supported", explanation: "The report supplies the location needed for dispatch.", sourceRefs: ["initial_idea"] }, category: { datingOrRomanticMatchmaking: false, explanation: "Waste collection", sourceRefs: ["initial_idea"] }, criteria: [{ criterionKey: "clarity", evidence: "adequate", sourceRefs: ["initial_idea"] }] });
function candidate(applicationId: string, changes: Partial<ShortlistCandidate> = {}): ShortlistCandidate {
  return { applicationId, teamSize: 4, experienceBand: "first_year", sources: [{ sourceRef: "initial_idea", question: "Idea", answer: "A report dispatch workflow" }, ...[1,2,3,4].map(i => ({ sourceRef: `follow_up_${i}`, question: "Explain", answer: "Concrete project evidence" }))], criteria: [{ criterionKey: "clarity", label: "Clarity", guidance: "Describe a concrete user and workflow." }], quality: "accept", profile: structuredClone(profile), ...changes };
}
function pair(leftId: string, rightId: string, preferred: ShortlistComparison["preferred"] = "left", overlap: ShortlistComparison["overlap"] = "substantial"): ShortlistComparison { return { leftId, rightId, preferred, overlap, explanation: "The left proposal explains the mechanism more concretely.", leftSourceRefs: ["initial_idea"], rightSourceRefs: ["initial_idea"] }; }
const settings = { acceptPeople: 8, waitlistPeople: 4, remainingCapacity: 100, tolerance: 5 };
const selectedIds = (rows: ReturnType<typeof selectAdmissionShortlist>) => rows.filter(r => r.suggestion === "accept").map(r => r.applicationId);

test("stronger overlapping proposal is preferred regardless of arrival order", () => {
  const rows = [candidate("a"), candidate("b"), candidate("c")];
  const edges = [pair("a", "b", "right")];
  assert.deepEqual(selectedIds(selectAdmissionShortlist(rows, edges, settings)), ["b", "c"]);
  assert.deepEqual(selectAdmissionShortlist(rows, edges, settings), selectAdmissionShortlist([...rows].reverse(), edges, settings));
  assert.deepEqual(selectAdmissionShortlist(rows, edges, settings).find(r => r.applicationId === "a")?.preferredApplicationIds, ["b"]);
});
test("overlap is not transitively merged", () => {
  const rows = selectAdmissionShortlist([candidate("a"), candidate("b"), candidate("c")], [pair("a", "b"), pair("b", "c", "right")], settings);
  assert.deepEqual(selectedIds(rows), ["a", "c"]);
});
test("shared domain and related ideas do not exclude one another", () => assert.equal(selectedIds(selectAdmissionShortlist([candidate("a"), candidate("b")], [pair("a", "b", "tie", "related")], settings)).length, 2));
test("cycles and true ties are flagged without blocking completion", () => {
  const result = selectAdmissionShortlist([candidate("a"),candidate("b"),candidate("c")], [pair("a","b"),pair("b","c"),pair("c","a")], settings);
  assert.equal(result.length, 3);
  assert.ok(result.some(r => r.uncertainComparison));
});
test("capacity is people, teams are intact, and no smaller lower-ranked team jumps the prefix", () => {
  const rows = selectAdmissionShortlist([candidate("a",{teamSize:5}),candidate("b",{teamSize:5}),candidate("c",{teamSize:2})], [], { ...settings, acceptPeople:7, remainingCapacity:7 });
  assert.deepEqual(selectedIds(rows), ["a"]);
});
test("nearest whole-team prefix may cross a soft target but never real capacity", () => {
  const rows = [candidate("a",{teamSize:5}),candidate("b",{teamSize:4})];
  assert.equal(selectAdmissionShortlist(rows, [], {...settings, acceptPeople:8}).filter(r=>r.suggestion==="accept").reduce((n,r)=>n+r.teamSize,0),9);
  assert.deepEqual(selectedIds(selectAdmissionShortlist(rows, [], {...settings,acceptPeople:8,remainingCapacity:8})),["a"]);
});
test("quality and premise floors are not relaxed to fill capacity", () => {
  const rows = [candidate("decline",{quality:"decline"}), candidate("premise",{profile:{...profile,premise:{...profile.premise,assessment:"unsupported"}}}), candidate("dating",{profile:{...profile,category:{...profile.category,datingOrRomanticMatchmaking:true}}}), candidate("unknown",{profile:null}), candidate("uncertain",{profile:{...profile,premise:{...profile.premise,assessment:"uncertain"}}})];
  const result=selectAdmissionShortlist(rows,[],settings);
  assert.equal(selectedIds(result).length,0);
  assert.equal(result.filter(r=>r.suggestion==="reject").length,3);
  assert.equal(result.filter(r=>r.suggestion==="unresolved").length,2);
});
test("original waitlist never enters accept; remaining original accept gets waitlist priority",()=>{
  const result=selectAdmissionShortlist([candidate("a"),candidate("b"),candidate("c",{quality:"waitlist"})],[],{...settings,acceptPeople:4});
  assert.equal(result.find(r=>r.applicationId==="b")?.suggestion,"waitlist");
  assert.equal(result.find(r=>r.applicationId==="c")?.suggestion,"reject");
});
test("domain variety breaks equal-strength ties without a technology quota",()=>{
  const result=selectAdmissionShortlist([candidate("a"),candidate("b"),candidate("c",{profile:{...profile,domain:"education",aiRole:"core"}})],[],settings);
  assert.deepEqual(selectedIds(result),["a","c"]);
});
test("full pool counts hit 700 accept / 300 waitlist people, not 700/300 teams",()=>{
  const result=selectAdmissionShortlist(Array.from({length:554},(_,i)=>candidate(String(i).padStart(4,"0"))),[],{...settings,acceptPeople:700,waitlistPeople:300,remainingCapacity:850});
  assert.equal(result.filter(r=>r.suggestion==="accept").length,175);
  assert.equal(result.filter(r=>r.suggestion==="waitlist").length,75);
  assert.equal(result.filter(r=>r.suggestion==="reject").length,304);
});
test("zero capacity does not accidentally accept a team",()=>assert.equal(selectedIds(selectAdmissionShortlist([candidate("a")],[],{...settings,remainingCapacity:0})).length,0));
test("invalid evidence and duplicated or missing criteria are rejected",()=>{
  const input=candidate("a");
  assert.doesNotThrow(()=>validateShortlistProfile(profile,input));
  assert.throws(()=>validateShortlistProfile({...profile,sourceRefs:["invented"]},input));
  assert.throws(()=>validateShortlistProfile({...profile,criteria:[]},input));
  assert.throws(()=>validateShortlistPair({...pair("a","b"),rightSourceRefs:["invented"]},input,candidate("b")));
});
test("invalid roster sizes and comparison identities cannot enter selection",()=>{
  assert.throws(()=>selectAdmissionShortlist([candidate("a",{teamSize:0})],[],settings));
  assert.throws(()=>selectAdmissionShortlist([candidate("a")],[pair("a","missing")],settings));
  assert.throws(()=>selectAdmissionShortlist([candidate("a"),candidate("a")],[],settings));
});
test("nearest-neighbour retrieval is symmetric, deduplicated and validates vectors",()=>{
  const rows=[{applicationId:"a",embedding:[1,0],profile},{applicationId:"b",embedding:[0.9,0.1],profile:{...profile,workflow:"another"}},{applicationId:"c",embedding:[0,1],profile:{...profile,workflow:"third"}}];
  assert.deepEqual(shortlistNeighbourPairs(rows,1),[{leftId:"a",rightId:"b"},{leftId:"b",rightId:"c"}]);
  assert.throws(()=>shortlistNeighbourPairs([{...rows[0]!,embedding:[0,0]},rows[1]!]));
});
