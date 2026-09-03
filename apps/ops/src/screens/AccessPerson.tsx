import { api } from "@code2create/backend/api";
import { eventRoleLabels } from "@code2create/domain";
import type { FunctionReturnType } from "convex/server";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useMemo, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";

import { AccessRoleLabel } from "../components/AccessRoleLabel";
import { AccessManagementDisclosure } from "../components/AccessManagementDisclosure";
import { AccessSubjectStatus } from "../components/AccessSubjectStatus";
import { Icon } from "../components/Icon";
import { LoadingLabel, SkeletonList, SkeletonStats } from "../components/Skeleton";
import { PermissionBundleApplication } from "../components/PermissionBundleApplication";
import { PermissionBatchControl } from "../components/PermissionBatchControl";
import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { useOperationRunner } from "../lib/operations";
import {
  grantSourceName,
  type PermissionArea,
  permissionAreas,
  permissionName,
  scopeName,
} from "../lib/permissionLabels";

type AccessDetail = NonNullable<FunctionReturnType<typeof api.access.detail>>;
type PermissionDefinition = AccessDetail["catalog"][number];
type GrantView = FunctionReturnType<typeof api.access.grantLedger>["page"][number];
type DelegationCeiling = AccessDetail["grantDelegations"][number];
type GrantScopeType = "event" | PermissionDefinition["scopes"][number];
type MatrixFilter = "all" | "held" | "missing";

const grantStatusLabels: Record<GrantView["status"], string> = {
  scheduled: "Scheduled",
  active: "Active",
  revoked: "Removed",
  expired: "Expired",
  superseded: "Replaced by a newer grant",
};

type PermissionRow = {
  definition: PermissionDefinition;
  held: boolean;
  ceilings: DelegationCeiling[];
};

function isScopedAuthorityKey(value: string) {
  return (
    value === "access.permissions.grant_scoped" || value === "access.permissions.revoke_scoped"
  );
}

