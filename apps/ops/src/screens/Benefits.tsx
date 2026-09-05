import { api } from "@code2create/backend/api";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

import { LoadingLabel, SkeletonList } from "../components/Skeleton";
import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { useOperationRunner } from "../lib/operations";

type BenefitList = FunctionReturnType<typeof api.benefits.list>;
type Benefit = BenefitList["benefits"][number];

type NewBenefit = {
  name: string;
  description: string;
  link: string;
  scope: Benefit["scope"];
  codeMode: Benefit["codeMode"];
  sharedCode: string;
  codes: string;
  reason: string;
};

const emptyBenefit: NewBenefit = {
  name: "",
  description: "",
  link: "",
  scope: "team",
  codeMode: "shared",
  sharedCode: "",
  codes: "",
  reason: "",
};

function splitCodes(value: string) {
  return value
    .split(/\r?\n|,/)
    .map((code) => code.trim())
    .filter(Boolean);
}

/** The benefits desk: perks with a code and a link, handed to teams or people. */
export function Benefits() {
  const list = useQuery(api.benefits.list, { eventSlug });
  if (list === undefined) {
    return (
      <section className="benefits-shell">
        <LoadingLabel>Loading benefits</LoadingLabel>
        <SkeletonList rows={3} />
      </section>
    );
  }
  const active = list.benefits.filter((benefit) => benefit.status === "active");
  const archived = list.benefits.filter((benefit) => benefit.status === "archived");
  return (
    <section className="benefits-shell">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Perks and codes</p>
          <h1>Benefits</h1>
          <p className="muted">
            A benefit is a name, a code, and a link. Hand it to every confirmed team or accepted participant at once, or to one team or person. Participants see theirs on the dashboard.
          </p>
        </div>
      </div>

      {list.canManage ? <NewBenefitForm /> : null}

      <section className="synesthesia-section" aria-labelledby="benefits-active-title">
        <div className="section-heading">
          <div>
            <h2 id="benefits-active-title">Active benefits</h2>
          </div>
        </div>
        {active.length === 0 ? (
          <div className="health-empty">
            <strong>No benefits yet.</strong>
            <span>{list.canManage ? "Create one above." : "Creating benefits needs the benefit-manage permission."}</span>
          </div>
        ) : (
          <div className="benefits-list">
            {active.map((benefit) => (
              <BenefitCard benefit={benefit} canManage={list.canManage} key={benefit.id} />
            ))}
          </div>
        )}
      </section>

      {archived.length > 0 ? (
        <section className="synesthesia-section">
          <h2>Archived</h2>
          <div className="benefits-list">
            {archived.map((benefit) => (
              <BenefitCard benefit={benefit} canManage={false} key={benefit.id} />
            ))}
          </div>
        </section>
      ) : null}
    </section>
  );
}

