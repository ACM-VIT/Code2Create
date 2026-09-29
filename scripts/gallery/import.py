"""Run on a temporary EC2 host with a bucket-scoped role, never on a capped client.

pip install boto3 requests gdown beautifulsoup4 pillow pillow-heif ImageHash
python import.py --drive URL --sharepoint URL
python import.py --catalog-only
"""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import mimetypes
from pathlib import Path
import re
import tempfile
import time
from urllib.parse import parse_qs, quote, urlparse

import boto3
from botocore.exceptions import ClientError
from bs4 import BeautifulSoup
import gdown
from PIL import Image, ImageOps, UnidentifiedImageError
import pillow_heif
import requests

from dedup import Gallery, fingerprint, import_lock

BUCKET = "code2create-photos-963957629631"
S3 = boto3.client("s3", region_name="ap-south-1")
pillow_heif.register_heif_opener()


def emit(**values):
    print(json.dumps(values), flush=True)


def exists(key):
    try:
        return S3.head_object(Bucket=BUCKET, Key=key)
    except ClientError as error:
        if error.response["Error"]["Code"] in ("404", "NoSuchKey"):
            return None
        raise


class SharePoint:
    def __init__(self, url):
        self.session = requests.Session()
        response = self.session.get(url, timeout=60)
        response.raise_for_status()
        match = re.search(r"_spPageContextInfo\s*=\s*", response.text)
        if match is None:
            raise RuntimeError("SharePoint folder is not anonymously accessible")
        self.context = json.JSONDecoder().raw_decode(response.text[match.end():])[0]
        self.root = parse_qs(urlparse(response.url).query)["id"][0]
        self.site = self.context["webAbsoluteUrl"]

    def enumerate(self):
        pending = [self.root]
        files = []
        seen = set()
        while pending:
            folder = pending.pop()
            if folder in seen:
                continue
            seen.add(folder)
            paging = None
            while True:
                parameters = {
                    "RenderOptions": 2, "FolderServerRelativeUrl": folder,
                    "ViewXml": "<View><ViewFields><FieldRef Name='FileLeafRef'/><FieldRef Name='FileRef'/><FieldRef Name='FSObjType'/><FieldRef Name='File_x0020_Size'/></ViewFields><RowLimit Paged='TRUE'>200</RowLimit></View>",
                }
                if paging:
                    parameters["Paging"] = paging
                endpoint = self.site + "/_api/web/GetList(@listUrl)/RenderListDataAsStream"
                response = self.session.post(endpoint,
                    params={"@listUrl": "'" + self.context["listUrl"] + "'"},
                    json={"parameters": parameters},
                    headers={"Accept": "application/json;odata=nometadata",
                             "X-RequestDigest": self.context.get("formDigestValue", "")}, timeout=120)
                response.raise_for_status()
                data = response.json()
                for row in data.get("Row", []):
                    path = row["FileRef"]
                    if not path.startswith(self.root + "/"):
                        raise RuntimeError("SharePoint returned a path outside the shared folder")
                    if row["FSObjType"] == "1":
                        pending.append(path)
                    else:
                        files.append({"source": "sharepoint", "id": path,
                                      "path": path[len(self.root) + 1:],
                                      "size": int(row.get("File_x0020_Size") or 0)})
                paging = data.get("NextHref", "").lstrip("?")
                if not paging:
                    break
        return files

    def download(self, item, destination):
        path = item["id"].replace("'", "''")
        endpoint = self.site + "/_api/web/GetFileByServerRelativePath(decodedUrl=@path)/$value"
        with self.session.get(endpoint, params={"@path": "'" + path + "'"}, stream=True, timeout=(30, 180)) as response:
            response.raise_for_status()
            with destination.open("wb") as output:
                for chunk in response.iter_content(1024 * 1024):
                    output.write(chunk)
        if item["size"] and destination.stat().st_size != item["size"]:
            raise RuntimeError("SharePoint original size mismatch")


def download_drive(item, destination):
    # Follow Drive's actual confirmation form. Reconstructing an export URL
    # loses the confirmation parameters on some publicly shared videos.
    with requests.Session() as session:
        response = session.get("https://drive.google.com/uc", params={"id": item["id"]},
                               stream=True, timeout=(30, 180))
        response.raise_for_status()
        if "text/html" in response.headers.get("Content-Type", ""):
            form = BeautifulSoup(response.text, "html.parser").find("form", id="download-form")
            response.close()
            if form is None or form.get("action") != "https://drive.usercontent.google.com/download":
                raise RuntimeError("Drive did not provide a public download or confirmation form")
            parameters = {field["name"]: field.get("value", "")
                          for field in form.select("input[type=hidden][name]")}
            if parameters.get("id") != item["id"]:
                raise RuntimeError("Drive confirmation refers to a different file")
            response = session.get(form["action"], params=parameters, stream=True, timeout=(30, 180))
        with response:
            response.raise_for_status()
            if "text/html" in response.headers.get("Content-Type", ""):
                raise RuntimeError("Drive returned a page instead of the original file")
            with destination.open("wb") as output:
                for chunk in response.iter_content(1024 * 1024):
                    output.write(chunk)
            expected = response.headers.get("Content-Length")
            if expected and destination.stat().st_size != int(expected):
                raise RuntimeError("Drive original size mismatch")


