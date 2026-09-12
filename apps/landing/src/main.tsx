import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { ClientObservabilityProvider } from "@code2create/client-observability";

// Base tokens first so section stylesheets (pulled in via App) can override.
import "./styles/base.css";
import "./styles/botanical.css";
import { clientConfiguration } from "./lib/config.js";
import { DelayedBonsai } from "./photos/DelayedBonsai.js";

const rootElement = document.querySelector("#root");
if (!rootElement) throw new Error("The landing page root element is missing.");
const Photos = lazy(() => import("./photos/Photos.js"));
const App = lazy(() => import("./App.js"));
const isPhotos = window.location.pathname.replace(/\/$/, "") === "/photos";

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
      <Suspense fallback={<DelayedBonsai />}>
        {isPhotos ? <Photos /> : <App />}
      </Suspense>
    </StrictMode>
  </ClientObservabilityProvider>,
);
