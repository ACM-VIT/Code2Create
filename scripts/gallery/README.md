# Photo import

The landing site's `/photos` route reads the public catalog at
`https://code2create-photos-963957629631.s3.ap-south-1.amazonaws.com/gallery/manifest.json`.
There is no gallery backend, login, upload UI, or scheduled compute.

Run `import.py` on a temporary EC2 machine in `ap-south-1`, using Python 3.12
and an instance role scoped to this bucket. Do not run the bulk import on a
bandwidth-capped workstation. Source files travel directly from Drive and
SharePoint to EC2 and S3. Supply the shared folder URLs as arguments:

```sh
python3.12 -m venv venv
venv/bin/pip install boto3 requests gdown beautifulsoup4 pillow pillow-heif
mkdir -p /opt/gallery-transfer/tmp
TMPDIR=/opt/gallery-transfer/tmp venv/bin/python import.py --drive "$DRIVE_FOLDER" --sharepoint "$SHAREPOINT_FOLDER"
```

The script recursively enumerates both folders, follows SharePoint pagination,
preserves all original files (including videos), verifies uploaded sizes and
SHA-256 metadata, and creates orientation-corrected WebP previews for supported
photos. Originals retain their original bytes and download filename. A source
ID in each object key prevents same-name files from overwriting each other.
The grid uses 800px previews, while the viewer uses 1600px previews.

Each completed file gets an entry under `gallery/entries/`. A rerun skips those
entries and retries incomplete imports. `inventory-*.json` and `report-*.json` stay
on the transfer machine; inspect the report before terminating it. A nonzero
exit means some files remain untransferred. Missing or unsupported images are
preserved as originals but excluded from the photo catalog.
Camera `.thm` sidecar thumbnails are also preserved but not shown in the gallery.
Use an EBS-backed temporary directory, not Amazon Linux's small `/tmp` RAM disk;
some source videos exceed 4 GB. Allow enough disk space for four concurrent files.

Rebuild the catalog from all completed imports without fetching source files:

```sh
venv/bin/python import.py --catalog-only
```

This uses authenticated, paginated S3 listing and publishes `gallery/manifest.json`.
Visitors only need `s3:GetObject`. The bucket policy allows public reads and
denies non-TLS access; it does not grant public listing, uploads, or deletion.
Public ACLs are blocked and ignored. CORS permits GET/HEAD so the Cloudflare
landing page can fetch the catalog. Originals send `Content-Disposition:
attachment`; individual downloads use the browser directly. The floating selection
bar creates a ZIP of unchanged originals using lazy-loaded `client-zip`. Browsers
with `showSaveFilePicker` stream the archive to disk. Other browsers buffer up to
250 MiB, then ask visitors to select fewer photos rather than risk exhausting
memory. Downloads can be cancelled or retried without losing selections.

The temporary instance needs bucket-scoped `ListBucket`, `GetBucketLocation`,
`GetObject`, `PutObject`, and `AbortMultipartUpload`, plus SSM management access.
Use no inbound security-group rules, require IMDSv2, encrypt the temporary disk,
and set both a shutdown deadline and instance-initiated shutdown to terminate.
After verifying the import, terminate the instance and remove its temporary IAM
role, instance profile, and security group. Keep the bucket.

Frontend verification:

```sh
pnpm --filter @code2create/landing typecheck
pnpm --filter @code2create/landing lint
pnpm --filter @code2create/landing build
pnpm --filter @code2create/landing test
venv/bin/python -m unittest discover -s scripts/gallery -p 'test_*.py'
```