def transfer(item, sharepoint, gallery):
    identity = hashlib.sha256((item["source"] + ":" + item["id"]).encode()).hexdigest()
    entry_key = f"gallery/entries/{identity}.json"
    if exists(entry_key):
        return "skipped", 0
    # Include stable source ID to preserve distinct files with identical names.
    key = f"originals/{item['source']}/{identity[:16]}/{item['path']}"
    name = Path(item["path"]).name
    if Path(name).suffix.lower() not in {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".tif", ".tiff", ".bmp", ".avif"}:
        return "skipped", 0
    with tempfile.TemporaryDirectory(prefix="c2c-photo-") as directory:
        original = Path(directory) / "original"
        head = exists(key)
        if head:
            S3.download_file(BUCKET, key, str(original))
        elif item["source"] == "drive":
            download_drive(item, original)
        else:
            sharepoint.download(item, original)
        size = original.stat().st_size
        with original.open("rb") as contents:
            digest = hashlib.file_digest(contents, "sha256").hexdigest()
        try:
            with Image.open(original) as opened:
                preview = ImageOps.exif_transpose(opened).convert("RGB")
                icc = opened.info.get("icc_profile", b"")
                preview.thumbnail((1600, 1600))
                preview_file = Path(directory) / "preview.webp"
                preview.save(preview_file, "WEBP", quality=82, icc_profile=icc)
                preview_bytes = preview_file.read_bytes()
                width, height = preview.size
                preview.thumbnail((800, 800))
                preview.save(preview_file, "WEBP", quality=78, icc_profile=icc)
                thumbnail = preview_file.read_bytes()
        except UnidentifiedImageError:
            return "skipped", 0
        pixels, perceptual = fingerprint(thumbnail)
        with gallery.reserve(key, name, digest, pixels, perceptual) as reserved:
            if not reserved:
                emit(event="duplicate_or_uncertain_skipped", source=item["source"], path=item["path"])
                return "skipped", 0
            if not head:
                with original.open("rb") as contents:
                    S3.put_object(Bucket=BUCKET, Key=key, Body=contents, IfNoneMatch="*",
                        ContentType=mimetypes.guess_type(name)[0] or "application/octet-stream",
                        ContentDisposition="attachment; filename*=UTF-8''" + quote(name, safe=""),
                        CacheControl="public, max-age=31536000, immutable",
                        Metadata={"sha256": digest}, ChecksumAlgorithm="SHA256")
            verified = S3.head_object(Bucket=BUCKET, Key=key)
            if verified["ContentLength"] != size or verified.get("Metadata", {}).get("sha256") != digest:
                raise RuntimeError("S3 original verification failed")
            preview_key, thumbnail_key = f"previews/{identity}.webp", f"previews/{identity}-800.webp"
            for object_key, body in ((preview_key, preview_bytes), (thumbnail_key, thumbnail)):
                if not exists(object_key):
                    S3.put_object(Bucket=BUCKET, Key=object_key, Body=body, IfNoneMatch="*",
                        ContentType="image/webp", CacheControl="public, max-age=31536000, immutable")
                elif S3.get_object(Bucket=BUCKET, Key=object_key)["Body"].read() != body:
                    raise RuntimeError("Existing preview differs; manual review required")
            entry = {"key": key, "preview": preview_key, "thumbnail": thumbnail_key,
                     "name": name, "width": width, "height": height}
            S3.put_object(Bucket=BUCKET, Key=entry_key, Body=json.dumps(entry).encode(),
                          ContentType="application/json", IfNoneMatch="*")
            gallery.add(entry)
            return "uploaded", size


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--drive")
    parser.add_argument("--sharepoint")
    parser.add_argument("--catalog-only", action="store_true")
    parser.add_argument("--audit-only", action="store_true")
    parser.add_argument("--inventory-only", action="store_true")
    args = parser.parse_args()
    if args.audit_only:
        emit(event="catalog_audited", photos=Gallery(S3, BUCKET).publish(dry_run=True))
    elif args.inventory_only:
        run(args, None)
    else:
        with import_lock(S3, BUCKET):
            gallery = Gallery(S3, BUCKET)
            if args.catalog_only:
                emit(event="catalog_published", photos=gallery.publish())
            else:
                run(args, gallery)


def run(args, gallery):
    files = []
    if args.drive:
        drive_files = gdown.download_folder(url=args.drive, quiet=True, skip_download=True, use_cookies=False)
        files.extend({"source": "drive", "id": file.id, "path": file.path} for file in drive_files)
    sharepoint = SharePoint(args.sharepoint) if args.sharepoint else None
    if sharepoint:
        files.extend(sharepoint.enumerate())
    if not files:
        raise RuntimeError("No source files found")
    label = "both" if args.drive and args.sharepoint else "drive" if args.drive else "sharepoint"
    Path(f"inventory-{label}.json").write_text(json.dumps(files))
    for source in ("drive", "sharepoint"):
        selected = [item for item in files if item["source"] == source]
        emit(event="inventory", source=source, files=len(selected), known_bytes=sum(item.get("size", 0) for item in selected))
    if args.inventory_only:
        return
    failures = []
    counts = {"uploaded": 0, "skipped": 0}
    total_bytes = 0
    def run(item):
        for attempt in range(5):
            try:
                return transfer(item, sharepoint, gallery)
            except Exception:
                if attempt == 4:
                    raise
                time.sleep(10 * 2 ** attempt)
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(run, item): item for item in files}
        for number, future in enumerate(as_completed(futures), 1):
            item = futures[future]
            try:
                status, size = future.result()
                counts[status] += 1
                total_bytes += size
            except Exception as error:
                failures.append({"source": item["source"], "path": item["path"], "error": type(error).__name__})
                emit(event="file_failed", **failures[-1])
            if number % 40 == 0:
                emit(event="progress", completed=number, total=len(files), bytes=total_bytes, **counts)
                gallery.publish()
    gallery.publish()
    report = {"files": len(files), "bytes": total_bytes, **counts, "failures": failures}
    Path(f"report-{label}.json").write_text(json.dumps(report))
    emit(event="complete", **report)
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
