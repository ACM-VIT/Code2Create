import assert from "node:assert/strict";
import test from "node:test";

import { rewriteParticipantEmailTemplateAssetReferences } from "./participantEmailTemplates.ts";

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
