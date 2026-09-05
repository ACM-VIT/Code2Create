import { api } from "@code2create/backend/api";
import { maximumDiscordAllowedRoles, discordSnowflakePattern } from "@code2create/domain";
import { useMutation, useQuery } from "convex/react";
import { useState, type SubmitEvent } from "react";

import {
  ConfigurationTabs,
  type ConfigurationTabsVisibility,
} from "../components/ConfigurationTabs";
import { LoadingLabel, SkeletonCard } from "../components/Skeleton";
import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";

/** One role per line is how people paste them out of Discord. */
function parseRoleIds(text: string) {
  return text
    .split(/[\s,]+/u)
    .map((roleId) => roleId.trim())
    .filter((roleId) => roleId.length > 0);
}

/**
 * The Discord support bridge: whether the bot marks replies, and who may write
 * them.
 *
 * Both used to be deployment configuration, so changing either meant a redeploy
 * of the bot. The bot now reads them on its next poll, within a few seconds of
 * a save.
 */
export function SupportBridgeConfiguration({ tabs }: { tabs: ConfigurationTabsVisibility }) {
  const settings = useQuery(api.supportDiscordConfiguration.settings, { eventSlug });
  const saveSettings = useMutation(api.supportDiscordConfiguration.saveSettings);

  const [reactionsEnabled, setReactionsEnabled] = useState<boolean | null>(null);
  const [roleText, setRoleText] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  if (settings === undefined) {
    return (
      <section className="screen">
        <ConfigurationTabs visibility={tabs} />
        <h1>Discord support</h1>
        <LoadingLabel>Loading support bridge…</LoadingLabel>
        <SkeletonCard lines={4} />
      </section>
    );
  }

  // The stored values until someone edits, then whatever they are editing.
  const currentReactions = reactionsEnabled ?? settings.reactionsEnabled;
  const currentRoleText = roleText ?? settings.allowedRoleIds.join("\n");
  const roleIds = parseRoleIds(currentRoleText);
  const invalidRoleIds = roleIds.filter((roleId) => !discordSnowflakePattern.test(roleId));
  const dirty =
    currentReactions !== settings.reactionsEnabled ||
    roleIds.join(",") !== settings.allowedRoleIds.join(",");
  const tooMany = roleIds.length > maximumDiscordAllowedRoles;
  const canSave = dirty && reason.trim().length >= 3 && !tooMany && invalidRoleIds.length === 0;

  const onSubmit = (submit: SubmitEvent) => {
    submit.preventDefault();
    if (!canSave || saving) return;
    setSaving(true);
    setError(null);
    void saveSettings({
      eventSlug,
      reactionsEnabled: currentReactions,
      allowedRoleIds: roleIds,
      reason: reason.trim(),
    })
      .then(() => {
        setReactionsEnabled(null);
        setRoleText(null);
        setReason("");
        setSavedAt(Date.now());
      })
      .catch((cause: unknown) => setError(readableError(cause)))
      .finally(() => setSaving(false));
  };

  return (
    <section className="screen">
      <ConfigurationTabs visibility={tabs} />
      <h1>Discord support</h1>
      <p className="muted">
        How the support bridge behaves in Discord. The bot picks these up on its next poll, so a
        change takes effect within a few seconds — no redeploy.
      </p>

      <form onSubmit={onSubmit}>
        <fieldset>
          <legend>Reply receipts</legend>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={currentReactions}
              onChange={(change) => setReactionsEnabled(change.target.checked)}
            />
            <span>React to replies in ticket channels</span>
          </label>
          <p className="muted">
            The bot marks each staff reply with the outcome: ✅ recorded, ⛔ not allowed, 🔒 case
            closed, ⚠️ too short, ❓ unexpected. Switching this off silences all of them — including
            the ones that say a reply was <strong>not</strong> recorded, so a refused reply will
            look the same as one that landed.
          </p>
        </fieldset>

        <fieldset>
          <legend>Who may reply</legend>
          <label htmlFor="discord-role-ids">Discord role IDs, one per line</label>
          <textarea
            id="discord-role-ids"
            rows={5}
            value={currentRoleText}
            spellCheck={false}
            onChange={(change) => setRoleText(change.target.value)}
          />
          <p className="muted">
            Guild administrators may always reply. Leave this empty to keep using the roles the bot
            was deployed with. This controls who may <em>write</em> a reply; which roles can see a
            ticket channel stays part of the bot&rsquo;s deployment.
          </p>
          {invalidRoleIds.length > 0 ? (
            <p className="error">
              Not a Discord role ID: {invalidRoleIds.slice(0, 3).join(", ")}
              {invalidRoleIds.length > 3 ? "…" : ""}. A role ID is 6 to 32 digits.
            </p>
          ) : null}
          {tooMany ? (
            <p className="error">At most {maximumDiscordAllowedRoles} roles.</p>
          ) : null}
        </fieldset>

        <fieldset>
          <legend>Reason</legend>
          <label htmlFor="discord-bridge-reason">Why this is changing</label>
          <input
            id="discord-bridge-reason"
            type="text"
            value={reason}
            onChange={(change) => setReason(change.target.value)}
          />
        </fieldset>

        {error ? <p className="error">{error}</p> : null}
        <button type="submit" disabled={!canSave || saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        {savedAt !== null && !dirty ? <span className="muted"> Saved.</span> : null}
      </form>

      <p className="muted">
        {settings.updatedByName === null
          ? "Never changed from the defaults."
          : `Last changed by ${settings.updatedByName}.`}
      </p>
    </section>
  );
}
