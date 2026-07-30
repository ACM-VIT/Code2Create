import { redirect } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";
import { DocsShell, type DocumentItem } from "./DocsShell";
import readme from "../README.md?raw";
import productBrief from "../specs/00-product-brief.md?raw";
import domainAccess from "../specs/01-domain-and-access.md?raw";
import onboarding from "../specs/02-participant-onboarding.md?raw";
import panels from "../specs/03-panel-and-queue-operations.md?raw";
import reviewerApp from "../specs/04-reviewer-application.md?raw";
import evaluation from "../specs/05-evaluation-system.md?raw";
import operations from "../specs/06-operations-dashboard.md?raw";
import reliability from "../specs/07-reliability-safety-audit.md?raw";
import synesthesia from "../specs/08-synesthesia.md?raw";
import delivery from "../specs/09-delivery-and-acceptance.md?raw";
import decisions from "../specs/10-decision-register.md?raw";
import architecture from "../specs/11-production-architecture.md?raw";
import dataModel from "../specs/12-data-model-and-realtime.md?raw";
import integrations from "../specs/13-integrations-and-release.md?raw";
import attendance from "../specs/14-attendance-and-presence.md?raw";

export const dynamic = "force-dynamic";

const documents: DocumentItem[] = [
  { slug: "index", number: "00", label: "Start here", content: readme },
  { slug: "product-brief", number: "01", label: "Product brief", content: productBrief },
  { slug: "identity-access", number: "02", label: "Identity & access", content: domainAccess },
  { slug: "participant-portal", number: "03", label: "Participant portal", content: onboarding },
  { slug: "attendance", number: "04", label: "Attendance & presence", content: attendance },
  { slug: "panels-queues", number: "05", label: "Panels & queues", content: panels },
  { slug: "reviewer-app", number: "06", label: "Reviewer app", content: reviewerApp },
  { slug: "evaluation", number: "07", label: "Evaluation", content: evaluation },
  { slug: "operations", number: "08", label: "Operations dashboard", content: operations },
  { slug: "reliability-audit", number: "09", label: "Reliability & audit", content: reliability },
  { slug: "synesthesia", number: "10", label: "Synesthesia", content: synesthesia },
  { slug: "delivery", number: "11", label: "Delivery & acceptance", content: delivery },
  { slug: "decisions", number: "12", label: "Decision register", content: decisions },
  { slug: "architecture", number: "13", label: "Production architecture", content: architecture },
  { slug: "data-model", number: "14", label: "Data model & realtime", content: dataModel },
  { slug: "integrations", number: "15", label: "Integrations & release", content: integrations },
];

export default async function Home() {
  if (!(await isAuthenticated())) redirect("/login");
  return <DocsShell documents={documents} />;
}
