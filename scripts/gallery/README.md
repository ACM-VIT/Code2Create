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
venv/bin/pip install boto3 requests gdown beautifulsoup4 pillow pillow-heif ImageHash
mkdir -p /opt/gallery-transfer/tmp
TMPDIR=/opt/gallery-transfer/tmp venv/bin/python import.py --drive "$DRIVE_FOLDER" --sharepoint "$SHAREPOINT_FOLDER"
```

Copy both `import.py` and `dedup.py` to the transfer host. The script recursively
enumerates both folders, follows SharePoint pagination, imports supported photos,
verifies uploaded sizes and SHA-256 metadata, and creates orientation-corrected
WebP previews. Originals retain their original bytes and download filename.
Conditional writes prevent existing objects from being overwritten.
The grid uses 800px previews, while the viewer uses 1600px previews.

Each completed file gets an entry under `gallery/entries/`. A rerun skips those
entries and retries incomplete imports. Before uploading, it indexes all existing
original hashes and photo content across both sources. Exact duplicates, filename
collisions, and perceptually similar images (64-bit pHash distance at most 10) are
skipped conservatively. This can skip distinct burst shots; uncertain files require
manual review instead of automatic upload. Reservations serialize concurrent
workers, and an S3 compare-and-swap lock admits only one importer at a time.
Matching workers wait for a pending transfer to finish. Its identity becomes
committed only after the original, previews, and entry are stored; any failure
releases the reservation so a waiting healthy copy can proceed. Unrelated
photos can still upload concurrently, and failed retries leave indexes for
previously stored originals intact.

`inventory-*.json` and `report-*.json` stay
on the transfer machine; inspect the report before terminating it. A nonzero
exit means some files remain untransferred. Unsupported files are skipped;
previously stored non-photo originals remain untouched.
Use an EBS-backed temporary directory, not Amazon Linux's small `/tmp` RAM disk;
allow enough disk space for four concurrent original photos.

Rebuild the catalog from all completed imports without fetching source files:

```sh
venv/bin/python import.py --catalog-only
```

This uses authenticated, paginated S3 listing and publishes `gallery/manifest.json`.
Every rebuild removes repeated keys and original hashes. Matching decoded thumbnail
pixels trigger verification of the original SHA-256 and full-resolution decoded
pixels, so metadata differences do not conceal duplicate photos. Similarity alone
never removes an existing photograph. Original objects and import entries are
retained; rebuilding again cannot reintroduce confirmed repeats.

Use `--audit-only` for a read-only S3 audit. Both modes write
`catalog-dedup-report.json` on the transfer host, and publication saves a local
`manifest-before-*.json` backup. Missing hashes, unreadable images, or a concurrent
catalog change stop publication. Inspect and retain these reports before cleanup.

The lock at `gallery/import-lock.json` fails closed after an interrupted process.
Only reset its `active` field after confirming that the previous transfer host has
terminated; use `If-Match` with its current ETag. Do not run legacy or standalone
import scripts that bypass `dedup.py`.

Visitors only need `s3:GetObject`. The bucket policy allows public reads and
denies non-TLS access; it does not grant public listing, uploads, or deletion.
Public ACLs are blocked and ignored. CORS permits GET/HEAD so the Cloudflare
landing page can fetch the catalog. Originals send `Content-Disposition:
attachment`; individual downloads use the browser directly.

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