export function AccessPerson() {
  const { personId } = useParams<{ personId: string }>();
  const detail = useQuery(api.access.detail, personId ? { eventSlug, personId } : "skip");
  const ledger = usePaginatedQuery(
    api.access.grantLedger,
    personId && detail ? { eventSlug, personId } : "skip",
    { initialNumItems: 30 },
  );

  if (!personId) return <p className="notice error">Person ID is missing.</p>;
  if (detail === undefined || (detail !== null && ledger.status === "LoadingFirstPage")) {
    return (
      <section className="access-shell">
        <LoadingLabel>Loading this person’s access</LoadingLabel>
        <SkeletonStats columns={3} />
        <SkeletonList rows={6} />
      </section>
    );
  }
  if (!detail) return <p className="notice error">You do not have access to this account.</p>;

  const canAssignRole = detail.actions.assignRole;
  const canSuspend = detail.person.status === "active" && detail.actions.suspend;
  const canReactivate = detail.person.status === "suspended" && detail.actions.reactivate;
  const canUseBundles = detail.actions.useBundles;
  const effectivePermissionCount = detail.effectivePermissionKeys.length;
  const displayedPermissionKeys = detail.currentPermissionKeys.filter(
    (permissionKey) => !isScopedAuthorityKey(permissionKey),
  );
  const catalogByKey = new Map(detail.catalog.map((definition) => [definition.key, definition]));
  const accessAreaCount = new Set(
    displayedPermissionKeys.flatMap((permissionKey) => {
      const definition = catalogByKey.get(permissionKey);
      return definition ? [definition.area] : [];
    }),
  ).size;
  const canManageAccount =
    (detail.person.status === "active" &&
      (canAssignRole ||
        canUseBundles ||
        detail.canGrantAny ||
        detail.grantDelegations.length > 0 ||
        detail.canRevokeAny ||
        detail.revokeDelegations.length > 0)) ||
    canSuspend ||
    canReactivate;

  return (
    <section className="access-shell">
      <Link className="back-link" to="/access">
        ← People and permissions
      </Link>
      <header className="page-heading access-person-heading">
        <div>
          <p className="eyebrow">{roleName(detail)}</p>
          <h1>{detail.person.displayName}</h1>
          <p className="muted">{detail.person.email}</p>
        </div>
        <span className="state-label">
          {detail.person.status === "active" ? "Can sign in" : "Blocked"}
        </span>
      </header>

      {detail.person.status === "suspended" ? (
        <p className="notice">
          This account is blocked, so all {effectivePermissionCount} of its permission types are
          denied at sign-in.
        </p>
      ) : null}

      <section className="access-person-summary" aria-label="Current access">
        <div>
          <span>Current access</span>
          <strong>
            {detail.person.status === "suspended" ? "Account suspended" : roleName(detail)}
          </strong>
          <small>
            {displayedPermissionKeys.length} permission
            {displayedPermissionKeys.length === 1 ? "" : "s"} across {accessAreaCount} product area
            {accessAreaCount === 1 ? "" : "s"}.
          </small>
        </div>
        {canManageAccount ? (
          <a className="secondary compact-link" href="#manage-access">
            Manage account
          </a>
        ) : null}
      </section>

      <PermissionMatrix detail={detail} />

      {canManageAccount ? (
        <section className="access-management" id="manage-access">
          <div className="section-heading">
            <div>
              <h2>Manage account</h2>
              <p className="muted">
                Open the change you need. Every saved change is kept on record.
              </p>
            </div>
          </div>
          <div className="access-management-list">
            {detail.person.status === "active" ? <PermissionBatchControl detail={detail} /> : null}
            {canUseBundles && detail.person.status === "active" ? (
              <PermissionBundleApplication targetPersonId={detail.person.id} />
            ) : null}
            {canAssignRole && detail.person.status === "active" ? (
              <AccessRoleLabel
                key={`${detail.person.id}:${detail.person.role ?? "none"}`}
                accessVersion={detail.accessVersion}
                canGrantAny={detail.canGrantAny}
                canRevokeAny={detail.canRevokeAny}
                currentRole={detail.person.role}
                personId={detail.person.id}
              />
            ) : null}
            {detail.canGrantAny && detail.person.status === "active" ? (
              <ScopedAuthorityControl detail={detail} />
            ) : null}
            {canSuspend || canReactivate ? (
              <AccessSubjectStatus
                key={`${detail.person.id}:${detail.person.status}`}
                accessVersion={detail.accessVersion}
                effectiveGrantCount={effectivePermissionCount}
                personId={detail.person.id}
                status={detail.person.status === "suspended" ? "suspended" : "active"}
              />
            ) : null}
          </div>
        </section>
      ) : null}

      {ledger.results.length > 0 ? (
        <details className="grant-history">
          <summary>Permission ledger · {ledger.results.length} loaded</summary>
          <ul>
            {ledger.results.map((grantItem) => (
              <li key={grantItem.id}>
                <span>{permissionName(grantItem.permissionKey)}</span>
                <small>
                  {grantItem.scopeLabel} · {historicalGrantState(grantItem)} ·{" "}
                  {grantItem.revokeReason ?? grantItem.reason}
                </small>
              </li>
            ))}
          </ul>
          {ledger.status === "CanLoadMore" ? (
            <button className="secondary" type="button" onClick={() => ledger.loadMore(30)}>
              Load more history
            </button>
          ) : null}
        </details>
      ) : null}
    </section>
  );
}

