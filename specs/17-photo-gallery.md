# Public photo gallery

The participant site's `/photos` route is public, including downloads. It lives outside the authentication and admission gates. Signed-in people with an active event-scoped `photos.upload` grant can upload. Roles and participant acceptance do not grant this permission implicitly. Use the existing operations permissions editor to grant it to photographers.

## Experience

The gallery follows the project showcase's heading, rose palette, and day/night scene. React Photo Album's justified rows preserve complete image frames and pack landscape and portrait photos into the available width. Comfortable and Compact controls change density. Forty-eight photos load initially, with an explicit load-more control. The lightbox loads on demand and supplies keyboard navigation, touch swipe, zoom, fullscreen, and original downloads through Yet Another React Lightbox.

Uploads accept JPEG, PNG, WebP, and AVIF, up to 50 MiB each and 100 megapixels (30,000 pixels maximum per side). Twenty files may be selected per batch. Each has an optional caption, progress indicator, retry state, and publication result. HEIC, RAW, SVG, and video files are not accepted.

## Filters, dates, and selection

Public chips combine capture day (All, 6th, 7th, 8th, Other) and photographer, with counts across the entire event. Photographer chips include only people who have published photos, not the whole upload allowlist. Public metadata includes the uploader's display name and opaque person ID; email and authentication data stay private.

Capture time comes from EXIF `DateTimeOriginal`, respecting `OffsetTimeOriginal` when present and assuming India time when the camera has no offset. Dates are classified in India time against the month/year of the event's configured `startsAt`. Missing/invalid metadata or dates outside those exact three days go to Other. Upload time is never substituted. Ensure `startsAt` is set correctly before publishing photos. Classification is stored at publication.

Indexed server queries support every day/uploader combination, capture time ascending/descending, and photographer A–Z, with pagination. Counts are updated atomically with publication, once per photo. The facet endpoint supports up to 1,000 publishing photographers per event.

Select photos toggles selection mode; each full tile becomes a keyboard-accessible toggle with a visible checkmark. Selection persists across filter changes and loading more photos. Select loaded photos selects the visible loaded results up to the batch limit. The sticky selection bar offers clear, download ZIP, progress, and cancellation. ZIPs contain uncompressed originals with numbered filenames to avoid collisions. Each ZIP is limited to 50 photos / 200 MiB; images are read sequentially and their byte counts checked. The browser retains ZIP chunks in memory until download, so the limit is intentional. Individual full-quality downloads remain available in the lightbox.

GET CORS on R2 is required for ZIP downloads, as the browser fetches the signed URLs. No browser CORS bypass is used.

## Storage and integrity

1. A Convex action reserves an upload after checking verified identity, active person/event access, and `photos.upload`. Reservation is idempotent per person and client operation ID.
2. The browser computes SHA-256 and sends the **original File**, without canvas conversion, to an expiring R2 signed PUT URL. The URL is scoped to one staging object, its content type, and its byte length.
3. Completion checks the grant again, HEADs the upload, conditionally GETs the same ETag, and verifies actual byte count, SHA-256, image signature, dimensions, and declared format.
4. The verified bytes are written unchanged to `photos/<photoId>/<sha256>`. This preserves original resolution, encoding, EXIF, and colour profiles. Uploaders are told that the original and its metadata become public.
5. A transaction rechecks identity, ownership, current permission, and expiry before publishing the metadata and writing one audit event. Concurrent/retried publication is idempotent. Unpublished uploads never appear in public queries or receive download URLs.
6. Public browsing uses Cloudflare Image Transformations on R2 originals, with responsive widths up to 2400 pixels. The lightbox can request the original at high zoom. Browser previews never overwrite the original.
7. The public download action returns a five-minute R2 GET URL with `Content-Disposition: attachment`, preserving the original filename. The browser streams the file directly to disk rather than buffering another JavaScript Blob.

