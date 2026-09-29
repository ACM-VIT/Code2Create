"""Content checks shared by imports and catalog rebuilds. Fail closed on unreadable data."""

from concurrent.futures import ThreadPoolExecutor
from collections import Counter
from contextlib import contextmanager
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import threading
import uuid

from botocore.exceptions import ClientError
from PIL import Image, ImageOps
import imagehash


def read_json(s3, bucket, key):
    try:
        response = s3.get_object(Bucket=bucket, Key=key)
    except ClientError as error:
        if error.response["Error"]["Code"] in ("NoSuchKey", "404"):
            return None, None
        raise
    return json.loads(response["Body"].read()), response["ETag"]


@contextmanager
def import_lock(s3, bucket):
    """Serialize whole runs; an interrupted owner requires explicit operator recovery."""
    key = "gallery/import-lock.json"
    state, etag = read_json(s3, bucket, key)
    if state and state["active"]:
        raise RuntimeError("Another import owns the bucket lock; inspect it before recovery")
    owner = str(uuid.uuid4())
    response = s3.put_object(
        Bucket=bucket, Key=key, ContentType="application/json",
        Body=json.dumps({"active": True, "owner": owner}).encode(),
        **({"IfMatch": etag} if etag else {"IfNoneMatch": "*"}),
    )
    try:
        yield
    finally:
        s3.put_object(
            Bucket=bucket, Key=key, ContentType="application/json",
            Body=json.dumps({"active": False, "owner": owner}).encode(),
            IfMatch=response["ETag"],
        )


def fingerprint(data):
    with Image.open(io.BytesIO(data)) as opened:
        image = ImageOps.exif_transpose(opened).convert("RGB")
        pixels = hashlib.sha256(str(image.size).encode() + image.tobytes()).hexdigest()
        return pixels, int(str(imagehash.phash(image)), 16)


def unique_photos(photos, identities):
    """Keep the first representative, including when duplicate groups overlap."""
    parents = list(range(len(photos)))
    def root(index):
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index
    seen = {}
    for index, photo in enumerate(photos):
        key = photo["key"]
        digest, pixels, _ = identities[key]
        if not digest or not pixels:
            raise RuntimeError("Photo is missing a content identity")
        for token in (("key", key), ("sha", digest), ("pixels", pixels)):
            if token in seen:
                a, b = root(index), root(seen[token])
                parents[max(a, b)] = min(a, b)
            else:
                seen[token] = index
    return [photo for index, photo in enumerate(photos) if root(index) == index]


