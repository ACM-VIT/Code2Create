import { strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vitest";

import { EmailTemplateBundleError, readEmailTemplateBundle } from "./emailTemplateBundle";

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("email template ZIP packages", () => {
  test("imports one arbitrarily named HTML file with images and ignores macOS metadata", async () => {
    const archive = zipSync({
      "template.html": strToU8(
        '<!doctype html><html><head><meta charset="utf-8"></head><body><img src="banner.png"></body></html>',
      ),
      "banner.png": png,
      "__MACOSX/._template.html": strToU8("metadata"),
      ".DS_Store": strToU8("metadata"),
    });

    await expect(readEmailTemplateBundle(archive)).resolves.toMatchObject({
      htmlFileName: "template.html",
      html: expect.stringContaining('<meta charset="utf-8">'),
      assets: [
        {
          fileName: "banner.png",
          contentType: "image/png",
          disposition: "inline",
        },
      ],
    });
  });

  test("accepts a package folder and keeps asset paths relative to its HTML", async () => {
    const archive = zipSync({
      "welcome/mail.htm": strToU8('<html><body><img src="./images/banner.png"></body></html>'),
      "welcome/images/banner.png": png,
    });

    await expect(readEmailTemplateBundle(archive)).resolves.toMatchObject({
      htmlFileName: "mail.htm",
      assets: [{ fileName: "images/banner.png" }],
    });
  });

  test("rejects ambiguous or spoofed package content", async () => {
    const multipleHtml = zipSync({
      "first.html": strToU8("<html><body>First</body></html>"),
      "second.htm": strToU8("<html><body>Second</body></html>"),
    });
    await expect(readEmailTemplateBundle(multipleHtml)).rejects.toThrow(
      "exactly one HTML file",
    );

    const spoofedImage = zipSync({
      "template.html": strToU8('<html><body><img src="banner.png"></body></html>'),
      "banner.png": strToU8("not a png"),
    });
    await expect(readEmailTemplateBundle(spoofedImage)).rejects.toThrow(
      "does not match its file extension",
    );

    const remoteImage = zipSync({
      "template.html": strToU8(
        '<html><body><img src="https://example.com/banner.png"></body></html>',
      ),
    });
    await expect(readEmailTemplateBundle(remoteImage)).rejects.toThrow(
      "is not included in the ZIP",
    );
  });

  test("bounds decompression before accepting an oversized archive", async () => {
    const archive = zipSync({
      "template.html": strToU8("<html><body>Template</body></html>"),
      "large.png": new Uint8Array(3_450_001),
    });

    await expect(readEmailTemplateBundle(archive)).rejects.toBeInstanceOf(
      EmailTemplateBundleError,
    );
    await expect(readEmailTemplateBundle(archive)).rejects.toThrow(
      "uncompressed template package is too large",
    );
  });
});
