import { createRoot } from "react-dom/client";
import type { ComponentProps } from "react";
import { IntegrationOverviewContent } from "../screens/IntegrationOverview";
import "../index.css";

type Data = ComponentProps<typeof IntegrationOverviewContent>["data"];
type Team = Data["teams"][number];

// In-memory presentation fixture; no account, transport, or production data.
const teams: Team[] = Array.from({ length: 42 }, (_, index) => ({
  // Synthetic ID used only in this dev fixture; never sent to Convex.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  teamId: `fixture-team-${index}` as Team["teamId"],
  teamName: `Selected Team ${String(index).padStart(2, "0")}`,
  teamCode: `SEL${index}`,
  teamStatus: "confirmed",
  github: {
    health: index === 41 ? "ready" : index === 40 ? "needs_attention" : "not_connected",
    repositoryCount: index >= 40 ? 1 : 0,
    installationCount: index >= 40 ? 1 : 0,
    topicMissingCount: index === 41 ? 1 : 0,
    incompleteCount: 0,
  },
  figmaFileUrl: null,
}));

if (import.meta.env.DEV) {
  const empty = new URLSearchParams(window.location.search).has("empty");
  const data: Data = {
    teams: empty ? [] : teams,
    summary: {
      totalTeamCount: empty ? 0 : 42,
      disconnectedCount: empty ? 0 : 40,
      attentionCount: empty ? 0 : 1,
    },
  };
  const element = document.getElementById("root");
  if (element) createRoot(element).render(
    <main style={{ maxWidth: 1100, margin: "40px auto", padding: 16 }}>
      <IntegrationOverviewContent data={data} />
    </main>,
  );
}
