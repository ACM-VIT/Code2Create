"""Regression coverage for content deduplication, retries, and concurrent runs."""

from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import json
from pathlib import Path
import threading
import unittest
from unittest.mock import MagicMock, patch

from botocore.exceptions import ClientError
from PIL import Image, PngImagePlugin

from dedup import Gallery, fingerprint, import_lock, unique_photos


def photo(key):
    return {"key": key, "thumbnail": "thumb/" + key, "name": key}


def picture(metadata=""):
    image = Image.new("RGB", (64, 48), "red")
    image.paste("blue", (0, 0, 24, 30))
    info = PngImagePlugin.PngInfo()
    info.add_text("source", metadata)
    output = io.BytesIO()
    image.save(output, "PNG", pnginfo=info)
    return output.getvalue()


class DedupTests(unittest.TestCase):
    def test_metadata_changes_bytes_but_not_image_identity(self):
        a, b = picture("drive"), picture("sharepoint")
        self.assertNotEqual(hashlib.sha256(a).digest(), hashlib.sha256(b).digest())
        self.assertEqual(fingerprint(a), fingerprint(b))

    def test_cross_source_duplicates_and_repeated_keys_keep_first(self):
        photos = [photo("a"), photo("b"), photo("a"), photo("c")]
        identities = {"a": ("sha1", "pixels1", 0), "b": ("sha2", "pixels1", 0),
                      "c": ("sha3", "pixels3", 1)}
        self.assertEqual(unique_photos(photos, identities), [photos[0], photos[3]])

    def test_overlapping_duplicate_groups_have_one_representative(self):
        photos = [photo("a"), photo("b"), photo("c")]
        identities = {"a": ("sha1", "pixels1", 0), "b": ("sha2", "pixels2", 0),
                      "c": ("sha1", "pixels2", 0)}
        self.assertEqual(unique_photos(photos, identities), [photos[0]])

    def test_distinct_photos_with_same_name_are_not_removed_from_catalog(self):
        photos = [{**photo("a"), "name": "IMG_1.jpg"}, {**photo("b"), "name": "IMG_1.jpg"}]
        identities = {"a": ("sha1", "pixels1", 0), "b": ("sha2", "pixels2", 1)}
        self.assertEqual(unique_photos(photos, identities), photos)

    def test_missing_content_identity_fails_closed(self):
        with self.assertRaises(RuntimeError):
            unique_photos([photo("a")], {"a": (None, "pixels", 0)})

    def gallery(self):
        gallery = Gallery.__new__(Gallery)
        gallery.mutex = threading.Lock()
        gallery.hashes, gallery.names, gallery.identities = {}, {}, {}
        return gallery

    def test_concurrent_duplicate_uploads_have_only_one_reservation(self):
        gallery = self.gallery()
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda i: gallery.reserve(str(i), str(i), "same", "same", 0), range(32)))
        self.assertEqual(sum(results), 1)

    def test_recompressed_or_uncertain_new_image_is_skipped(self):
        gallery = self.gallery()
        self.assertTrue(gallery.reserve("a", "a.jpg", "sha1", "pixels1", 0))
        self.assertFalse(gallery.reserve("b", "b.jpg", "sha2", "pixels2", 7))
        self.assertFalse(gallery.reserve("c", "A.JPG", "sha3", "pixels3", (1 << 64) - 1))
        self.assertTrue(gallery.reserve("d", "d.jpg", "sha4", "pixels4", (1 << 64) - 1))

    def test_same_original_can_resume_after_failed_upload(self):
        gallery = self.gallery()
        self.assertTrue(gallery.reserve("a", "a.jpg", "sha", "pixels", 0))
        self.assertTrue(gallery.reserve("a", "a.jpg", "sha", "pixels", 0))

    def test_publishing_twice_is_idempotent_and_uses_compare_and_swap(self):
        gallery = self.gallery()
        gallery.photos = [photo("b"), photo("a"), photo("c")]
        gallery.identities = {"a": ("sha1", "pixels1", 0), "b": ("sha2", "pixels1", 0),
                              "c": ("sha3", "pixels3", 1)}
        gallery.manifest = {"photos": gallery.photos}
        gallery.etag, gallery.bucket = '"old"', "bucket"
        gallery.s3 = MagicMock()
        gallery.s3.put_object.return_value = {"ETag": '"new"'}
        with patch.object(Path, "write_text"):
            self.assertEqual(gallery.publish(), 2)
            self.assertEqual(gallery.publish(), 2)
        gallery.s3.put_object.assert_called_once()
        self.assertEqual(gallery.s3.put_object.call_args.kwargs["IfMatch"], '"old"')
        self.assertEqual(gallery.manifest["photos"], [photo("b"), photo("c")])

    def test_audit_does_not_write_s3(self):
        gallery = self.gallery()
        gallery.photos = [photo("a")]
        gallery.identities = {"a": ("sha", "pixels", 0)}
        gallery.manifest, gallery.s3 = {"photos": []}, MagicMock()
        with patch.object(Path, "write_text"):
            self.assertEqual(gallery.publish(dry_run=True), 1)
        gallery.s3.put_object.assert_not_called()