class Gallery:
    def __init__(self, s3, bucket):
        self.s3, self.bucket = s3, bucket
        self.mutex = threading.Condition()
        self.pending = {}
        self.manifest, self.etag = read_json(s3, bucket, "gallery/manifest.json")
        self.manifest = self.manifest or {"photos": []}
        objects = [obj["Key"] for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket)
                   for obj in page.get("Contents", [])]
        self.hashes, self.names, self.identities = {}, {}, {}

        def head(key):
            digest = s3.head_object(Bucket=bucket, Key=key).get("Metadata", {}).get("sha256")
            if not digest:
                raise RuntimeError("Existing original lacks SHA-256; audit it before importing")
            return key, digest

        with ThreadPoolExecutor(max_workers=8) as pool:
            self.originals = dict(pool.map(head, (key for key in objects if key.startswith("originals/"))))
        for key, digest in self.originals.items():
            self.hashes.setdefault(digest, set()).add(key)
            self.names.setdefault(PurePosixPath(key).name.casefold(), set()).add(key)

        def entry(key):
            photo, _ = read_json(s3, bucket, key)
            if photo is not None:
                data = s3.get_object(Bucket=bucket, Key=photo["thumbnail"])["Body"].read()
                pixels, perceptual = fingerprint(data)
                return photo, (self.originals[photo["key"]], pixels, perceptual)
            return None

        with ThreadPoolExecutor(max_workers=8) as pool:
            entries = list(pool.map(entry, (key for key in objects if key.startswith("gallery/entries/"))))
        by_key = {}
        for result in entries:
            if result:
                photo, identity = result
                by_key[photo["key"]] = photo
                self.identities[photo["key"]] = identity
        # A matching thumbnail is only a candidate: validate original bytes and
        # full-resolution decoded pixels before collapsing existing photographs.
        counts = Counter(identity[1] for identity in self.identities.values())
        hash_counts = Counter(identity[0] for identity in self.identities.values())
        def original_pixels(key):
            data = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
            if hashlib.sha256(data).hexdigest() != self.originals[key]:
                raise RuntimeError("Original SHA-256 verification failed")
            pixels, _ = fingerprint(data)
            return key, pixels
        candidates = [key for key, identity in self.identities.items()
                      if counts[identity[1]] > 1 or hash_counts[identity[0]] > 1]
        with ThreadPoolExecutor(max_workers=4) as pool:
            for key, pixels in pool.map(original_pixels, candidates):
                digest, _, perceptual = self.identities[key]
                self.identities[key] = (digest, "original:" + pixels, perceptual)
        self.photos = []
        current_keys = set()
        for photo in self.manifest["photos"]:
            if photo["key"] not in current_keys:
                self.photos.append(by_key[photo["key"]])
                current_keys.add(photo["key"])
        self.photos.extend(photo for key, photo in by_key.items() if key not in current_keys)

    @contextmanager
    def reserve(self, key, name, digest, pixels, perceptual):
        """Wait for matching transfers; release provisional identity on every exit."""
        name = name.casefold()
        with self.mutex:
            while any(other == key or name == pending_name or digest == pending_digest or
                      pixels == pending_pixels or (perceptual ^ pending_perceptual).bit_count() <= 10
                      for other, (pending_name, pending_digest, pending_pixels, pending_perceptual)
                      in self.pending.items()):
                self.mutex.wait()
            accepted = not (
                key in self.identities or
                self.hashes.get(digest, set()) - {key} or
                self.names.get(name, set()) - {key} or
                any(other != key and (pixels == identity[1] or
                    (perceptual ^ identity[2]).bit_count() <= 10)
                    for other, identity in self.identities.items())
            )
            if accepted:
                self.pending[key] = (name, digest, pixels, perceptual)
        try:
            yield accepted
        finally:
            if accepted:
                with self.mutex:
                    del self.pending[key]
                    self.mutex.notify_all()

    def add(self, photo):
        """Commit identity only after the original, previews and entry are stored."""
        with self.mutex:
            key = photo["key"]
            name, digest, pixels, perceptual = self.pending[key]
            self.hashes.setdefault(digest, set()).add(key)
            self.names.setdefault(name, set()).add(key)
            self.identities[key] = (digest, pixels, perceptual)
            self.photos.append(photo)

    def publish(self, dry_run=False):
        with self.mutex:
            photos = unique_photos(self.photos, self.identities)
        updated = {**self.manifest, "photos": photos}
        retained = {photo["key"] for photo in photos}
        Path("catalog-dedup-report.json").write_text(json.dumps({
            "photos": len(photos),
            "excluded": [photo["key"] for photo in self.photos if photo["key"] not in retained],
        }))
        if dry_run:
            return len(photos)
        if updated == self.manifest:
            return len(photos)
        Path(f"manifest-before-{uuid.uuid4()}.json").write_text(json.dumps(self.manifest))
        response = self.s3.put_object(
            Bucket=self.bucket, Key="gallery/manifest.json",
            Body=json.dumps(updated).encode(), ContentType="application/json",
            CacheControl="public, max-age=60",
            **({"IfMatch": self.etag} if self.etag else {"IfNoneMatch": "*"}),
        )
        self.etag, self.manifest = response["ETag"], updated
        return len(photos)
