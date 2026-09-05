"use node";

import { Buffer } from "node:buffer";

import { attendanceBadgeReference, parseAttendanceQrPayload } from "@code2create/domain";
import { importPKCS8, jwtVerify, SignJWT } from "jose";
import { PKPass } from "passkit-generator";

const googleWalletAudience = "google";
const googleWalletType = "savetowallet";
const walletDownloadAudience = "code2create-apple-wallet";
const walletDownloadIssuer = "code2create";
const appleIcon =
  "iVBORw0KGgoAAAANSUhEUgAAAB0AAAAdCAMAAABhTZc9AAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAEjUExURQAAALdSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe4zYIXcAAABgdFJOUwAAIZbn/OYovr/DxCn39P799fr79rRNQnXr1WQ7eZNmcjyAeMWRbQuOSxuMsGcBWDBROg/NQ1VgHF8W24MMzJnB3RdaB3BBIJ28Y+MQmgnAfTZQy1KEVOqi37NG0O34+aHSGa4AAAAHdElNRQfqCQQSERyhA28jAAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTA5LTA0VDA1OjE5OjE0KzAwOjAwbE6OvAAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0wOS0wNFQwNToxOToxNCswMDowMB0TNgAAAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMDktMDRUMTg6MTc6MjgrMDA6MDDHw8vzAAABG0lEQVQoz2NggAJGRkYmZhZWNmYmIIsBDQCF2DkSQICTHUMaJMmVAAHcPGjSyJIY0qiSaNLokijSmJJI0tgk4dLYJWHSOCQh0gy4JIHS7IwMTJAQ4uXjT0gQEBRiFeYX4U8QEQCJcTAxMIMlRcXEJSSlpGVk5eQVFJWUZJT5QKLMDCxgWRVVNXUNTS1tHV09fQM9QyNjE5AoGwMriBJRNjVTN7ewTEhQs7K2sbWzt3UACbMysIEoRydnbRdXN3cPTy8tbxsfKV8/f4hesL0iAYHSQb7BIQa6oWHhEZqRUdExEHshbmaNjYuLT4iX5IsX4RcSERAWFIC4Gb9/CYQV3nDGH0cE4pdA2iCQrgikSQLpmUBegOYjNrR8BABCQZuLBON9bwAAAABJRU5ErkJggg==";
const appleIcon2x =
  "iVBORw0KGgoAAAANSUhEUgAAADoAAAA6CAMAAADWZboaAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAHvUExURQAAALdSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe7dSe6qBS3IAAACkdFJOUwAAFmOv4PmuYgFFu/VIAgPl52Rl7e5oZ2bsaUbm+sKGWJjh/M6KXXfH45GFseqaYJzx86aHKTrP9xxrwBVAVQdtUVpyk4tBngs0YY/EEwkeEAUZDv3v3dOoM9ZDV9+bR9G3GgajezIUDy21IrLcJQSiRPhxILjaK7ryTC8SyTn+wScRvkvSF42fOEqDdZAjHdfwbAxS3r1Jl/SJX+KwQtVuenz2zJ7x8QAAAAd0SU1FB+oJBBIRHKEDbyMAAAAldEVYdGRhdGU6Y3JlYXRlADIwMjYtMDktMDRUMDU6MTk6MTQrMDA6MDBsTo68AAAAJXRFWHRkYXRlOm1vZGlmeQAyMDI2LTA5LTA0VDA1OjE5OjE0KzAwOjAwHRM2AAAAACh0RVh0ZGF0ZTp0aW1lc3RhbXAAMjAyNi0wOS0wNFQxODoxNzoyOCswMDowMMfDy/MAAAKcSURBVEjHpdf5XxJBFADwfSwLLLu6ApJoQglBYqlBh6YU2WF0UBJmh1naoZiSqZXQpZiZHZraaXQ3f2hDH2SXZGFh5qd5fN4X+Mz5hqJyNQBQ0WpGo2G0OhUOKKUN57J6jkf/Gs+VlSvGOFHQVaBMMxgFhTYlTZVI0syblNmNUrHNIbGtEgrTnDL9uyVJBRZLS05Z0OaRBWxKViPZZq6RtQUkQpVytqCUtQqkjFUkc1qFcuM4Q95ZyWFBKk0KZbYtTkptsTK9jyDfii84ViXIdQssXbTElmYx3VxbvESoVg+UihNjq22Lcaulzo67jm1OnWt7vbthx87GJmPzLo93d5VrDyPmciqK5sXQvRdS472vBbU697O429bugwMH8TnsP9Tmx3GHOZPL05Ra+i8OHzl6rLMcmh3HAyCcOFl26nQQ/GfOduHvC53zAYRtYrKaskto93lDz4WLKrh0uRfgitvq5W1BAFPf1QDAtf6B63DjppjMUBoJtd8aHApHBBi+PQKB0dQnmHbVo+gdGLuLPOMQahKTJ6TU6wKhd5KOwPDoPQjfT9ORB6hvCiIxFH8IoToplQxavw8e2RH3GKaePAWwmNG0YyYIiZ4UnX2G4nNZlKG0YvB8HuZfLLwESESdAvhfvX6zyA3hQKRjEqqldOLk8CY8IezgErxdXll9l5qn9wOzsBRFHxIQ/ojin4D9nEle02UtCcOXuc6alobk5FfEfzOOf+9Y+PEz+asRVf9Ori6j1sWksT2TG1NRoJcuxD8r3evdac+KVX4hVujJln/pm45gq5McMATHGslhSnKEk1wcRNcVySVJcjWTFAQkZQhJ8UNScpEUeiTlJUlRS1JKExTwJM+G/x4ra7EiHitU+omkZTQT+Z5IfwGnYmwPcliMGAAAAABJRU5ErkJggg==";