function NewBenefitForm() {
  const create = useMutation(api.benefits.create);
  const operations = useOperationRunner();
  const [values, setValues] = useState<NewBenefit>(emptyBenefit);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = operations.hasPending("benefit-create");
  const update = (patch: Partial<NewBenefit>) => setValues((current) => ({ ...current, ...patch }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await operations.run("benefit-create", (clientOperationId) => () =>
        create({
          eventSlug,
          name: values.name,
          ...(values.description.trim() ? { description: values.description } : {}),
          ...(values.link.trim() ? { link: values.link } : {}),
          scope: values.scope,
          codeMode: values.codeMode,
          ...(values.codeMode === "shared" ? { sharedCode: values.sharedCode } : {}),
          codes: values.codeMode === "unique" ? splitCodes(values.codes) : [],
          reason: values.reason,
          clientOperationId,
        }),
      );
      setValues(emptyBenefit);
      setOpen(false);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <section className="stage-block">
        <p>Add a perk participants can redeem.</p>
        <button type="button" className="primary" onClick={() => setOpen(true)}>
          New benefit
        </button>
      </section>
    );
  }

  return (
    <form
      className="synesthesia-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div>
        <p className="eyebrow">New benefit</p>
        <h2>{values.name.trim() || "Untitled benefit"}</h2>
      </div>
      <fieldset disabled={busy || pending} style={{ display: "contents" }}>
        <div className="synesthesia-editor-grid">
          <label className="field">
            <span>Name</span>
            <input value={values.name} maxLength={80} required placeholder="Cloud credits" onChange={(event) => update({ name: event.target.value })} />
          </label>
          <label className="field">
            <span>Link, if any</span>
            <input value={values.link} maxLength={500} placeholder="https://…" onChange={(event) => update({ link: event.target.value })} />
          </label>
          <label className="field">
            <span>Who gets it</span>
            <select value={values.scope} onChange={(event) => update({ scope: event.target.value === "person" ? "person" : "team" })}>
              <option value="team">Each team, one code per team</option>
              <option value="person">Each participant, one code per person</option>
            </select>
          </label>
          <label className="field">
            <span>Codes</span>
            <select value={values.codeMode} onChange={(event) => update({ codeMode: event.target.value === "unique" ? "unique" : "shared" })}>
              <option value="shared">One shared code for everyone</option>
              <option value="unique">A pool of unique codes</option>
            </select>
          </label>
        </div>
        <label className="field">
          <span>What it is (shown to participants)</span>
          <textarea value={values.description} maxLength={300} onChange={(event) => update({ description: event.target.value })} />
        </label>
        {values.codeMode === "shared" ? (
          <label className="field">
            <span>Shared code</span>
            <input data-ph-sensitive value={values.sharedCode} maxLength={120} required onChange={(event) => update({ sharedCode: event.target.value })} />
          </label>
        ) : (
          <label className="field">
            <span>Unique codes, one per line ({splitCodes(values.codes).length})</span>
            <textarea data-ph-sensitive value={values.codes} required rows={6} onChange={(event) => update({ codes: event.target.value })} />
          </label>
        )}
        <label className="field">
          <span>Reason (kept on record)</span>
          <textarea value={values.reason} minLength={5} maxLength={200} required onChange={(event) => update({ reason: event.target.value })} />
        </label>
      </fieldset>
      <div className="synesthesia-command-actions">
        <button type="button" className="text-button" disabled={busy || pending} onClick={() => { setOpen(false); setError(null); }}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={busy || (!pending && values.reason.trim().length < 5)}>
          {busy ? "Saving…" : pending ? "Confirm earlier save" : "Create benefit"}
        </button>
      </div>
      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </form>
  );
}