function PermissionMatrix({ detail }: { detail: AccessDetail }) {
  const [chosen, setFilter] = useState<MatrixFilter | null>(null);
  const [search, setSearch] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [openArea, setOpenArea] = useState<PermissionArea | null>(null);

  const rows = useMemo<PermissionRow[]>(() => {
    const current = new Set<string>(detail.currentPermissionKeys);
    return detail.catalog
      .filter((definition) => !isScopedAuthorityKey(definition.key))
      .map((definition) => ({
        definition,
        held: current.has(definition.key),
        ceilings: detail.grantDelegations.filter(
          (candidate) => candidate.permissionKey === definition.key,
        ),
      }));
  }, [detail.catalog, detail.currentPermissionKeys, detail.grantDelegations]);

  const held = rows.filter((row) => row.held).length;
  const heldAreaCount = new Set(rows.filter((row) => row.held).map((row) => row.definition.area))
    .size;
  const filter = chosen ?? (held > 0 ? "held" : "all");
  const term = search.trim().toLowerCase();
  const visible = rows.filter((row) => {
    if (filter === "held" && !row.held) return false;
    if (filter === "missing" && row.held) return false;
    if (term && !row.definition.label.toLowerCase().includes(term)) return false;
    return true;
  });

  const areas = permissionAreas
    .map((area) => ({
      ...area,
      rows: visible
        .filter((row) => row.definition.area === area.value)
        .sort((left, right) => Number(right.held) - Number(left.held)),
    }))
    .filter((area) => area.rows.length > 0);

  return (
    <section className="permission-matrix" id="access-permissions">
      <div className="section-heading">
        <div>
          <h2>Access</h2>
          <p className="muted">
            {held} permissions across {heldAreaCount} product area{heldAreaCount === 1 ? "" : "s"}.
            Open an area to inspect exact scopes or make a change.
          </p>
        </div>
      </div>

      <div className="permission-matrix-controls">
        <div className="configuration-tabs" role="tablist" aria-label="Permission filter">
          {(
            [
              { value: "held", label: `Has access · ${held}` },
              { value: "missing", label: `Can add · ${rows.length - held}` },
              { value: "all", label: `All · ${rows.length}` },
            ] as const
          ).map((option) => (
            <button
              aria-selected={filter === option.value}
              className={filter === option.value ? "active" : ""}
              key={option.value}
              role="tab"
              type="button"
              onClick={() => setFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <label className="field permission-search">
          <span className="visually-hidden">Find a permission</span>
          <input
            placeholder="Find a permission"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>

      {areas.length === 0 ? (
        <div className="health-empty">
          <strong>Nothing matches.</strong>
          <span>No permission in this event matches that filter.</span>
        </div>
      ) : (
        <div className="permission-area-list">
          {areas.map((area) => {
            const expanded = term.length > 0 || openArea === area.value;
            const heldInArea = area.rows.filter((row) => row.held).length;
            return (
              <section className="permission-area" key={area.value}>
                <button
                  aria-expanded={expanded}
                  className="permission-area-summary"
                  type="button"
                  onClick={() => {
                    setOpenKey(null);
                    setOpenArea((current) => (current === area.value ? null : area.value));
                  }}
                >
                  <span>
                    <strong>{area.label}</strong>
                    <small>
                      {filter === "held"
                        ? `${area.rows.length} permission${area.rows.length === 1 ? "" : "s"}`
                        : `${heldInArea} of ${area.rows.length} currently granted`}
                    </small>
                  </span>
                  <span className="permission-area-chevron" aria-hidden="true">
                    ⌄
                  </span>
                </button>
                {expanded ? (
                  <div className="permission-grid">
                    {area.rows.map((row) => (
                      <PermissionMatrixRow
                        detail={detail}
                        isOpen={openKey === row.definition.key}
                        key={row.definition.key}
                        row={row}
                        onToggle={(next) => setOpenKey(next)}
                      />
                    ))}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}

function PermissionMatrixRow({
  detail,
  isOpen,
  onToggle,
  row,
}: {
  detail: AccessDetail;
  isOpen: boolean;
  onToggle: (key: string | null) => void;
  row: PermissionRow;
}) {
  const grantable =
    detail.person.status === "active" && (detail.canGrantAny || row.ceilings.length > 0);

  return (
    <>
      <div className={row.held ? "permission-row held" : "permission-row"}>
        <span className={row.held ? "permission-mark held" : "permission-mark"}>
          {row.held ? <Icon name="shield" size={13} /> : null}
        </span>
        <div className="permission-row-name">
          <strong>{row.definition.label}</strong>
          <small>{row.held ? "Has access" : scopeSummary(row.definition)}</small>
        </div>
        <div className="permission-row-action items-center">
          {isOpen ? (
            <button className="text-button" type="button" onClick={() => onToggle(null)}>
              Close
            </button>
          ) : row.held || grantable ? (
            <button
              className="row-action"
              type="button"
              onClick={() => onToggle(row.definition.key)}
            >
              {row.held ? "View" : "Add"}
            </button>
          ) : (
            <span className="permission-row-note">Not yours to grant</span>
          )}
        </div>
      </div>
      {isOpen ? (
        <div className="permission-row-panel">
          <PermissionAccessPanel detail={detail} row={row} onDone={() => onToggle(null)} />
        </div>
      ) : null}
    </>
  );
}

function PermissionAccessPanel({
  detail,
  onDone,
  row,
}: {
  detail: AccessDetail;
  onDone: () => void;
  row: PermissionRow;
}) {
  const [action, setAction] = useState<"grant" | "remove" | null>(null);
  const active = usePaginatedQuery(
    api.access.grantLedger,
    {
      eventSlug,
      personId: detail.person.id,
      permissionKey: row.definition.key,
      status: "active",
    },
    { initialNumItems: 30 },
  );
  const scheduled = usePaginatedQuery(
    api.access.grantLedger,
    {
      eventSlug,
      personId: detail.person.id,
      permissionKey: row.definition.key,
      status: "scheduled",
    },
    { initialNumItems: 30 },
  );
  const current = [...active.results, ...scheduled.results].filter(
    (grant) => grant.status === "active" || grant.status === "scheduled",
  );
  const removable = current.filter((grant) => grant.canRevoke);
  const grantable =
    detail.person.status === "active" && (detail.canGrantAny || row.ceilings.length > 0);
  const loading = active.status === "LoadingFirstPage" || scheduled.status === "LoadingFirstPage";

  return (
    <>
      {loading ? <p className="muted">Loading where this permission comes from…</p> : null}
      {!loading && current.length === 0 ? (
        <p className="muted">This permission is no longer granted.</p>
      ) : null}
      {!loading && current.length > 0 ? (
        <ul className="permission-source-list">
          {current.map((grant) => (
            <li key={grant.id}>
              <strong>{grant.scopeLabel}</strong>
              <span>
                {grantSourceName(grant.sourceType)} · {grantWindow(grant)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {action === null && (removable.length > 0 || grantable) ? (
        <div className="button-row permission-panel-controls">
          {removable.length > 0 ? (
            <button className="secondary" type="button" onClick={() => setAction("remove")}>
              Remove access
            </button>
          ) : null}
          {grantable ? (
            <button className="secondary" type="button" onClick={() => setAction("grant")}>
              {current.length > 0 ? "Add another scope" : "Add access"}
            </button>
          ) : null}
        </div>
      ) : null}
      {action === "remove" ? (
        <div className="permission-panel-action">
          <h4>Remove access</h4>
          <RemovePanel
            detail={detail}
            grants={current}
            onCancel={() => setAction(null)}
            onDone={onDone}
          />
        </div>
      ) : null}
      {active.status === "CanLoadMore" ? (
        <button className="text-button" type="button" onClick={() => active.loadMore(30)}>
          Load more current grants
        </button>
      ) : null}
      {scheduled.status === "CanLoadMore" ? (
        <button className="text-button" type="button" onClick={() => scheduled.loadMore(30)}>
          Load more scheduled grants
        </button>
      ) : null}
      {action === "grant" ? (
        <div className="permission-panel-action">
          <h4>{current.length > 0 ? "Add another scope" : "Add access"}</h4>
          <GrantPanel detail={detail} row={row} onCancel={() => setAction(null)} onDone={onDone} />
        </div>
      ) : null}
      {!loading && removable.length === 0 && !grantable ? (
        <p className="muted">Someone else owns this permission, so you can’t change it.</p>
      ) : null}
    </>
  );
}

function GrantPanel({
  detail,
  onCancel,
  onDone,
  row,
}: {
  detail: AccessDetail;
  onCancel: () => void;
  onDone: () => void;
  row: PermissionRow;
}) {
  const grant = useMutation(api.access.grant);
  const operations = useOperationRunner();
  const scopes = scopesFor(row.definition);
  const initialCeiling = detail.canGrantAny ? undefined : row.ceilings[0];
  const [ceilingId, setCeilingId] = useState(initialCeiling?.authorityGrantId ?? "");
  const ceiling = detail.canGrantAny
    ? undefined
    : (row.ceilings.find((candidate) => candidate.authorityGrantId === ceilingId) ??
      initialCeiling);
  const [scopeType, setScopeType] = useState<GrantScopeType>(() =>
    ceiling ? ceiling.scopeType : (scopes[0] ?? "event"),
  );
  const [scopeId, setScopeId] = useState(ceiling?.scopeId ?? "");
  const [validUntil, setValidUntil] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const grantPending = operations.hasPending("permission-grant");
  const options = usePaginatedQuery(
    api.access.scopeOptions,
    scopeType === "event" || ceiling !== undefined
      ? "skip"
      : {
          eventSlug,
          targetPersonId: detail.person.id,
          permissionKey: row.definition.key,
          requestedScopeType: scopeType,
        },
    { initialNumItems: 40 },
  );
  const needsResource = scopeType !== "event" && ceiling === undefined;
  const ready =
    reason.trim().length >= 5 &&
    (!needsResource || options.results.some((option) => option.id === scopeId)) &&
    (ceiling === undefined || validUntil.length > 0);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!grantPending && !ready) return;
    setBusy(true);
    setError(null);
    try {
      await operations.run("permission-grant", (clientOperationId) => {
        const expiry = validUntil ? new Date(validUntil).getTime() : undefined;
        if (expiry !== undefined && !Number.isFinite(expiry)) {
          throw new Error("The end time is not a real date.");
        }
        if (ceiling && (expiry === undefined || expiry > ceiling.validUntil)) {
          throw new Error("This permission must end on or before your own authority does.");
        }
        const command = {
          eventSlug,
          targetPersonId: detail.person.id,
          permissionKey: row.definition.key,
          scopeType,
          ...(scopeType === "event" ? {} : { scopeId }),
          ...(expiry !== undefined ? { validUntil: expiry } : {}),
          expectedAccessVersion: detail.accessVersion,
          reason,
          clientOperationId,
        };
        return () => grant(command);
      });
      onDone();
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="permission-panel-form" onSubmit={submit}>
      <p className="muted">
        {ceiling
          ? `You may grant this until ${new Date(ceiling.validUntil).toLocaleString()}, when your own authority ends.`
          : `Gives ${detail.person.displayName} this permission on top of their role.`}
      </p>
      <fieldset disabled={busy || grantPending} style={{ display: "contents" }}>
        {row.ceilings.length > 1 && !detail.canGrantAny ? (
          <label className="field">
            <span>Where it applies</span>
            <select
              value={ceiling?.authorityGrantId ?? ""}
              onChange={(event) => {
                const next = row.ceilings.find(
                  (candidate) => candidate.authorityGrantId === event.target.value,
                );
                if (!next) return;
                setCeilingId(next.authorityGrantId);
                setScopeType(next.scopeType);
                setScopeId(next.scopeId ?? "");
              }}
            >
              {row.ceilings.map((candidate) => (
                <option key={candidate.authorityGrantId} value={candidate.authorityGrantId}>
                  {candidate.scopeLabel} · until {new Date(candidate.validUntil).toLocaleString()}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {scopes.length > 1 && ceiling === undefined ? (
          <label className="field">
            <span>Where it applies</span>
            <select
              value={scopeType}
              onChange={(event) => {
                const next = scopes.find((candidate) => candidate === event.target.value);
                if (!next) return;
                setScopeType(next);
                setScopeId("");
              }}
            >
              {scopes.map((scope) => (
                <option key={scope} value={scope}>
                  {scopeName(scope, row.definition.key)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {needsResource ? (
          options.status === "LoadingFirstPage" ? (
            <div className="field">
              <span>{scopeName(scopeType, row.definition.key)}</span>
              <p className="muted">Finding available choices…</p>
            </div>
          ) : options.results.length > 0 ? (
            <label className="field">
              <span>{scopeName(scopeType, row.definition.key)}</span>
              <select value={scopeId} onChange={(event) => setScopeId(event.target.value)}>
                <option value="">Choose one</option>
                {options.results.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="field">
              <span>{scopeName(scopeType, row.definition.key)}</span>
              <p className="muted">Nothing is available for this permission right now.</p>
            </div>
          )
        ) : null}
        {needsResource && options.status === "CanLoadMore" ? (
          <button className="text-button" type="button" onClick={() => options.loadMore(40)}>
            Show more
          </button>
        ) : null}
        <label className="field">
          <span>
            Ends <small>{ceiling ? "Required" : "Optional"} · your local time</small>
          </span>
          <input
            required={ceiling !== undefined}
            type="datetime-local"
            value={validUntil}
            onChange={(event) => setValidUntil(event.target.value)}
          />
        </label>
        <label className="field permission-panel-wide">
          <span>Why they need it</span>
          <textarea required value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
      </fieldset>
      {error ? (
        <p className="notice error permission-panel-wide" role="alert">
          {error}
        </p>
      ) : null}
      <div className="button-row permission-panel-wide">
        <button className="primary" type="submit" disabled={busy || (!grantPending && !ready)}>
          {busy ? "Granting…" : grantPending ? "Confirm earlier grant" : "Grant permission"}
        </button>
        <button
          className="secondary"
          type="button"
          disabled={busy || grantPending}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function RemovePanel({
  detail,
  grants,
  onCancel,
  onDone,
}: {
  detail: AccessDetail;
  grants: GrantView[];
  onCancel: () => void;
  onDone: () => void;
}) {
  const revoke = useMutation(api.access.revoke);
  const operations = useOperationRunner();
  const removable = grants.filter((grant) => grant.canRevoke);
  const kept = grants.filter((grant) => !grant.canRevoke);
  const [targetId, setTargetId] = useState(removable[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = removable.find((grant) => grant.id === targetId);
  const revokePending = operations.hasPending("permission-revoke");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!revokePending && (!target || reason.trim().length < 5)) return;
    setBusy(true);
    setError(null);
    try {
      await operations.run("permission-revoke", (clientOperationId) => {
        if (!target) throw new Error("The permission is no longer available to remove.");
        return () =>
          revoke({
            eventSlug,
            grantId: target.id,
            expectedAccessVersion: detail.accessVersion,
            reason,
            clientOperationId,
          });
      });
      onDone();
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="permission-panel-form" onSubmit={submit}>
      <p className="muted">
        {kept.length > 0
          ? `${detail.person.displayName} also holds this through ${kept.map((grant) => grantSourceName(grant.sourceType).toLowerCase()).join(" and ")}, so removing this grant leaves it in place.`
          : `${detail.person.displayName} loses this permission as soon as this is removed.`}
      </p>
      <fieldset disabled={busy || revokePending} style={{ display: "contents" }}>
        {removable.length > 1 ? (
          <label className="field">
            <span>Which one to remove</span>
            <select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
              {removable.map((grant) => (
                <option key={grant.id} value={grant.id}>
                  {grant.scopeLabel} · {grantSourceName(grant.sourceType)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {target ? (
          <p className="muted permission-panel-wide">
            {grantWindow(target)} · granted because: {target.reason}
          </p>
        ) : null}
        <label className="field permission-panel-wide">
          <span>Why it is being removed</span>
          <textarea required value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
      </fieldset>
      {error ? (
        <p className="notice error permission-panel-wide" role="alert">
          {error}
        </p>
      ) : null}
      <div className="button-row permission-panel-wide">
        <button
          className="primary"
          type="submit"
          disabled={busy || (!revokePending && (!target || reason.trim().length < 5))}
        >
          {busy ? "Removing…" : revokePending ? "Confirm earlier removal" : "Remove permission"}
        </button>
        <button
          className="secondary"
          type="button"
          disabled={busy || revokePending}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function ScopedAuthorityControl({ detail }: { detail: AccessDetail }) {
  const grant = useMutation(api.access.grant);
  const operations = useOperationRunner();
  const delegable = detail.catalog.filter(
    (definition) =>
      !isScopedAuthorityKey(definition.key) &&
      definition.key !== "access.permissions.grant_any" &&
      definition.key !== "access.permissions.revoke_any" &&
      delegableScopesFor(definition).length > 0,
  );
  const [authorityKey, setAuthorityKey] = useState("access.permissions.grant_scoped");
  const [permissionKey, setPermissionKey] = useState(delegable[0]?.key ?? "");
  const definition = delegable.find((candidate) => candidate.key === permissionKey);
  const scopes = definition ? delegableScopesFor(definition) : [];
  const [scopeType, setScopeType] = useState<GrantScopeType>(() =>
    delegable[0] ? (delegableScopesFor(delegable[0])[0] ?? "event") : "event",
  );
  const [scopeId, setScopeId] = useState("");
  const [targetKind, setTargetKind] = useState<"any_event_person" | "exact_email">(
    "any_event_person",
  );
  const [targetEmail, setTargetEmail] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const delegationPending = operations.hasPending("permission-delegation");
  const verb = authorityKey === "access.permissions.grant_scoped" ? "grant" : "remove";
  const options = usePaginatedQuery(
    api.access.scopeOptions,
    !open || scopeType === "event" || !permissionKey
      ? "skip"
      : {
          eventSlug,
          targetPersonId: detail.person.id,
          permissionKey,
          requestedScopeType: scopeType,
        },
    { initialNumItems: 40 },
  );
  const ready =
    permissionKey.length > 0 &&
    validUntil.length > 0 &&
    reason.trim().length >= 5 &&
    (scopeType === "event" || options.results.some((option) => option.id === scopeId)) &&
    (targetKind === "any_event_person" || targetEmail.trim().length > 0);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!delegationPending && !ready) return;
    setBusy(true);
    setError(null);
    try {
      await operations.run("permission-delegation", (clientOperationId) => {
        const expiry = new Date(validUntil).getTime();
        if (!Number.isFinite(expiry)) throw new Error("The end time is not a real date.");
        const command = {
          eventSlug,
          targetPersonId: detail.person.id,
          permissionKey: authorityKey,
          scopeType: "event" as const,
          validUntil: expiry,
          delegation: {
            permissionKey,
            scopeType,
            ...(scopeType === "event" ? {} : { scopeId }),
            target:
              targetKind === "any_event_person"
                ? { kind: "any_event_person" as const }
                : { kind: "exact_email" as const, email: targetEmail },
          },
          expectedAccessVersion: detail.accessVersion,
          reason,
          clientOperationId,
        };
        return () => grant(command);
      });
      setOpen(false);
      setReason("");
      setValidUntil("");
      setScopeId("");
      setTargetEmail("");
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  if (delegable.length === 0) return null;
  return (
    <AccessManagementDisclosure
      description={`Let ${detail.person.displayName} grant or remove one exact permission for others.`}
      onToggle={setOpen}
      open={open}
      title="Pass on a permission"
    >
      <form className="grant-form" onSubmit={submit}>
        <fieldset disabled={busy || delegationPending} style={{ display: "contents" }}>
          <label className="field">
            <span>They may</span>
            <select value={authorityKey} onChange={(event) => setAuthorityKey(event.target.value)}>
              <option value="access.permissions.grant_scoped">
                Give this permission to others
              </option>
              <option value="access.permissions.revoke_scoped">
                Take this permission away from others
              </option>
            </select>
          </label>
          <label className="field">
            <span>Which permission</span>
            <select
              value={permissionKey}
              onChange={(event) => {
                const nextDefinition = delegable.find(
                  (candidate) => candidate.key === event.target.value,
                );
                const nextScope = nextDefinition
                  ? delegableScopesFor(nextDefinition)[0]
                  : undefined;
                if (!nextDefinition || !nextScope) return;
                setPermissionKey(nextDefinition.key);
                setScopeType(nextScope);
                setScopeId("");
              }}
            >
              {delegable.map((candidate) => (
                <option key={candidate.key} value={candidate.key}>
                  {candidate.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Where it applies</span>
            <select
              value={scopeType}
              onChange={(event) => {
                const next = scopes.find((candidate) => candidate === event.target.value);
                if (!next) return;
                setScopeType(next);
                setScopeId("");
              }}
            >
              {scopes.map((scope) => (
                <option key={scope} value={scope}>
                  {scopeName(scope, permissionKey)}
                </option>
              ))}
            </select>
          </label>
          {scopeType !== "event" ? (
            options.status === "LoadingFirstPage" ? (
              <div className="field">
                <span>{scopeName(scopeType, permissionKey)}</span>
                <p className="muted">Finding available choices…</p>
              </div>
            ) : options.results.length > 0 ? (
              <label className="field">
                <span>{scopeName(scopeType, permissionKey)}</span>
                <select value={scopeId} onChange={(event) => setScopeId(event.target.value)}>
                  <option value="">Choose one</option>
                  {options.results.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <div className="field">
                <span>{scopeName(scopeType, permissionKey)}</span>
                <p className="muted">Nothing is available for this permission right now.</p>
              </div>
            )
          ) : null}
          <label className="field">
            <span>Who they may {verb} it for</span>
            <select
              value={targetKind}
              onChange={(event) =>
                setTargetKind(
                  event.target.value === "exact_email" ? "exact_email" : "any_event_person",
                )
              }
            >
              <option value="any_event_person">Anyone with an event account</option>
              <option value="exact_email">One exact email address</option>
            </select>
          </label>
          {targetKind === "exact_email" ? (
            <label className="field">
              <span>Email address</span>
              <input
                autoComplete="off"
                inputMode="email"
                type="email"
                value={targetEmail}
                onChange={(event) => setTargetEmail(event.target.value)}
              />
            </label>
          ) : null}
          <label className="field">
            <span>
              Ends <small>Required · your local time</small>
            </span>
            <input
              required
              type="datetime-local"
              value={validUntil}
              onChange={(event) => setValidUntil(event.target.value)}
            />
          </label>
          <label className="field full-field">
            <span>Why they need it</span>
            <textarea required value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
        </fieldset>
        {error ? (
          <p className="notice error full-field" role="alert">
            {error}
          </p>
        ) : null}
        <div className="button-row full-field">
          <button
            className="primary"
            type="submit"
            disabled={busy || (!delegationPending && !ready)}
          >
            {busy ? "Saving…" : delegationPending ? "Confirm earlier delegation" : "Pass it on"}
          </button>
          <button
            className="secondary"
            type="button"
            disabled={busy || delegationPending}
            onClick={() => setOpen(false)}
          >
            Cancel
          </button>
        </div>
      </form>
    </AccessManagementDisclosure>
  );
}

function scopeSummary(definition: PermissionDefinition) {
  const scopes = scopesFor(definition);
  if (scopes.length === 1 && scopes[0]) return scopeName(scopes[0], definition.key);
  return scopes.map((scope) => scopeName(scope, definition.key)).join(" or ");
}

function grantWindow(grant: GrantView) {
  const start =
    grant.status === "scheduled"
      ? `Starts ${formatAccessTime(grant.validFrom)}`
      : grant.activatedAt !== undefined
        ? `Active since ${formatAccessTime(grant.activatedAt)}`
        : "Active now";
  return grant.validUntil === undefined
    ? start
    : `${start}, ends ${formatAccessTime(grant.validUntil)}`;
}

function historicalGrantState(grant: GrantView) {
  if (grant.status === "expired" && grant.expiredAt !== undefined) {
    return `Expired ${formatAccessTime(grant.expiredAt)}`;
  }
  if (grant.status === "revoked" && grant.revokedAt !== undefined) {
    return `Removed ${formatAccessTime(grant.revokedAt)}`;
  }
  return grantStatusLabels[grant.status];
}

function formatAccessTime(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}

function scopesFor(definition: PermissionDefinition): GrantScopeType[] {
  return definition.eventWide ? ["event", ...definition.scopes] : [...definition.scopes];
}

function delegableScopesFor(definition: PermissionDefinition): GrantScopeType[] {
  return scopesFor(definition).filter((scope) => {
    if (scope === "self" || scope === "page") return false;
    if (
      scope === "scorecard" &&
      (definition.key === "scorecard.draft.write" ||
        definition.key === "scorecard.submit" ||
        definition.key === "scorecard.correction.request")
    )
      return false;
    return true;
  });
}

function roleName(detail: AccessDetail) {
  const parts: string[] = [];
  if (detail.person.role) parts.push(eventRoleLabels[detail.person.role]);
  if (detail.person.isParticipant) parts.push("Participant");
  return parts.length > 0 ? parts.join(" · ") : "No role";
}