export class EventPassWalletConfigurationError extends Error {
  override name = "EventPassWalletConfigurationError";
}

export type ExternalEventPassDetails = {
  passId: string;
  payload: string;
  eventName: string;
  eventStartsAt: number;
  eventEndsAt: number;
  eventTimezone: string;
  venueName: string;
  participantName: string;
  teamName: string;
};

function requiredEnvironmentValue(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new EventPassWalletConfigurationError(`${name} is not configured.`);
  return value;
}

function signingSecret() {
  const secret = requiredEnvironmentValue("WALLET_DOWNLOAD_SIGNING_SECRET");
  if (secret.length < 32) {
    throw new EventPassWalletConfigurationError(
      "WALLET_DOWNLOAD_SIGNING_SECRET must contain at least 32 characters.",
    );
  }
  return new TextEncoder().encode(secret);
}

function normalizedIdentifier(value: string) {
  const normalized = value.replace(/[^A-Za-z0-9._-]/gu, "_");
  if (!normalized) throw new Error("A wallet object identifier is empty after normalization.");
  return normalized;
}

function parsedBearer(payload: string) {
  const parsed = parseAttendanceQrPayload(payload);
  if (!parsed || parsed.kind !== "external_pass") {
    throw new Error("The external event-pass payload is invalid.");
  }
  return parsed.bearer;
}

export function externalEventPassReference(payload: string) {
  return attendanceBadgeReference(parsedBearer(payload));
}

export function formattedEventStart(details: ExternalEventPassDetails) {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: details.eventTimezone,
  }).format(new Date(details.eventStartsAt));
}

