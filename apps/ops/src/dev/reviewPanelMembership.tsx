import type { GenericId as Id } from "convex/values";
import { useState, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { ReviewPanelMembershipForm } from "../components/ReviewPanelMembership";
import "../index.css";

type Props = ComponentProps<typeof ReviewPanelMembershipForm>;
type Panel = Props["panel"];
type Reserve = Props["reserves"][number];
type Change = Parameters<Props["swapPanelMember"]>[0];

// Synthetic fixture IDs never leave this in-memory UI.
function id<Table extends "people" | "reviewPanels" | "reviewPanelMembers" | "reviewRoundReserves">(value: string): Id<Table> {
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  return value as Id<Table>;
}

function member(name: string, seniority: "sc" | "jc"): Panel["activeMembers"][number] {
  return {
    panelMemberId: id<"reviewPanelMembers">(`${name}-seat`), personId: id<"people">(name),
    displayName: name, isCoordinator: false, canMarkNoShow: false,
    seat: { seniority, criterionKeys: ["research", "technical_execution"] },
    profile: { seniority, criterionKeys: ["research", "technical_execution"], canJoin: true },
  };
}

function panel(name: string, members: Panel["activeMembers"], canSwapMembers = true): Panel {
  return {
    panelId: id<"reviewPanels">(name), name, panelVersion: 1, activeMembers: members,
    vacancy: null, pageChain: null, canStartPage: false, canManageMembers: true,
    canSwapMembers, membershipBlockedReason: canSwapMembers ? null : "Review in progress",
  };
}

function reserve(name: string, status: Reserve["status"] = "available"): Reserve {
  return {
    reserveId: id<"reviewRoundReserves">(`${name}-reserve`), personId: id<"people">(name),
    displayName: name, status, pageCount: 0,
    profile: { seniority: "sc", criterionKeys: ["research"], canJoin: true },
  };
}

function Fixture() {
  const [calls, setCalls] = useState<Change[]>([]);
  const canManageMembers = new URLSearchParams(location.search).get("role") !== "sc";
  const target = { ...panel("Panel 7", [member("Tarun", "sc")]), canManageMembers,
    canSwapMembers: canManageMembers, membershipBlockedReason: canManageMembers ? null : "Only Board members can change panel reviewers." };
  const source = panel("Panel 2", [member("Junior reviewer", "jc")]);
  const locked = panel("Panel 3", [member("Busy reviewer", "sc")], false);
  return <main className="mx-auto grid w-full max-w-2xl gap-4 p-4">
    <h1>Panel 7</h1>
    <ReviewPanelMembershipForm panel={target} panels={[target, source, locked]}
      reserves={[reserve("Vian Mangal"), reserve("Paged reviewer", "paged")]}
      allowSeniorLeadFallback={true}
      swapPanelMember={async args => {
        setCalls(previous => [...previous, args]);
        return { panelId: args.panelId, status: "ready", version: 2 };
      }} />
    <pre className="whitespace-pre-wrap break-all" aria-label="Panel changes">{JSON.stringify(calls)}</pre>
  </main>;
}

if (import.meta.env.DEV) {
  const element = document.getElementById("root");
  if (element) createRoot(element).render(<Fixture />);
}
