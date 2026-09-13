from __future__ import annotations

import base64
from io import BytesIO
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

from PIL import Image


BRIDGE_PATH = Path(__file__).resolve().parents[1] / "bridge.py"
SPEC = importlib.util.spec_from_file_location("bpjs_orthanc_bridge", BRIDGE_PATH)
assert SPEC and SPEC.loader
bridge = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = bridge
SPEC.loader.exec_module(bridge)


class MetadataTests(unittest.TestCase):
    def test_dicom_date(self) -> None:
        self.assertEqual(bridge.dicom_date("20260913"), "2026-09-13")
        self.assertEqual(bridge.dicom_date("20261340"), "")

    def test_patient_name_and_nik(self) -> None:
        self.assertEqual(bridge.clean_patient_name("SARI^BINTI^AMIN"), "SARI BINTI AMIN")
        self.assertEqual(bridge.nik_candidate("7371-0123-4567-8901"), "7371012345678901")
        self.assertEqual(bridge.nik_candidate("RM-12345"), "")

    def test_study_payload_merges_patient_and_study_tags(self) -> None:
        result = bridge.study_payload({
            "ID": "orthanc-study-id",
            "PatientMainDicomTags": {
                "PatientName": "SARI^AMIN",
                "PatientID": "7371012345678901",
                "PatientBirthDate": "19900102",
            },
            "MainDicomTags": {
                "StudyDate": "20260913",
                "StudyInstanceUID": "1.2.3.4",
            },
        }, 3)
        self.assertEqual(result["patient_name"], "SARI AMIN")
        self.assertEqual(result["patient_birth_date"], "1990-01-02")
        self.assertEqual(result["study_date"], "2026-09-13")
        self.assertEqual(result["expected_images"], 3)

    def test_apps_script_endpoint_is_restricted_to_https_google_deployment(self) -> None:
        valid = bridge.BridgeConfig(
            orthanc_url="http://127.0.0.1:8042",
            orthanc_username="bridge",
            orthanc_password="secret",
            apps_script_url="https://script.google.com/macros/s/deployment-id/exec",
            bridge_id="ORTHANC_TEST",
            bridge_key="a" * 96,
        )
        valid.validate()
        invalid = bridge.BridgeConfig(
            orthanc_url="http://127.0.0.1:8042",
            orthanc_username="bridge",
            orthanc_password="secret",
            apps_script_url="https://example.com/collect",
            bridge_id="ORTHANC_TEST",
            bridge_key="a" * 96,
        )
        with self.assertRaises(bridge.BridgeError):
            invalid.validate()

    def test_plain_http_orthanc_is_restricted_to_localhost(self) -> None:
        invalid = bridge.BridgeConfig(
            orthanc_url="http://192.168.1.20:8042",
            orthanc_username="bridge",
            orthanc_password="secret",
            apps_script_url="https://script.google.com/macros/s/deployment-id/exec",
            bridge_id="ORTHANC_TEST",
            bridge_key="a" * 96,
        )
        with self.assertRaises(bridge.BridgeError):
            invalid.validate()


class ImageTests(unittest.TestCase):
    def test_jpeg_bundle_resizes_and_creates_thumbnail(self) -> None:
        source = Image.new("RGB", (4000, 3000), "white")
        raw = BytesIO()
        source.save(raw, format="PNG")
        bundle = bridge.make_jpeg_bundle(raw.getvalue())
        self.assertEqual((bundle["width"], bundle["height"]), (2800, 2100))
        self.assertEqual((bundle["thumbnail_width"], bundle["thumbnail_height"]), (400, 300))
        image_data = base64.b64decode(bundle["base64"])
        self.assertTrue(image_data.startswith(b"\xff\xd8\xff"))
        self.assertLessEqual(len(image_data), bridge.MAX_UPLOAD_BYTES)


class SyncTests(unittest.TestCase):
    def test_failed_preview_is_not_double_counted_as_expected_image(self) -> None:
        class FakeOrthanc:
            def preview(self, instance_id: str, _frame_index: int) -> bytes:
                if instance_id == "instance-failed":
                    raise bridge.BridgeError("preview gagal")
                return b"preview"

        class FakeWebApp:
            def __init__(self) -> None:
                self.calls: list[tuple[str, dict]] = []

            def post(self, action: str, **values: object) -> dict:
                self.calls.append((action, values))
                if action == "upsert_study":
                    return {"should_upload": True, "status": "RECEIVING"}
                if action == "finalize_study":
                    return {"status": "READY"}
                return {}

        class FakeState:
            def __init__(self) -> None:
                self.marked: list[str] = []

            def completed(self, _source_key: str) -> bool:
                return False

            def mark_completed(self, source_key: str) -> None:
                self.marked.append(source_key)

        config = bridge.BridgeConfig(
            orthanc_url="http://127.0.0.1:8042",
            orthanc_username="bridge",
            orthanc_password="secret",
            apps_script_url="https://script.google.com/macros/s/deployment-id/exec",
            bridge_id="ORTHANC_TEST",
            bridge_key="a" * 96,
        )
        study = {
            "ID": "study-1",
            "MainDicomTags": {"StudyInstanceUID": "1.2.3", "StudyDate": "20260913"},
        }
        candidates = [
            ("series-1", "instance-ok", {"SOPInstanceUID": "1.2.3.1"}, 0),
            ("series-1", "instance-failed", {"SOPInstanceUID": "1.2.3.2"}, 0),
        ]
        bundle = {
            "mime_type": "image/jpeg", "base64": "abc", "width": 100, "height": 80,
            "thumbnail_base64": "def", "thumbnail_width": 50, "thumbnail_height": 40,
        }
        webapp = FakeWebApp()
        state = FakeState()
        with patch.object(bridge, "instance_references", return_value=[]), \
                patch.object(bridge, "image_candidates", return_value=(candidates, 1)), \
                patch.object(bridge, "make_jpeg_bundle", return_value=bundle):
            bridge.sync_study(config, FakeOrthanc(), webapp, state, study)

        finalize = next(values["study"] for action, values in webapp.calls if action == "finalize_study")
        self.assertEqual(finalize["expected_images"], 3)
        self.assertEqual(finalize["skipped_images"], 2)
        self.assertEqual(len(state.marked), 1)


if __name__ == "__main__":
    unittest.main()