export async function createAppleWalletDownloadToken(details: ExternalEventPassDetails) {
  const expiresAt = Math.floor((details.eventEndsAt + 30 * 24 * 60 * 60 * 1_000) / 1_000);
  return new SignJWT({ passId: details.passId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(walletDownloadIssuer)
    .setAudience(walletDownloadAudience)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(signingSecret());
}

export async function verifyAppleWalletDownloadToken(token: string) {
  const verified = await jwtVerify(token, signingSecret(), {
    issuer: walletDownloadIssuer,
    audience: walletDownloadAudience,
  });
  const passId = verified.payload.passId;
  if (typeof passId !== "string" || !/^[A-Za-z0-9_-]+$/u.test(passId)) {
    throw new Error("The wallet download token has no valid pass identifier.");
  }
  return passId;
}

export async function createGoogleWalletSaveUrl(details: ExternalEventPassDetails) {
  const issuerId = requiredEnvironmentValue("GOOGLE_WALLET_ISSUER_ID");
  const serviceAccountEmail = requiredEnvironmentValue("GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL");
  const privateKeyPem = requiredEnvironmentValue("GOOGLE_WALLET_PRIVATE_KEY").replaceAll(
    "\\n",
    "\n",
  );
  const classId = `${issuerId}.code2create_${normalizedIdentifier(details.eventName)}`;
  const objectId = `${issuerId}.${normalizedIdentifier(details.passId)}`;
  const signingKey = await importPKCS8(privateKeyPem, "RS256");
  const token = await new SignJWT({
    origins: [],
    typ: googleWalletType,
    payload: {
      genericClasses: [{ id: classId }],
      genericObjects: [
        {
          id: objectId,
          classId,
          state: "ACTIVE",
          hexBackgroundColor: "#B7527B",
          cardTitle: { defaultValue: { language: "en", value: details.eventName } },
          header: { defaultValue: { language: "en", value: details.participantName } },
          subheader: { defaultValue: { language: "en", value: details.teamName } },
          barcode: {
            type: "QR_CODE",
            value: details.payload,
            alternateText: externalEventPassReference(details.payload),
          },
          textModulesData: [
            { id: "venue", header: "VENUE", body: details.venueName },
            { id: "starts", header: "STARTS", body: formattedEventStart(details) },
            { id: "identity", header: "CHECK-IN", body: "Present this pass before your photo ID." },
          ],
        },
      ],
    },
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(serviceAccountEmail)
    .setAudience(googleWalletAudience)
    .setIssuedAt()
    .sign(signingKey);
  return `https://pay.google.com/gp/v/save/${token}`;
}

export function createAppleWalletPass(details: ExternalEventPassDetails) {
  const passTypeIdentifier = requiredEnvironmentValue("APPLE_WALLET_PASS_TYPE_IDENTIFIER");
  const teamIdentifier = requiredEnvironmentValue("APPLE_WALLET_TEAM_IDENTIFIER");
  const pass = new PKPass(
    {
      "icon.png": Buffer.from(appleIcon, "base64"),
      "icon@2x.png": Buffer.from(appleIcon2x, "base64"),
    },
    {
      wwdr: Buffer.from(requiredEnvironmentValue("APPLE_WALLET_WWDR_CERTIFICATE_BASE64"), "base64"),
      signerCert: Buffer.from(
        requiredEnvironmentValue("APPLE_WALLET_SIGNER_CERTIFICATE_BASE64"),
        "base64",
      ),
      signerKey: Buffer.from(
        requiredEnvironmentValue("APPLE_WALLET_SIGNER_KEY_BASE64"),
        "base64",
      ),
      ...(process.env.APPLE_WALLET_SIGNER_KEY_PASSPHRASE?.trim()
        ? { signerKeyPassphrase: process.env.APPLE_WALLET_SIGNER_KEY_PASSPHRASE.trim() }
        : {}),
    },
    {
      formatVersion: 1,
      serialNumber: details.passId,
      description: `${details.eventName} external participant pass`,
      organizationName: "ACM-VIT",
      passTypeIdentifier,
      teamIdentifier,
      logoText: details.eventName,
      backgroundColor: "rgb(183, 82, 123)",
      foregroundColor: "rgb(255, 255, 255)",
      labelColor: "rgb(255, 229, 239)",
      groupingIdentifier: normalizedIdentifier(details.eventName),
    },
  );
  pass.type = "eventTicket";
  pass.setBarcodes({
    format: "PKBarcodeFormatQR",
    message: details.payload,
    messageEncoding: "iso-8859-1",
    altText: externalEventPassReference(details.payload),
  });
  pass.setRelevantDates([{ date: new Date(details.eventStartsAt) }]);
  pass.setExpirationDate(new Date(details.eventEndsAt));
  pass.primaryFields.push({ key: "event", label: "EVENT", value: details.eventName });
  pass.secondaryFields.push(
    {
      key: "participant",
      label: "PARTICIPANT",
      value: details.participantName,
    },
    { key: "team", label: "TEAM", value: details.teamName },
  );
  pass.auxiliaryFields.push(
    { key: "venue", label: "VENUE", value: details.venueName },
    {
      key: "starts",
      label: "STARTS",
      value: new Date(details.eventStartsAt),
      dateStyle: "PKDateStyleMedium",
      timeStyle: "PKDateStyleShort",
    },
  );
  pass.backFields.push(
    {
      key: "checkin",
      label: "Check-in",
      value: "Present this pass first, then show your physical photo ID to the event staff.",
    },
    {
      key: "sharing",
      label: "Personal pass",
      value: "This pass identifies one participant. Do not share it.",
    },
  );
  return pass.getAsBuffer();
}
