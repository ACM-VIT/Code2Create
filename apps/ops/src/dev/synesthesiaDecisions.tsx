import { ConvexError } from "convex/values";
import { useRef, useState, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";

import { SynesthesiaRequestCardContent } from "../components/SynesthesiaRequestCard";
import "../index.css";

type CardProps = ComponentProps<typeof SynesthesiaRequestCardContent>;
type Request = CardProps["request"];
type Decision = Parameters<CardProps["commands"]["moderate"]>[0];
type DecisionResult = { requestId: Request["id"]; version: number };
type Scenario = "success" | "lost-response" | "permission-denied";

async function unexpectedCommand(): Promise<never> {
  throw new Error("Only Accept/Reject should be available to this fixture operator");
}

function initialRequest(): Request {
  return {
    // This dev-only ID is synthetic and never sent to Convex.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion
    id: "fixture-song" as Request["id"], provider: "youtube", providerTrackId: "fixture-track",
    title: "Local fixture song", artist: "Fixture artist", durationSeconds: 180,
    isExplicit: false, energyTag: "steady", state: "pending", queueMode: "normal",
    voteCount: 3, openReportCount: 0, requesterName: "Fixture Requester",
    requesterAccessState: "active", requesterAccessVersion: 0, version: 1, createdAt: 1,
    canDecide: true, canModerate: false, canSchedule: false, canAcknowledgePlayback: false,
    canReadReports: false, canResolveReports: false, canSuspendRequester: false, canRestoreRequester: false,
  };
}

/** Dev-only, in-memory transport: never connects to a backend or a real account. */
function DecisionFixture() {
  const [request, setRequest] = useState(initialRequest);
  const [calls, setCalls] = useState<Decision[]>([]);
  const [generation, setGeneration] = useState(0);
  const [scenario, setScenario] = useState<Scenario>("success");
  const transport = useRef({
    scenario, calls: 0, version: 1, results: new Map<string, { requestId: Request["id"]; version: number }>(),
  });
  const moderate = async (args: Decision): Promise<DecisionResult> => {
      if (args.decision === "hide" || args.reason !== undefined || args.publicReason !== undefined) {
        throw new Error("Quick decisions must not require typed reasons");
      }
      const state = transport.current;
      state.calls += 1;
      const callNumber = state.calls;
      setCalls(previous => [...previous, args]);
      await new Promise(resolve => { setTimeout(resolve, 300); });
      const previous = state.results.get(args.clientOperationId);
      if (previous) return previous;
      if (state.scenario === "permission-denied" && callNumber === 1) {
        throw new ConvexError({ code: "PERMISSION_DENIED", message: "Fixture permission was revoked." });
      }
      if (args.expectedVersion !== state.version) {
        throw new ConvexError({ code: "REQUEST_CHANGED", message: "Fixture version changed." });
      }
      state.version += 1;
      const result = { requestId: initialRequest().id, version: state.version };
      state.results.set(args.clientOperationId, result);
      setRequest(value => ({ ...value, state: args.decision === "approve" ? "approved" : "rejected", version: state.version }));
      if (state.scenario === "lost-response" && callNumber === 1) {
        throw new Error("Fixture connection lost after the decision was saved.");
      }
      return result;
  };

  const reset = () => {
    transport.current = { scenario, calls: 0, version: 1, results: new Map() };
    setRequest(initialRequest());
    setCalls([]);
    setGeneration(value => value + 1);
  };

  return <main style={{ maxWidth: 900, margin: "40px auto", padding: 16 }}>
      <h1>Music queue decisions — local fixture</h1>
      <p>Queue access only. No host, moderation, scheduling, or playback grants.</p>
      <label>Transport scenario
        <select value={scenario} onChange={event => {
          const value = event.target.value;
          if (value !== "success" && value !== "lost-response" && value !== "permission-denied") {
            throw new Error("Unknown transport scenario");
          }
          setScenario(value);
        }}>
          <option value="success">Success</option>
          <option value="lost-response">Lost response after save</option>
          <option value="permission-denied">Permission denied once</option>
        </select>
      </label>
      <button type="button" onClick={reset}>Reset fixture</button>
      <SynesthesiaRequestCardContent key={generation} request={request} startAvailable={false} commands={{
        moderate, schedule: unexpectedCommand, acknowledge: unexpectedCommand,
        resolveReport: unexpectedCommand, setAccess: unexpectedCommand,
      }} />
      <p role="status">{request.state}; version {request.version}; {calls.length} transport calls</p>
      <pre aria-label="Mutation calls">{JSON.stringify(calls, null, 2)}</pre>
    </main>;
}

if (import.meta.env.DEV) {
  const element = document.getElementById("root");
  if (element) createRoot(element).render(<DecisionFixture />);
}
