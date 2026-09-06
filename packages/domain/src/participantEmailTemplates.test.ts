import assert from "node:assert/strict";
import test from "node:test";

import { defaultParticipantEmailTemplates, rewriteParticipantEmailTemplateAssetReferences } from "./participantEmailTemplates.ts";
import { readFileSync } from "node:fs";

test("external pass emails retain the inline QR without wallet or portal actions", () => {
  const template = defaultParticipantEmailTemplates().find(template => template.templateKey === "external_event_pass");
  assert.ok(template);
  assert.match(template.html, /cid:event-pass-qr\.png/);
  assert.doesNotMatch(template.html + template.text, /wallet|portal/i);
  const html = readFileSync(new URL("../../../templates/participant-emails/external_event_pass.html", import.meta.url), "utf8");
  const messages = readFileSync(new URL("../../../templates/participant-emails/messages.json", import.meta.url), "utf8");
  assert.match(html, /cid:event-pass-qr\.png/);
  assert.doesNotMatch(html + messages, /wallet/i);
  const externalText = messages.split("\n").find(line => line.includes("personal external-participant pass"));
  assert.ok(externalText);
  assert.doesNotMatch(html + externalText, /portal/i);
});

test("rewrites accepted image-reference spacing to the supplied inline source", () => {
  const html = `<img src = "  ./images/banner.png  ">
<img SRC='cid:images/banner.png'>
<div style="background-image: url( './images/banner.png' )"></div>`;

  assert.equal(
    rewriteParticipantEmailTemplateAssetReferences(html, [
      { fileName: "images/banner.png", replacement: "cid:bundle-banner" },
    ]),
    `<img src = "cid:bundle-banner">
<img src='cid:bundle-banner'>
<div style="background-image: url('cid:bundle-banner')"></div>`,
  );
});

test("leaves references that are not bundled unchanged", () => {
  const html = '<a href="https://example.com"><img src="https://example.com/logo.png"></a>';
  assert.equal(
    rewriteParticipantEmailTemplateAssetReferences(html, [
      { fileName: "banner.png", replacement: "cid:bundle-banner" },
    ]),
    html,
  );
});
