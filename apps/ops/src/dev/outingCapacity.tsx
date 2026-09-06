import { useRef, useState, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { OutingCapacityContent } from "../components/OutingCapacity";
import "../index.css";

type Props = ComponentProps<typeof OutingCapacityContent>;
type Command = Parameters<Props["configure"]>[0];
function Fixture() {
  const [configuration, setConfiguration] = useState<Props["configuration"]>({ capacity: 15, occupiedCount: 15, waitingCount: 2, version: 1 });
  const [status, setStatus] = useState<Props["status"]>("overdue");
  const [calls, setCalls] = useState<Command[]>([]);
  const results = useRef(new Set<string>());
  const count = useRef(0);
  const configure: Props["configure"] = async (args) => {
    count.current += 1;
    const call = count.current;
    setCalls((current) => [...current, args]);
    await new Promise((resolve) => { setTimeout(resolve, 150); });
    if (results.current.has(args.clientOperationId)) return null;
    results.current.add(args.clientOperationId);
    setConfiguration((current) => ({ ...current, capacity: args.capacity, version: current.version + 1 }));
    if (new URLSearchParams(location.search).has("lost") && call === 1) throw new Error("Saved, but the response was lost.");
    return null;
  };
  return <main style={{ maxWidth: 760, padding: 20, margin: "20px auto" }}>
    <OutingCapacityContent configuration={configuration} configure={configure} status={status} setStatus={setStatus}
      roster={{ status: "Exhausted", results: [], loadMore: () => {} }} />
    <pre aria-label="Capacity commands">{JSON.stringify(calls)}</pre>
  </main>;
}
const root = document.getElementById("root");
if (import.meta.env.DEV && root) createRoot(root).render(<Fixture />);
