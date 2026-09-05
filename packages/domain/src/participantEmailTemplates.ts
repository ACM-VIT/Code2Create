export const participantEmailTemplateKeys = [
  "accept",
  "waitlist",
  "decline",
  "offer",
  "offer_confirmed",
  "offer_declined",
  "offer_expired",
  "external_event_pass",
] as const;

export type ParticipantEmailTemplateKey = (typeof participantEmailTemplateKeys)[number];

export const participantEmailTemplateZipMaximumBytes = 3_500_000;

export type ParticipantEmailTemplateAssetReplacement = {
  fileName: string;
  replacement: string;
};

export function normalizeParticipantEmailTemplateAssetReference(value: string) {
  const trimmed = value.trim();
  const withoutContentId = trimmed.startsWith("cid:") ? trimmed.slice(4) : trimmed;
  return withoutContentId.replace(/^\.\//u, "");
}

export function rewriteParticipantEmailTemplateAssetReferences(
  html: string,
  replacements: readonly ParticipantEmailTemplateAssetReplacement[],
) {
  const byFileName = new Map(
    replacements.map(({ fileName, replacement }) => [fileName, replacement] as const),
  );
  const replacementFor = (reference: string) =>
    byFileName.get(normalizeParticipantEmailTemplateAssetReference(reference));

  return html
    .replace(/\bsrc(\s*=\s*)"([^"]*)"/giu, (attribute, spacing: string, reference: string) => {
      const replacement = replacementFor(reference);
      return replacement === undefined ? attribute : `src${spacing}"${replacement}"`;
    })
    .replace(/\bsrc(\s*=\s*)'([^']*)'/giu, (attribute, spacing: string, reference: string) => {
      const replacement = replacementFor(reference);
      return replacement === undefined ? attribute : `src${spacing}'${replacement}'`;
    })
    .replace(/\burl\(\s*"([^"]*)"\s*\)/giu, (value, reference: string) => {
      const replacement = replacementFor(reference);
      return replacement === undefined ? value : `url("${replacement}")`;
    })
    .replace(/\burl\(\s*'([^']*)'\s*\)/giu, (value, reference: string) => {
      const replacement = replacementFor(reference);
      return replacement === undefined ? value : `url('${replacement}')`;
    })
    .replace(/\burl\(\s*([^"'()]*)\s*\)/giu, (value, reference: string) => {
      const replacement = replacementFor(reference);
      return replacement === undefined ? value : `url(${replacement})`;
    });
}

export type ParticipantEmailTemplate = {
  templateKey: ParticipantEmailTemplateKey;
  subject: string;
  text: string;
  html: string;
};

export const participantEmailTemplateLabels: Record<ParticipantEmailTemplateKey, string> = {
  accept: "Selected",
  waitlist: "Waitlisted",
  decline: "Not selected",
  offer: "Offer sent",
  offer_confirmed: "Offer confirmed",
  offer_declined: "Offer declined",
  offer_expired: "Offer expired",
  external_event_pass: "External event pass",
};

const portalAction = `<a href="{{portal_url}}" style="display:inline-block;margin-top:20px;padding:12px 18px;border-radius:8px;background:#7f2848;color:#ffffff;text-decoration:none;font-weight:700">Open Code2Create</a>`;

function emailHtml(heading: string, message: string) {
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#f8f2f4;color:#2d101b;font-family:Arial,sans-serif">
    <main style="max-width:600px;margin:0 auto;padding:40px 24px">
      <p style="margin:0 0 24px;color:#7f2848;font-weight:700">Code2Create 7.0</p>
      <p>Hi {{participant_name}},</p>
      <h1 style="font-size:30px;line-height:1.15">${heading}</h1>
      <p style="font-size:16px;line-height:1.6">${message}</p>
      ${portalAction}
      <p style="margin-top:32px;color:#725d65;font-size:13px">This update applies to {{team_name}}.</p>
    </main>
  </body>
</html>`;
}

function externalEventPassHtml() {
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#ffffff;color:#19070f;font-family:Inter,Arial,sans-serif">
    <main style="max-width:600px;margin:0 auto;padding:32px 20px;text-align:center">
      <p style="margin:0 0 8px;color:#b44f76;font-size:13px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase">ACM-VIT presents</p>
      <h1 style="margin:0 0 28px;font-size:34px;line-height:1.1">{{event_name}}</h1>
      <section style="overflow:hidden;border:2px solid #b44f76;border-radius:22px;background:#fff8fb;box-shadow:0 12px 32px rgba(94,25,52,.12)">
        <div style="padding:24px;background:#b44f76;color:#ffffff;text-align:left">
          <p style="margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:1.3px;text-transform:uppercase">External participant pass</p>
          <h2 style="margin:0;font-size:26px">{{participant_name}}</h2>
          <p style="margin:7px 0 0;opacity:.9">{{team_name}}</p>
        </div>
        <div style="padding:28px 24px">
          <img src="cid:event-pass-qr.png" alt="Personal Code2Create event pass QR" width="240" height="240" style="display:block;width:240px;max-width:100%;height:auto;margin:0 auto 18px;border:12px solid #ffffff;border-radius:16px" />
          <p style="margin:0 0 8px;font-size:16px;font-weight:700">Present this pass before your photo ID</p>
          <p style="margin:0;color:#725d65;font-size:13px;line-height:1.55">This QR is personal, static for the event, and must not be shared. Staff will verify your physical ID at first check-in.</p>
          <div style="margin-top:22px;padding-top:20px;border-top:1px solid #e9cbd7;text-align:left;font-size:14px;line-height:1.6">
            <p style="margin:0"><strong>When:</strong> {{event_start}}</p>
            <p style="margin:4px 0 0"><strong>Where:</strong> {{venue_name}}</p>
            <p style="margin:4px 0 0"><strong>Pass:</strong> {{pass_reference}}</p>
          </div>
        </div>
      </section>
      <div style="margin:24px 0 0">
        <a href="{{google_wallet_url}}" style="display:inline-block;margin:4px;padding:12px 18px;border-radius:12px;background:#111111;color:#ffffff;text-decoration:none;font-weight:700">Add to Google Wallet</a>
        <a href="{{apple_wallet_url}}" style="display:inline-block;margin:4px;padding:12px 18px;border-radius:12px;background:#111111;color:#ffffff;text-decoration:none;font-weight:700">Add to Apple Wallet</a>
      </div>
      <p style="margin:28px 0 0;color:#725d65;font-size:13px;line-height:1.6">Need help? Open the <a href="{{portal_url}}" style="color:#b44f76;font-weight:700">participant portal</a> or contact event support.</p>
      <p style="margin:28px 0 0;font-size:14px">Best regards,<br /><strong>ACM-VIT Student Chapter</strong></p>
    </main>
  </body>
</html>`;
}

export function defaultParticipantEmailTemplates(): ParticipantEmailTemplate[] {
  return [
    {
      templateKey: "accept",
      subject: "{{team_name}} has been selected for Code2Create",
      text: "Hi {{participant_name}},\n\nYour team has been selected for {{event_name}}. Open the participant portal for the next step: {{portal_url}}",
      html: emailHtml(
        "Your team has been selected.",
        "{{team_name}} has been selected for {{event_name}}. Open the participant portal for the next step.",
      ),
    },
    {
      templateKey: "waitlist",
      subject: "An update on {{team_name}}'s Code2Create application",
      text: "Hi {{participant_name}},\n\n{{team_name}} is on the waitlist for {{event_name}}. We will update you if a place opens: {{portal_url}}",
      html: emailHtml(
        "Your team is on the waitlist.",
        "{{team_name}} is still being considered for {{event_name}}. We will update you if a place opens.",
      ),
    },
    {
      templateKey: "decline",
      subject: "An update on {{team_name}}'s Code2Create application",
      text: "Hi {{participant_name}},\n\nYour team was not selected for {{event_name}}. Thank you for sharing your idea with us. You can view the update here: {{portal_url}}",
      html: emailHtml(
        "An update on your application.",
        "{{team_name}} was not selected for {{event_name}}. Thank you for taking the time to share your idea with us.",
      ),
    },
    {
      templateKey: "offer",
      subject: "RSVP required: confirm {{team_name}} by {{rsvp_deadline}}",
      text: "Hi {{participant_name}},\n\n{{team_name}} has been selected for {{event_name}}, but attendance is not confirmed yet. Your team lead must open {{portal_url}} and choose Confirm attendance for the whole team by {{rsvp_deadline}}. If your team cannot attend, choose Decline. Unanswered reservations expire at the deadline.",
      html: emailHtml(
        "Confirm your team's attendance.",
        "{{team_name}} has been selected, but attendance is not confirmed yet. Your team lead must choose Confirm attendance in the participant portal by {{rsvp_deadline}}. If your team cannot attend, choose Decline. Unanswered reservations expire at the deadline.",
      ),
    },
    {
      templateKey: "offer_confirmed",
      subject: "{{team_name}} is confirmed for Code2Create",
      text: "Hi {{participant_name}},\n\n{{team_name}} is confirmed for {{event_name}}. View the event details and next steps here: {{portal_url}}",
      html: emailHtml(
        "Your team is confirmed.",
        "{{team_name}} has a place at {{event_name}}. Event details and next steps are available in the participant portal.",
      ),
    },
    {
      templateKey: "offer_declined",
      subject: "{{team_name}}'s Code2Create offer was declined",
      text: "Hi {{participant_name}},\n\nThe offer for {{team_name}} was declined. The team's reserved places have been released: {{portal_url}}",
      html: emailHtml(
        "The offer was declined.",
        "{{team_name}} no longer has reserved places for {{event_name}}.",
      ),
    },
    {
      templateKey: "offer_expired",
      subject: "{{team_name}}'s Code2Create offer has expired",
      text: "Hi {{participant_name}},\n\nThe response deadline for {{team_name}} passed, so the team's reserved places were released: {{portal_url}}",
      html: emailHtml(
        "The offer has expired.",
        "The response deadline for {{team_name}} passed, so the team's reserved places were released.",
      ),
    },
    {
      templateKey: "external_event_pass",
      subject: "Your {{event_name}} event pass",
      text: "Hi {{participant_name}},\n\nYour personal external participant pass for {{event_name}} is included in this email. Present its QR before your physical photo ID at first check-in.\n\nWhen: {{event_start}}\nWhere: {{venue_name}}\nPass: {{pass_reference}}\n\nGoogle Wallet: {{google_wallet_url}}\nApple Wallet: {{apple_wallet_url}}\n\nDo not share this pass.",
      html: externalEventPassHtml(),
    },
  ];
}
