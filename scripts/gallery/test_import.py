"""Downloader regression tests; all network and AWS calls are mocked."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch
from PIL import Image

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
        gallery.reserve.return_value = False
        def download(item, destination):
            Image.new("RGB", (64, 48), "red").save(destination, "PNG")
        with patch.object(importer, "exists", return_value=None), \
             patch.object(importer, "download_drive", side_effect=download), \
             patch.object(importer, "S3") as s3:
            result = importer.transfer({"source": "drive", "id": "new-id", "path": "renamed.png"}, None, gallery)
        self.assertEqual(result, ("skipped", 0))
        s3.put_object.assert_not_called()
        gallery.add.assert_not_called()


if __name__ == "__main__":
    unittest.main()