Pending uploads expire after one hour. Retrying the same file creates a fresh reservation and object key; cleanup for the old attempt cannot delete the retry. Expired attempts schedule removal of their upload and any unlisted original after another hour, allowing in-flight actions to finish first. Configure an R2 lifecycle rule to delete `uploads/` objects after one day, including copies from successful uploads; signed upload URLs are valid for at most fifteen minutes. Do not apply this lifecycle to `photos/`.

## Cloudflare setup

Use dedicated buckets such as `code2create-photos-staging` and `code2create-photos-production`, with separate bucket-scoped Object Read & Write API tokens. Do not reuse the mobile updates bucket or private S3 evidence bucket.

Set these **Convex backend** environment variables (none belongs in a Vite environment file):

| Variable | Value |
| --- | --- |
| `PHOTO_R2_ACCOUNT_ID` | Cloudflare account ID |
| `PHOTO_R2_ACCESS_KEY_ID` | Environment's R2 S3 access key |
| `PHOTO_R2_SECRET_ACCESS_KEY` | Matching secret |
| `PHOTO_R2_BUCKET` | Environment's bucket name |
| `PHOTO_PUBLIC_ORIGIN` | HTTPS custom domain, with no path, e.g. `https://media.c2c.sh` |

Attach the custom domain to the bucket, enable Image Transformations for that zone, and permit the media domain as a source. A preview URL has this form:

```text
https://media.c2c.sh/cdn-cgi/image/width=960,fit=scale-down,quality=85,format=auto/photos/<id>/<sha256>
```

Configure caching for `/photos/*` (keys have no filename extension) and respect the origin's immutable Cache-Control header. Block access to `/uploads/*` on the public custom domain using a Cloudflare custom rule; uploads use the separate S3 API endpoint. Disable public `r2.dev` access so the rule cannot be bypassed through that hostname.

Configure bucket CORS for PUT and GET from the exact participant site origins used in that environment. For local development, add the actual local dev origin to the staging bucket only. For example:

```json
[
  {
    "AllowedOrigins": ["https://c2c.sh"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Neither branch merging nor frontend deployment provisions the bucket, configures image transformations, or deploys Convex. Deploy the backend schema/functions before the frontend. The repository's old staging backend workflow is tied to `dev`; choose the correct release procedure explicitly rather than assuming a PR to `staging` deploys the backend.

With the intended `CONVEX_DEPLOYMENT` configured, run `pnpm --filter @code2create/backend codegen` to regenerate the API and environment declarations before releasing. The declarations included with this change were updated locally because this checkout has no configured Convex deployment.

## Verification

- `pnpm --filter @code2create/backend test:photos`
- `pnpm --filter @code2create/backend typecheck`
- `pnpm --filter @code2create/web typecheck`
- `pnpm --filter @code2create/web exec node --experimental-strip-types --test src/lib/photoUpload.test.ts`
- `pnpm --filter @code2create/web build`

Development Screen Gallery entries cover the public album, uploader, and empty state. They use library sample photographs and are excluded from production. For the deployed smoke test, grant one test photographer access, upload a photo with EXIF, compare its original download SHA-256 to the local file, verify a smaller preview response, revoke the grant during another upload, and repeat browsing/downloading in a signed-out window.

Library references: [React Photo Album](https://react-photo-album.com/documentation), [Yet Another React Lightbox](https://yet-another-react-lightbox.com/documentation), [Cloudflare transformations](https://developers.cloudflare.com/images/optimization/transformations/), [R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/).

### Local verification on the contributor account

`wrangler whoami` confirmed the personal account ending `dd5f9b7`. After the owner enabled R2, the remote bucket list succeeded. Created the private `c2c-gallery-dev-test` bucket with the APAC location hint. A 727-byte JPEG with EXIF was uploaded and downloaded with Wrangler's explicit `--remote` flag. SHA-256 matched (`74b44f58ca38f762c121e8a7a8aa5d7e8477672ff5750f7d131e50e467b6acd8`), and the capture date plus timezone survived unchanged. The temporary test object was removed after verification; the private test bucket remains available. No production account or bucket was modified.

This verifies remote R2 object storage via CLI. S3 presigning, CDN transformations, and a deployed Convex flow still require their own configuration and live verification.
