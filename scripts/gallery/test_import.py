"""Downloader regression tests; all network and AWS calls are mocked."""
import importlib.util
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch
from PIL import Image
from botocore.exceptions import ClientError

with patch("boto3.client"):
    spec = importlib.util.spec_from_file_location("gallery_import", Path(__file__).with_name("import.py"))
    importer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(importer)


def response(body, content_type, length=None):
    result = MagicMock()
    result.__enter__.return_value = result
    result.headers = {"Content-Type": content_type}
    if length is not None:
        result.headers["Content-Length"] = str(length)
    result.text = body if isinstance(body, str) else ""
    result.iter_content.return_value = [body]
    return result


class DriveDownloadTests(unittest.TestCase):
    def download(self, responses):
        with tempfile.TemporaryDirectory() as directory, patch.object(importer.requests, "Session") as factory:
            session = factory.return_value.__enter__.return_value
            session.get.side_effect = responses
            destination = Path(directory) / "original"
            importer.download_drive({"id": "source-file"}, destination)
            return destination.read_bytes(), session.get.call_args_list

    def test_direct_original_bytes_are_unchanged(self):
        original = b"original image bytes including metadata\x00\xff"
        saved, calls = self.download([response(original, "image/jpeg", len(original))])
        self.assertEqual(saved, original)
        self.assertEqual(len(calls), 1)

    def test_large_file_uses_the_confirmation_forms_exact_parameters(self):
        form = '<form id="download-form" action="https://drive.usercontent.google.com/download"><input type="hidden" name="id" value="source-file"><input type="hidden" name="uuid" value="confirmation-value"><input type="hidden" name="confirm" value="t"></form>'
        saved, calls = self.download([response(form, "text/html"), response(b"video", "video/mp4", 5)])
        self.assertEqual(saved, b"video")
        self.assertEqual(calls[1].kwargs["params"], {"id": "source-file", "uuid": "confirmation-value", "confirm": "t"})

    def test_confirmation_cannot_redirect_to_another_file(self):
        form = '<form id="download-form" action="https://drive.usercontent.google.com/download"><input type="hidden" name="id" value="other-file"></form>'
        with self.assertRaisesRegex(RuntimeError, "different file"):
            self.download([response(form, "text/html")])

    def test_incomplete_original_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "size mismatch"):
            self.download([response(b"partial", "image/jpeg", 100)])

    def test_duplicate_is_skipped_before_any_s3_upload(self):
        gallery = MagicMock()
        gallery.reserve.return_value.__enter__.return_value = False
        def download(item, destination):
            Image.new("RGB", (64, 48), "red").save(destination, "PNG")
        with patch.object(importer, "exists", return_value=None), \
             patch.object(importer, "download_drive", side_effect=download), \
             patch.object(importer, "S3") as s3:
            result = importer.transfer({"source": "drive", "id": "new-id", "path": "renamed.png"}, None, gallery)
        self.assertEqual(result, ("skipped", 0))
        s3.put_object.assert_not_called()
        gallery.add.assert_not_called()


class TransferReservationTests(unittest.TestCase):
    def test_failed_transfer_does_not_suppress_healthy_identical_source(self):
        for stage in ("original", "verification", "preview", "thumbnail", "entry"):
            with self.subTest(stage=stage):
                objects, metadata = {}, {}
                s3 = MagicMock()
                s3.get_paginator.return_value.paginate.return_value = []
                failed = False
                def missing():
                    return ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")
                def get(**kwargs):
                    key = kwargs["Key"]
                    if key not in objects:
                        raise missing()
                    return {"Body": io.BytesIO(objects[key]), "ETag": '"etag"'}
                def head(**kwargs):
                    nonlocal failed
                    key = kwargs["Key"]
                    if key not in objects:
                        raise missing()
                    if stage == "verification" and key.startswith("originals/") and not failed:
                        failed = True
                        return {"ContentLength": 0, "Metadata": metadata[key]}
                    return {"ContentLength": len(objects[key]), "Metadata": metadata[key]}
                def put(**kwargs):
                    nonlocal failed
                    key = kwargs["Key"]
                    target = ("original" if key.startswith("originals/") else
                              "entry" if key.startswith("gallery/entries/") else
                              "thumbnail" if key.endswith("-800.webp") else "preview")
                    if target == stage and not failed:
                        failed = True
                        raise RuntimeError("Injected upload failure")
                    self.assertNotIn(key, objects)
                    body = kwargs["Body"]
                    objects[key] = body.read() if hasattr(body, "read") else body
                    metadata[key] = kwargs.get("Metadata", {})
                    return {"ETag": '"etag"'}
                s3.get_object.side_effect = get
                s3.head_object.side_effect = head
                s3.put_object.side_effect = put
                def download(item, destination):
                    Image.new("RGB", (64, 48), "red").save(destination, "PNG")
                with patch.object(importer, "S3", s3), \
                     patch.object(importer, "download_drive", side_effect=download):
                    gallery = importer.Gallery(s3, importer.BUCKET)
                    first = {"source": "drive", "id": "failed", "path": "first.png"}
                    with self.assertRaises(RuntimeError):
                        importer.transfer(first, None, gallery)
                    self.assertTrue(failed)
                    self.assertEqual(gallery.pending, {})
                    self.assertEqual(gallery.photos, [])
                    # Both another source ID and the same filename must be eligible.
                    healthy = {"source": "drive", "id": "healthy", "path": "first.png"}
                    status, size = importer.transfer(healthy, None, gallery)
                    self.assertEqual(status, "uploaded")
                    self.assertGreater(size, 0)
                    self.assertEqual(len(gallery.photos), 1)
                    entry = gallery.photos[0]
                    self.assertEqual(len(objects[entry["key"]]), size)
                    self.assertEqual(hashlib.sha256(objects[entry["key"]]).hexdigest(),
                                     metadata[entry["key"]]["sha256"])
                    self.assertIn(entry["preview"], objects)
                    self.assertIn(entry["thumbnail"], objects)
                    self.assertIn(entry, [json.loads(data) for key, data in objects.items()
                                          if key.startswith("gallery/entries/")])
                    self.assertEqual(gallery.pending, {})
                    # Committed content continues to block subsequent duplicates.
                    duplicate = {"source": "drive", "id": "duplicate", "path": "renamed.png"}
                    before = s3.put_object.call_count
                    self.assertEqual(importer.transfer(duplicate, None, gallery), ("skipped", 0))
                    self.assertEqual(s3.put_object.call_count, before)


if __name__ == "__main__":
    unittest.main()
