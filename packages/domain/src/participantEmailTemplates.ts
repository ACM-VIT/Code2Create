export const participantEmailTemplateKeys = [
  "accept",
  "waitlist",
  "decline",
  "offer",
  "offer_confirmed",
  "offer_declined",
  "offer_expired",
] as const;

export type ParticipantEmailTemplateKey = (typeof participantEmailTemplateKeys)[number];

export const participantEmailTemplateZipMaximumBytes = 3_500_000;

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
      subject: "Confirm {{team_name}}'s place at Code2Create",
      text: "Hi {{participant_name}},\n\n{{team_name}} has received an offer for {{event_name}}. The team lead must respond before the deadline shown here: {{portal_url}}",
      html: emailHtml(
        "Your team's offer is ready.",
        "The team lead for {{team_name}} must respond before the deadline shown in the participant portal.",
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
  ];
}
