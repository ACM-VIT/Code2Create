import {
  configuredParticipantEmailProvider,
  emailServiceProviderReady,
  sendEmailThroughService,
} from "./emailServiceSending";
import { vitStudentEmailDomain } from "./vitStudentIdentity";

function authenticationEmailProvider() {
  return configuredParticipantEmailProvider(process.env.AUTHENTICATION_EMAIL_PROVIDER);
}

export async function authenticationEmailConfigured(): Promise<boolean> {
  const provider = authenticationEmailProvider();
  return provider !== null && await emailServiceProviderReady(provider);
}

function htmlEscaped(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** The portal origin that hosts the email's images, when it is configured and well-formed. */
function participantSiteOrigin() {
  const value = process.env.PARTICIPANT_SITE_URL?.trim();
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function authenticationOtpEmail(otp: string, assetOrigin: string | null = null) {
  if (!/^\d{6}$/u.test(otp)) throw new Error("Authentication OTP must contain six digits.");
  const asset = (file: string) => (assetOrigin ? `${assetOrigin}/assets/email/${file}` : null);
  const c2cMark = asset("c2c-mark.png");
  const acmMark = asset("acm-mark.png");
  const fontStack = "Poppins,'Segoe UI',Helvetica,Arial,sans-serif";
  return {
    subject: "Your Code2Create sign-in code",
    text: [
      `Your Code2Create sign-in code is ${otp}.`,
      "",
      "It expires in 10 minutes and can be used only once. Do not share this code.",
      "",
      "If you did not request this code, you can ignore this email.",
      "",
      "ACM-VIT · Vellore Institute of Technology · https://acmvit.in",
    ].join("\n"),
    // The portal's daybreak palette, inline for every client; the <style>
    // block hands clients that honour prefers-color-scheme the night palette.
    // Images are hosted at the portal origin because inbox clients block
    // inline and SVG images; without an origin the lockup is text only.
    html: [
      "<style>",
      "@media (prefers-color-scheme: dark) {",
      ".c2c-bg { background: #0c0004 !important; }",
      ".c2c-fg { color: #f8f8f8 !important; }",
      ".c2c-muted { color: #b9a6ae !important; }",
      ".c2c-faint { color: #8a7680 !important; }",
      ".c2c-rose { color: #feb4cb !important; }",
      ".c2c-rule { border-top-color: #3a1a28 !important; }",
      ".c2c-code { background: #1a0810 !important; border-color: #d884a2 !important; color: #f8f8f8 !important; }",
      "}",
      "</style>",
      `<div class="c2c-bg" style="background:#fff8f2;color:#33101f;font-family:${fontStack};padding:36px 24px">`,
      '<div style="margin:0 auto;max-width:480px">',
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px"><tr>',
      c2cMark
        ? `<td style="padding:0 12px 0 0;vertical-align:middle"><img src="${c2cMark}" width="40" height="44" alt="" style="display:block;border:0;width:40px;height:44px"></td>`
        : "",
      `<td style="vertical-align:middle;font-family:${fontStack}"><span class="c2c-fg" style="color:#33101f;font-size:17px;font-weight:600;letter-spacing:-.01em">Code2Create</span><br><span class="c2c-rose" style="color:#96375c;font-size:11px;font-weight:700;letter-spacing:.12em">by ACM-VIT</span></td>`,
      "</tr></table>",
      '<h1 class="c2c-fg" style="color:#33101f;font-size:26px;font-weight:300;letter-spacing:-.01em;line-height:1.2;margin:0 0 20px">Your sign-in code</h1>',
      `<p class="c2c-code" style="background:#fffdfb;border:1.5px solid #b7527b;border-radius:12px;color:#33101f;display:inline-block;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:30px;font-weight:600;letter-spacing:.3em;line-height:1;margin:0 0 22px;padding:16px 18px 16px 24px">${htmlEscaped(otp)}</p>`,
      '<p class="c2c-muted" style="color:#5f4350;font-size:14px;line-height:1.6;margin:0">It expires in 10 minutes and can be used only once. Do not share it.</p>',
      '<p class="c2c-faint" style="color:#8f7480;font-size:12px;line-height:1.6;margin:22px 0 0">If you did not request this code, you can ignore this email.</p>',
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="c2c-rule" style="margin:30px 0 0;border-top:1px solid #ead2dc;width:100%"><tr>',
      acmMark
        ? `<td style="padding:18px 10px 0 0;vertical-align:middle;width:28px"><img src="${acmMark}" width="28" alt="ACM-VIT" style="display:block;border:0;width:28px"></td>`
        : "",
      `<td class="c2c-faint" style="padding:18px 0 0;vertical-align:middle;color:#8f7480;font-family:${fontStack};font-size:12px;line-height:1.5">ACM-VIT · Vellore Institute of Technology<br><a href="https://acmvit.in" class="c2c-rose" style="color:#96375c;text-decoration:none">acmvit.in</a></td>`,
      "</tr></table>",
      "</div>",
      "</div>",
    ].join(""),
  };
}

export async function sendAuthenticationOtp(input: {
  email: string;
  otp: string;
  type: "sign-in" | "email-verification" | "forget-password" | "change-email";
}) {
  if (input.type !== "sign-in") {
    throw new Error("Only email sign-in codes are enabled.");
  }
  if (input.email.trim().toLowerCase().endsWith(`@${vitStudentEmailDomain}`)) {
    throw new Error("VIT email addresses must continue with Google Workspace.");
  }
  const provider = authenticationEmailProvider();
  if (!provider || !(await emailServiceProviderReady(provider))) {
    throw new Error("Authentication email is not configured.");
  }
  const message = authenticationOtpEmail(input.otp, participantSiteOrigin());
  const result = await sendEmailThroughService({
    provider,
    requestId: crypto.randomUUID(),
    to: input.email,
    ...message,
    headers: [{ name: "X-Code2Create-Message-Type", value: "authentication-otp" }],
    attachments: [],
  });
  if (result.status === "accepted" && result.initialOutcome !== "permanent_bounce") {
    return;
  }
  if (result.status === "ambiguous") return;
  throw new Error("Authentication email was rejected by the delivery provider.");
}
