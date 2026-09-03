import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ClientObservabilityProvider } from "@code2create/client-observability";

// Base tokens first so section stylesheets (pulled in via App) can override.
import "./styles/base.css";
import "./styles/botanical.css";
import App from "./App.js";
import { clientConfiguration } from "./lib/config.js";

const rootElement = document.querySelector("#root");
if (!rootElement) throw new Error("The landing page root element is missing.");

createRoot(rootElement).render(
  <ClientObservabilityProvider
    configuration={{
      projectToken: clientConfiguration.posthogProjectToken,
      host: clientConfiguration.posthogHost,
      deploymentEnvironment: clientConfiguration.deploymentEnvironment,
      release: clientConfiguration.releaseId,
      surface: "landing-web",
      development: import.meta.env.DEV,
    }}
  >
    <StrictMode>
      <App />
    </StrictMode>
  </ClientObservabilityProvider>,
);