class LockTests(unittest.TestCase):
    def test_active_lock_stops_second_import(self):
        s3 = MagicMock()
        with patch("dedup.read_json", return_value=({"active": True}, '"etag"')):
            with self.assertRaises(RuntimeError), import_lock(s3, "bucket"):
                self.fail("Lock admitted a second importer")
        s3.put_object.assert_not_called()

    def test_lock_acquisition_and_release_are_conditional_even_on_error(self):
        s3 = MagicMock()
        s3.put_object.return_value = {"ETag": '"owned"'}
        with patch("dedup.read_json", return_value=({"active": False}, '"idle"')):
            with self.assertRaisesRegex(ValueError, "failure"):
                with import_lock(s3, "bucket"):
                    raise ValueError("failure")
        calls = s3.put_object.call_args_list
        self.assertEqual(calls[0].kwargs["IfMatch"], '"idle"')
        self.assertEqual(calls[1].kwargs["IfMatch"], '"owned"')

    def test_lost_lock_race_does_not_enter_or_release_other_owner(self):
        s3 = MagicMock()
        s3.put_object.side_effect = ClientError({"Error": {"Code": "PreconditionFailed"}}, "PutObject")
        with patch("dedup.read_json", return_value=(None, None)):
            with self.assertRaises(ClientError), import_lock(s3, "bucket"):
                self.fail("Lost race was admitted")
        s3.put_object.assert_called_once()


class CatalogRebuildTests(unittest.TestCase):
    def store(self):
        s3 = MagicMock()
        objects = {}
        for key, metadata in (("a", "drive"), ("b", "sharepoint")):
            original = picture(metadata)
            objects["originals/" + key] = original
            objects["thumb/originals/" + key] = original
            objects["gallery/entries/" + key] = json.dumps(photo("originals/" + key)).encode()
        objects["gallery/manifest.json"] = json.dumps({"photos": [photo("originals/b"), photo("originals/a")]}).encode()
        s3.get_paginator.return_value.paginate.side_effect = lambda **kwargs: [{"Contents": [{"Key": k} for k in objects]}]
        def get(**kwargs):
            data = objects[kwargs["Key"]]
            return {"Body": io.BytesIO(data), "ETag": hashlib.sha256(data).hexdigest()}
        def put(**kwargs):
            previous = objects.get(kwargs["Key"])
            if "IfMatch" in kwargs and hashlib.sha256(previous).hexdigest() != kwargs["IfMatch"]:
                raise ClientError({"Error": {"Code": "PreconditionFailed"}}, "PutObject")
            objects[kwargs["Key"]] = kwargs["Body"]
            return {"ETag": hashlib.sha256(kwargs["Body"]).hexdigest()}
        s3.get_object.side_effect = get
        s3.put_object.side_effect = put
        s3.head_object.side_effect = lambda **kwargs: {"Metadata": {"sha256": hashlib.sha256(objects[kwargs["Key"]]).hexdigest()}}
        return s3, objects

    def test_full_rebuild_never_reintroduces_retained_duplicate_entries(self):
        s3, objects = self.store()
        with patch.object(Path, "write_text"):
            self.assertEqual(Gallery(s3, "bucket").publish(), 1)
            self.assertEqual(Gallery(s3, "bucket").publish(), 1)
        self.assertEqual(json.loads(objects["gallery/manifest.json"])["photos"], [photo("originals/b")])
        self.assertIn("originals/a", objects)
        self.assertIn("gallery/entries/a", objects)
        s3.put_object.assert_called_once()

    def test_corrupt_original_stops_rebuild_before_publication(self):
        s3, _ = self.store()
        s3.head_object.side_effect = lambda **kwargs: {"Metadata": {"sha256": "wrong"}}
        with self.assertRaisesRegex(RuntimeError, "verification failed"):
            Gallery(s3, "bucket")
        s3.put_object.assert_not_called()

    def test_thumbnail_collision_does_not_hide_different_full_resolution_photo(self):
        s3, objects = self.store()
        image = Image.new("RGB", (100, 100), "green")
        output = io.BytesIO()
        image.save(output, "PNG")
        objects["originals/a"] = output.getvalue()
        with patch.object(Path, "write_text"):
            self.assertEqual(Gallery(s3, "bucket").publish(), 2)

    def test_concurrent_catalog_edit_is_not_overwritten(self):
        s3, objects = self.store()
        gallery = Gallery(s3, "bucket")
        objects["gallery/manifest.json"] = b'{"photos": []}'
        with patch.object(Path, "write_text"), self.assertRaises(ClientError):
            gallery.publish()
        self.assertEqual(objects["gallery/manifest.json"], b'{"photos": []}')


if __name__ == "__main__":
    unittest.main()