function BenefitCard({ benefit, canManage }: { benefit: Benefit; canManage: boolean }) {
  const grant = useMutation(api.benefits.grant);
  const grantAll = useMutation(api.benefits.grantAll);
  const addCodes = useMutation(api.benefits.addCodes);
  const archive = useMutation(api.benefits.archive);
  const operations = useOperationRunner();
  const [action, setAction] = useState<"one" | "all" | "codes" | "archive" | null>(null);
  const [target, setTarget] = useState("");
  const [codes, setCodes] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const slot = action ? `benefit-${action}-${benefit.id}` : null;
  const pending = slot !== null && operations.hasPending(slot);
  const grantAllRunning =
    benefit.latestGrantRun?.status !== undefined && benefit.latestGrantRun.status !== "complete";

  const run = async () => {
    if (!action || !slot) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await operations.run(slot, (clientOperationId) => async () => {
        if (action === "one") {
          const result = await grant({
            eventSlug,
            benefitId: benefit.id,
            target: benefit.scope === "team" ? { kind: "team", publicCode: target } : { kind: "person", email: target },
            reason,
            clientOperationId,
          });
          setNotice(result.created ? `Handed out. Code ${result.code}.` : `They already had it. Code ${result.code}.`);
        } else if (action === "all") {
          const result = await grantAll({ eventSlug, benefitId: benefit.id, reason, clientOperationId });
          setNotice(
            result.status === "complete"
              ? `Handout complete: ${result.granted} new, ${result.alreadyHad} already had it${result.outOfCodes > 0 ? `, ${result.outOfCodes} could not receive a code` : ""}.`
              : "Handout started. Progress updates here automatically.",
          );
        } else if (action === "codes") {
          const result = await addCodes({ eventSlug, benefitId: benefit.id, codes: splitCodes(codes), reason, clientOperationId });
          setNotice(`${result.added} codes added.`);
        } else {
          await archive({ eventSlug, benefitId: benefit.id, reason, clientOperationId });
        }
      });
      setAction(null);
      setTarget("");
      setCodes("");
      setReason("");
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="benefit">
      <div className="benefit-heading">
        <div>
          <strong>{benefit.name}</strong>
          <span>
            {benefit.scope === "team" ? "Per team" : "Per person"} · {benefit.codeMode === "shared" ? <>shared code <span data-ph-sensitive>{benefit.sharedCode ?? ""}</span></> : `${benefit.availableCodes} codes left`} · {benefit.grantCount} handed out
          </span>
          {benefit.latestGrantRun ? (
            <span role="status">
              {benefit.latestGrantRun.status === "complete"
                ? `Last handout completed: ${benefit.latestGrantRun.granted} new, ${benefit.latestGrantRun.alreadyHad} already held it${benefit.latestGrantRun.outOfCodes > 0 ? `, ${benefit.latestGrantRun.outOfCodes} without a code` : ""}.`
                : `Handing out now: ${benefit.latestGrantRun.scanned} checked, ${benefit.latestGrantRun.granted} new${benefit.latestGrantRun.outOfCodes > 0 ? `, ${benefit.latestGrantRun.outOfCodes} without a code so far` : ""}.`}
            </span>
          ) : null}
          {benefit.description ? <p>{benefit.description}</p> : null}
          {benefit.link ? (
            <a href={benefit.link} target="_blank" rel="noreferrer">
              {benefit.link}
            </a>
          ) : null}
        </div>
        {canManage ? (
          <div className="synesthesia-request-actions">
            <button type="button" className="text-button" disabled={busy || grantAllRunning} onClick={() => setAction("all")}>
              {grantAllRunning ? "Handing out…" : benefit.scope === "team" ? "Give to all confirmed teams" : "Give to all participants"}
            </button>
            <button type="button" className="text-button" disabled={busy} onClick={() => setAction("one")}>
              {benefit.scope === "team" ? "Give to a team" : "Give to a person"}
            </button>
            {benefit.codeMode === "unique" ? (
              <button type="button" className="text-button" disabled={busy} onClick={() => setAction("codes")}>
                Add codes
              </button>
            ) : null}
            <button type="button" className="text-button" disabled={busy} onClick={() => setAction("archive")}>
              Archive
            </button>
          </div>
        ) : null}
      </div>
      {action ? (
        <form
          className="synesthesia-command"
          onSubmit={(event) => {
            event.preventDefault();
            void run();
          }}
        >
          <strong>
            {action === "all"
              ? benefit.scope === "team" ? "Give this to every confirmed team" : "Give this to every accepted participant"
              : action === "one"
                ? benefit.scope === "team" ? "Give this to one team" : "Give this to one person"
                : action === "codes"
                  ? "Add codes"
                  : "Archive this benefit"}
          </strong>
          <fieldset disabled={busy || pending} style={{ display: "contents" }}>
            {action === "one" ? (
              <label className="field">
                <span>{benefit.scope === "team" ? "Team code" : "Participant email"}</span>
                <input value={target} required onChange={(event) => setTarget(event.target.value)} />
              </label>
            ) : null}
            {action === "codes" ? (
              <label className="field">
                <span>Codes, one per line ({splitCodes(codes).length})</span>
                <textarea data-ph-sensitive value={codes} required rows={5} onChange={(event) => setCodes(event.target.value)} />
              </label>
            ) : null}
            <label className="field">
              <span>Reason (kept on record)</span>
              <textarea value={reason} minLength={5} maxLength={200} required onChange={(event) => setReason(event.target.value)} />
            </label>
          </fieldset>
          <div className="synesthesia-command-actions">
            <button type="button" className="text-button" disabled={busy} onClick={() => { setAction(null); setError(null); }}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={busy || (!pending && reason.trim().length < 5)}>
              {busy ? "Working…" : pending ? "Confirm earlier action" : "Confirm"}
            </button>
          </div>
          {error ? <p className="notice error" role="alert">{error}</p> : null}
        </form>
      ) : null}
      {notice ? <p className="m-0 text-[0.8125rem] text-green" role="status" data-ph-sensitive>{notice}</p> : null}
    </article>
  );
}
