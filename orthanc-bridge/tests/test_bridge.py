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
    def test_default_poll_interval_is_ten_minutes(self) -> None:
        self.assertEqual(bridge.BridgeConfig.__dataclass_fields__["poll_seconds"].default, 600)

    def test_dicom_date(self) -> None:
        self.assertEqual(bridge.dicom_date("20260913"), "2026-09-13")
        self.assertEqual(bridge.dicom_date("20261340"), "")

    def test_patient_name_and_nik(self) -> None:
        self.assertEqual(bridge.clean_patient_name("SARI^BINTI^AMIN"), "SARI BINTI AMIN")
        self.assertEqual(bridge.nik_candidate("7371-0123-4567-8901"), "7371012345678901")
        self.assertEqual(bridge.nik_candidate("RM-12345"), "")

    def test_mixed_identity_fields_are_classified_with_provenance(self) -> None:
        result = bridge.interpret_dicom_identity_fields({
            "PatientName": "SARI^AMIN",
            "PatientID": "dr. Budi Santoso",
            "AccessionNumber": "+62 812-3456-7890",
            "PatientComments": "NIK 7371012345678901",
        })
        self.assertEqual(result["patient_name"], "SARI AMIN")
        self.assertEqual(result["patient_nik"], "7371012345678901")
        self.assertEqual(result["patient_phone"], "081234567890")
        self.assertEqual(result["patient_phone_e164"], "+6281234567890")
        self.assertEqual(result["doctor_name"], "dr Budi Santoso")
        self.assertEqual(result["nik_sources"], ["PatientComments"])
        self.assertEqual(result["phone_sources"], ["AccessionNumber"])
        self.assertEqual(result["doctor_sources"], ["PatientID"])
        self.assertEqual(result["identity_status"], "READY")

    def test_conflicting_identity_values_are_not_guessed(self) -> None:
        result = bridge.interpret_dicom_identity_fields({
            "PatientName": "SARI",
            "PatientID": "7371012345678901",
            "AccessionNumber": "081234567890",
            "PatientComments": "NIK 7371012345678902",
            "PerformingPhysicianName": "DR SATU",
            "ReferringPhysicianName": "DR DUA",
        })
        self.assertEqual(result["patient_nik"], "")
        self.assertEqual(result["doctor_name"], "")
        self.assertEqual(result["identity_status"], "AMBIGUOUS")
        self.assertGreaterEqual(len(result["metadata_warnings"]), 2)

    def test_standard_phone_and_doctor_tags_take_precedence(self) -> None:
        result = bridge.interpret_dicom_identity_fields({
            "PatientName": "SARI",
            "PatientID": "7371012345678901",
            "AccessionNumber": "081111111111",
            "PatientComments": "TEKS OPERATOR",
            "PatientTelephoneNumbers": "082222222222",
            "PerformingPhysicianName": "DR BUDI",
        })
        self.assertEqual(result["patient_phone"], "082222222222")
        self.assertEqual(result["phone_sources"], ["PatientTelephoneNumbers"])
        self.assertEqual(result["doctor_name"], "DR BUDI")
        self.assertEqual(result["doctor_sources"], ["PerformingPhysicianName"])

    def test_comment_extracts_doctor_and_phone_from_multiple_formats(self) -> None:
        for comment, expected_phone in (
            ("dr ica; 08113908011", "08113908011"),
            ("dr ica 08234567890", "08234567890"),
            ("dr ica, 089123748290", "089123748290"),
        ):
            with self.subTest(comment=comment):
                result = bridge.interpret_dicom_identity_fields({
                    "PatientName": "SARI^AMIN",
                    "PatientID": "7371012345678901",
                    "PatientComments": comment,
                })
                self.assertEqual(result["patient_name"], "SARI AMIN")
                self.assertEqual(result["patient_nik"], "7371012345678901")
                self.assertEqual(result["patient_phone"], expected_phone)
                self.assertEqual(result["doctor_name"], "dr ica")
                self.assertEqual(result["phone_sources"], ["PatientComments"])
                self.assertEqual(result["doctor_sources"], ["PatientComments"])
                self.assertEqual(result["identity_status"], "READY")

    def test_id_and_comment_are_classified_by_content_not_position(self) -> None:
        result = bridge.interpret_dicom_identity_fields({
            "PatientName": "SARI^AMIN",
            "PatientID": "DR. ICA",
            "PatientComments": "7371012345678901; 628113908011",
        })
        self.assertEqual(result["patient_nik"], "7371012345678901")
        self.assertEqual(result["patient_phone"], "08113908011")
        self.assertEqual(result["patient_phone_e164"], "+628113908011")
        self.assertEqual(result["doctor_name"], "DR ICA")
        self.assertEqual(result["nik_sources"], ["PatientComments"])
        self.assertEqual(result["phone_sources"], ["PatientComments"])
        self.assertEqual(result["doctor_sources"], ["PatientID"])
        self.assertEqual(result["identity_status"], "READY")

    def test_unprefixed_text_in_mixed_fields_is_not_assumed_to_be_doctor(self) -> None:
        result = bridge.interpret_dicom_identity_fields({
            "PatientName": "SARI^AMIN",
            "PatientID": "ICA",
            "PatientComments": "7371012345678901; 08113908011",
        })
        self.assertEqual(result["doctor_name"], "")
        self.assertEqual(result["identity_status"], "PARTIAL")
        self.assertIn("Nama dokter tidak tersedia.", result["metadata_warnings"])

    def test_same_phone_in_local_and_country_format_is_deduplicated(self) -> None:
        result = bridge.interpret_dicom_identity_fields({
            "PatientName": "SARI^AMIN",
            "PatientID": "08113908011",
            "AccessionNumber": "7371012345678901",
            "PatientComments": "dr ica; 628113908011",
        })
        self.assertEqual(result["patient_phone"], "08113908011")
        self.assertEqual(
            result["phone_sources"],
            ["PatientID", "PatientComments"],
        )
        self.assertEqual(result["identity_status"], "READY")

    def test_phone_length_matches_web_app_contract(self) -> None:
        self.assertEqual(bridge.normalize_phone_digits("0812345678"), ("0812345678", "+62812345678"))
        self.assertEqual(
            bridge.normalize_phone_digits("0812345678901"),
            ("0812345678901", "+62812345678901"),
        )
        self.assertEqual(bridge.normalize_phone_digits("081234567"), ("", ""))
        self.assertEqual(bridge.normalize_phone_digits("08123456789012"), ("", ""))

    def test_different_phone_candidates_are_ambiguous(self) -> None:
        result = bridge.interpret_dicom_identity_fields({
            "PatientName": "SARI^AMIN",
            "PatientID": "7371012345678901; 08113908011",
            "PatientComments": "dr ica; 08234567890",
        })
        self.assertEqual(result["patient_phone"], "")
        self.assertEqual(result["patient_phone_e164"], "")
        self.assertEqual(result["identity_status"], "AMBIGUOUS")
        self.assertIn(
            "Ditemukan lebih dari satu nomor telepon berbeda pada metadata DICOM.",
            result["metadata_warnings"],
        )

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
            "RequestedTags": {
                "PatientComments": "DR ICA",
            },
        }, 3)
        self.assertEqual(result["patient_name"], "SARI AMIN")
        self.assertEqual(result["patient_id"], "7371012345678901")
        self.assertEqual(result["patient_comments"], "DR ICA")
        self.assertEqual(result["patient_birth_date"], "1990-01-02")
        self.assertEqual(result["study_date"], "2026-09-13")
        self.assertEqual(result["expected_images"], 3)
        self.assertEqual(result["expected_dicoms"], 0)

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

    def test_gcs_only_config_does_not_require_apps_script_credentials(self) -> None:
        config = bridge.BridgeConfig(
            orthanc_url="http://127.0.0.1:8042",
            orthanc_username="bridge",
            orthanc_password="secret",
            bridge_id="ORTHANC_TEST",
            upload_to_google_drive=False,
            upload_to_gcs=True,
            gcs_bucket="purbalingga-usg-data",
        )
        config.validate()

    def test_at_least_one_destination_is_required(self) -> None:
        config = bridge.BridgeConfig(
            orthanc_url="http://127.0.0.1:8042",
            orthanc_username="bridge",
            orthanc_password="secret",
            bridge_id="ORTHANC_TEST",
            upload_to_google_drive=False,
            upload_to_gcs=False,
        )
        with self.assertRaises(bridge.BridgeError):
            config.validate()

    def test_bigquery_metadata_requires_gcs(self) -> None:
        config = bridge.BridgeConfig(
            orthanc_url="http://127.0.0.1:8042",
            orthanc_username="bridge",
            orthanc_password="secret",
            bridge_id="ORTHANC_TEST",
            upload_to_google_drive=True,
            bridge_key="a" * 96,
            apps_script_url="https://script.google.com/macros/s/deployment-id/exec",
            upload_to_gcs=False,
            upload_metadata_to_bigquery=True,
        )
        with self.assertRaises(bridge.BridgeError):
            config.validate()

    def test_whatsapp_trigger_requires_bigquery_metadata(self) -> None:
        config = bridge.BridgeConfig(
            orthanc_url="http://127.0.0.1:8042",
            orthanc_username="bridge",
            orthanc_password="secret",
            bridge_id="ORTHANC_TEST",
            upload_to_google_drive=False,
            upload_to_gcs=True,
            gcs_bucket="purbalingga-usg-data",
            trigger_whatsapp_webhook=True,
            whatsapp_webhook_url=(
                "https://n8n.id.spheres.oucru-id.org/webhook/send-usg:test"
            ),
            whatsapp_webhook_api_key="n8n_live_test_key_123456",
            whatsapp_trigger_not_before="2026-10-24T00:00:00+08:00",
        )
        with self.assertRaises(bridge.BridgeError):
            config.validate()

    def test_whatsapp_webhook_client_uses_validated_contract(self) -> None:
        config = bridge.BridgeConfig(
            orthanc_url="http://127.0.0.1:8042",
            orthanc_username="bridge",
            orthanc_password="secret",
            bridge_id="ORTHANC_TEST",
            upload_to_google_drive=False,
            upload_to_gcs=True,
            gcs_bucket="purbalingga-usg-data",
            upload_metadata_to_bigquery=True,
            trigger_whatsapp_webhook=True,
            whatsapp_webhook_url=(
                "https://n8n.id.spheres.oucru-id.org/webhook/send-usg:test"
            ),
            whatsapp_webhook_api_key="n8n_live_test_key_123456",
            whatsapp_trigger_not_before="2026-10-24T00:00:00+08:00",
        )
        config.validate()
        captured: dict[str, object] = {}

        def handler(request: object) -> object:
            captured["header"] = request.headers.get("X-API-Key")
            captured["payload"] = bridge.json.loads(request.content)
            return bridge.httpx.Response(200, json={"message": "Workflow was started"})

        client = bridge.WhatsAppWebhookClient(config)
        client.client.close()
        client.client = bridge.httpx.Client(
            transport=bridge.httpx.MockTransport(handler),
            timeout=30,
        )
        try:
            message = client.trigger({
                "study_key": "0123456789abcdef0123456789abcdef",
                "delivery_reference_id": "WA_" + "a" * 40,
                "object_key": "b" * 64,
                "source_sequence_number": 1,
                "frame_index": 0,
            })
        finally:
            client.close()

        self.assertEqual(message, "Workflow was started")
        self.assertEqual(captured["header"], "n8n_live_test_key_123456")
        self.assertEqual(captured["payload"], {
            "study_key": "0123456789abcdef0123456789abcdef",
            "delivery_reference_id": "WA_" + "a" * 40,
            "request_source": "ORTHANC_BRIDGE_AUTO",
            "selected_object_keys": ["b" * 64],
            "selected_images": [{
                "object_key": "b" * 64,
                "sequence_number": 1,
                "frame_index": 0,
            }],
        })


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
    def test_gcs_object_names_are_anonymous_and_content_addressed(self) -> None:
        config = bridge.BridgeConfig(
            orthanc_url="http://127.0.0.1:8042",
            orthanc_username="bridge",
            orthanc_password="secret",
            bridge_id="ORTHANC_TEST",
            upload_to_google_drive=False,
            upload_to_gcs=True,
            gcs_bucket="purbalingga-usg-data",
        )
        study = {
            "ID": "study-1",
            "PatientMainDicomTags": {"PatientName": "NAMA PASIEN", "PatientID": "1234567890123456"},
            "MainDicomTags": {"StudyInstanceUID": "1.2.3", "StudyDate": "20261020"},
        }
        dicom_name = bridge.gcs_dicom_object_name(config, study, 1, b"dicom")
        jpeg_name = bridge.gcs_jpeg_object_name(config, study, 1, 0, b"jpeg")
        self.assertRegex(dicom_name, r"^bpjs-usg/orthanc/studies/[0-9a-f]{32}/dicom/0001_[0-9a-f]{64}\.dcm$")
        self.assertRegex(jpeg_name, r"^bpjs-usg/orthanc/studies/[0-9a-f]{32}/jpg/0001_000_[0-9a-f]{64}\.jpg$")
        self.assertNotIn("NAMA", dicom_name)
        self.assertNotIn("1234567890123456", jpeg_name)

    def test_gcs_only_uploads_jpeg_and_dicom_without_webapp(self) -> None:
        class FakeOrthanc:
            def preview(self, _instance_id: str, _frame_index: int) -> bytes:
                return b"preview"

            def instance_file(self, _instance_id: str) -> bytes:
                return b"dicom"

        class FakeGcs:
            def __init__(self) -> None:
                self.uploads: list[tuple[str, bytes, str]] = []

            def upload(self, object_name: str, content: bytes, content_type: str) -> str:
                self.uploads.append((object_name, content, content_type))
                return "UPLOADED"

        class FakeState:
            def __init__(self) -> None:
                self.gcs_images_marked: list[str] = []
                self.gcs_dicoms_marked: list[str] = []

            def gcs_images_completed(self, _source_key: str) -> bool:
                return False

            def gcs_dicoms_completed(self, _source_key: str) -> bool:
                return False

            def mark_gcs_images_completed(self, source_key: str) -> None:
                self.gcs_images_marked.append(source_key)

            def mark_gcs_dicoms_completed(self, source_key: str) -> None:
                self.gcs_dicoms_marked.append(source_key)

        config = bridge.BridgeConfig(
            orthanc_url="http://127.0.0.1:8042",
            orthanc_username="bridge",
            orthanc_password="secret",
            bridge_id="ORTHANC_TEST",
            upload_to_google_drive=False,
            upload_to_gcs=True,
            gcs_bucket="purbalingga-usg-data",
        )
        study = {"ID": "study-1", "MainDicomTags": {"StudyInstanceUID": "1.2.3"}}
        bundle = {
            "mime_type": "image/jpeg", "base64": base64.b64encode(b"jpeg").decode("ascii"),
            "width": 100, "height": 80, "thumbnail_base64": "", "thumbnail_width": 0,
            "thumbnail_height": 0,
        }
        gcs = FakeGcs()
        state = FakeState()
        with patch.object(bridge, "instance_references", return_value=[("series-1", "instance-1")]), \
                patch.object(bridge, "image_candidates", return_value=([(
                    "series-1", "instance-1", {"SOPInstanceUID": "1.2.3.1"}, 0
                )], 0)), \
                patch.object(bridge, "make_jpeg_bundle", return_value=bundle):
            bridge.sync_study(config, FakeOrthanc(), None, gcs, state, study)

        self.assertEqual([item[2] for item in gcs.uploads], ["image/jpeg", "application/dicom"])
        self.assertEqual(len(state.gcs_images_marked), 1)
        self.assertEqual(len(state.gcs_dicoms_marked), 1)

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
            upload_original_dicoms=False,
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
            bridge.sync_study(config, FakeOrthanc(), webapp, None, state, study)

        finalize = next(values["study"] for action, values in webapp.calls if action == "finalize_study")
        self.assertEqual(finalize["expected_images"], 3)
        self.assertEqual(finalize["skipped_images"], 2)
        self.assertEqual(len(state.marked), 1)

    def test_completed_preview_study_backfills_original_dicom(self) -> None:
        raw_dicom = b"DICM-original-content"

        class FakeOrthanc:
            def instance_tags(self, _instance_id: str) -> dict:
                return {"SOPInstanceUID": "1.2.3.1"}

            def instance_file(self, _instance_id: str) -> bytes:
                return raw_dicom

        class FakeWebApp:
            def __init__(self) -> None:
                self.calls: list[tuple[str, dict]] = []
                self.uploads: list[tuple[str, bytes]] = []

            def post(self, action: str, **values: object) -> dict:
                self.calls.append((action, values))
                if action == "upsert_study":
                    return {
                        "status": "IMPORTED",
                        "should_upload": False,
                        "should_upload_images": False,
                        "should_upload_dicoms": True,
                    }
                if action == "prepare_dicom_upload":
                    return {
                        "dicom_id": "12345678-1234-4123-8123-123456789abc",
                        "upload_url": "https://www.googleapis.com/upload/drive/v3/files?upload_id=test",
                        "should_upload": True,
                    }
                if action == "finalize_study":
                    return {"status": "IMPORTED", "received_dicoms": 1}
                return {}

            def upload_dicom(self, upload_url: str, content: bytes) -> str:
                self.uploads.append((upload_url, content))
                return "drive-file-id-12345"

        class FakeState:
            def __init__(self) -> None:
                self.dicom_marked: list[str] = []

            def completed(self, _source_key: str) -> bool:
                return True

            def dicoms_completed(self, _source_key: str) -> bool:
                return False

            def mark_completed(self, _source_key: str) -> None:
                pass

            def mark_dicoms_completed(self, source_key: str) -> None:
                self.dicom_marked.append(source_key)

        config = bridge.BridgeConfig(
            orthanc_url="http://127.0.0.1:8042",
            orthanc_username="bridge",
            orthanc_password="secret",
            apps_script_url="https://script.google.com/macros/s/deployment-id/exec",
            bridge_id="ORTHANC_TEST",
            bridge_key="a" * 96,
            upload_original_dicoms=True,
            max_dicom_instances_per_study=10,
        )
        study = {
            "ID": "study-1",
            "MainDicomTags": {"StudyInstanceUID": "1.2.3", "StudyDate": "20260913"},
        }
        webapp = FakeWebApp()
        state = FakeState()
        with patch.object(bridge, "instance_references", return_value=[("series-1", "instance-1")]):
            bridge.sync_study(config, FakeOrthanc(), webapp, None, state, study)

        self.assertEqual(webapp.uploads, [(
            "https://www.googleapis.com/upload/drive/v3/files?upload_id=test",
            raw_dicom,
        )])
        prepared = next(values["dicom"] for action, values in webapp.calls if action == "prepare_dicom_upload")
        self.assertEqual(prepared["sha256_hash"], bridge.hashlib.sha256(raw_dicom).hexdigest())
        self.assertEqual(prepared["sequence_number"], 1)
        self.assertEqual(len(state.dicom_marked), 1)

    def test_completed_gcs_study_backfills_bigquery_without_reupload(self) -> None:
        class FakeOrthanc:
            def preview(self, _instance_id: str, _frame_index: int) -> bytes:
                return b"preview"

            def instance_file(self, _instance_id: str) -> bytes:
                return b"dicom"

            def instance_tags(self, _instance_id: str) -> dict:
                return {"SOPInstanceUID": "1.2.3.1"}

        class FakeGcs:
            def upload(self, *_args: object) -> str:
                raise AssertionError("GCS yang sudah selesai tidak boleh diunggah ulang")

        class FakeBigQuery:
            def __init__(self) -> None:
                self.calls: list[tuple[dict, list[dict]]] = []

            def upsert_study(self, study: dict, files: list[dict]) -> None:
                self.calls.append((study, files))

        class FakeState:
            def __init__(self) -> None:
                self.marked: list[str] = []

            def gcs_images_completed(self, _source_key: str) -> bool:
                return True

            def gcs_dicoms_completed(self, _source_key: str) -> bool:
                return True

            def bigquery_completed(self, _source_key: str) -> bool:
                return False

            def completion_time(self, _collection: str, _source_key: str) -> str:
                return "2026-10-22T15:55:00+00:00"

            def mark_bigquery_completed(self, source_key: str) -> None:
                self.marked.append(source_key)

        config = bridge.BridgeConfig(
            orthanc_url="http://127.0.0.1:8042",
            orthanc_username="bridge",
            orthanc_password="secret",
            bridge_id="ORTHANC_TEST",
            upload_to_google_drive=False,
            upload_to_gcs=True,
            upload_metadata_to_bigquery=True,
            gcs_bucket="purbalingga-usg-data",
        )
        study = {
            "ID": "study-1",
            "PatientMainDicomTags": {
                "PatientName": "SARI^AMIN",
                "PatientID": "DR BUDI",
            },
            "MainDicomTags": {
                "StudyInstanceUID": "1.2.3",
                "StudyDate": "20261022",
                "StudyTime": "101112",
            },
            "RequestedTags": {
                "AccessionNumber": "081234567890",
                "PatientComments": "7371012345678901",
            },
        }
        bundle = {
            "mime_type": "image/jpeg",
            "base64": base64.b64encode(b"jpeg").decode("ascii"),
            "width": 100,
            "height": 80,
            "thumbnail_base64": "",
            "thumbnail_width": 0,
            "thumbnail_height": 0,
        }
        registry = FakeBigQuery()
        state = FakeState()
        with patch.object(bridge, "instance_references", return_value=[("series-1", "instance-1")]), \
                patch.object(bridge, "image_candidates", return_value=([(
                    "series-1", "instance-1", {"SOPInstanceUID": "1.2.3.1"}, 0
                )], 0)), \
                patch.object(bridge, "make_jpeg_bundle", return_value=bundle):
            bridge.sync_study(
                config, FakeOrthanc(), None, FakeGcs(), state, study, bigquery=registry
            )

        self.assertEqual(len(registry.calls), 1)
        study_row, file_rows = registry.calls[0]
        self.assertEqual(study_row["identity_status"], "READY")
        self.assertTrue(study_row["whatsapp_ready"])
        self.assertEqual(study_row["jpeg_count"], 1)
        self.assertEqual(study_row["dicom_count"], 1)
        self.assertEqual({row["file_type"] for row in file_rows}, {"JPEG", "DICOM"})
        self.assertTrue(all(row["gcs_uri"].startswith("gs://") for row in file_rows))
        self.assertTrue(all("https://" not in row["gcs_uri"] for row in file_rows))
        self.assertEqual(len(state.marked), 1)

    def test_whatsapp_triggers_after_gcs_and_bigquery_without_reupload(self) -> None:
        class FakeOrthanc:
            pass

        class FakeGcs:
            def upload(self, *_args: object) -> str:
                raise AssertionError("GCS yang sudah selesai tidak boleh diunggah ulang")

        class FakeBigQuery:
            def __init__(self) -> None:
                self.updated: list[tuple[str, str, str]] = []

            def upsert_study(self, *_args: object) -> None:
                raise AssertionError("BigQuery metadata yang sudah selesai tidak boleh ditulis ulang")

            def get_auto_whatsapp_candidate(self, study_key: str, bridge_id: str) -> dict:
                self.candidate = {
                    "study_key": study_key,
                    "bridge_id": bridge_id,
                    "delivery_reference_id": "WA_" + "a" * 40,
                    "object_key": "b" * 64,
                    "patient_name": "SARI AMIN",
                    "patient_phone_e164": "+6281234567890",
                    "doctor_name": "DR BUDI",
                    "source_sequence_number": 1,
                    "frame_index": 0,
                }
                return self.candidate

            def acquire_auto_whatsapp_delivery(self, candidate: dict) -> dict:
                return {**candidate, "state": "ACQUIRED", "request_token": "request-token"}

            def update_auto_whatsapp_delivery(
                self, delivery_reference_id: str, request_token: str, status: str, *_args: object
            ) -> None:
                self.updated.append((delivery_reference_id, request_token, status))

        class FakeWhatsApp:
            def __init__(self) -> None:
                self.candidates: list[dict] = []

            def trigger(self, candidate: dict) -> str:
                self.candidates.append(candidate)
                return "Workflow was started"

        class FakeState:
            def __init__(self) -> None:
                self.marked: list[str] = []
                self.skipped: list[str] = []
                self.completed_at = "2026-10-24T01:00:00+08:00"

            def gcs_images_completed(self, _source_key: str) -> bool:
                return True

            def gcs_dicoms_completed(self, _source_key: str) -> bool:
                return True

            def bigquery_completed(self, _source_key: str) -> bool:
                return True

            def whatsapp_trigger_completed(self, _source_key: str) -> bool:
                return False

            def whatsapp_trigger_skipped(self, _source_key: str) -> bool:
                return False

            def completion_time(self, _collection: str, _source_key: str) -> str:
                return self.completed_at

            def mark_whatsapp_trigger_completed(self, source_key: str) -> None:
                self.marked.append(source_key)

            def mark_whatsapp_trigger_skipped(self, source_key: str) -> None:
                self.skipped.append(source_key)

        config = bridge.BridgeConfig(
            orthanc_url="http://127.0.0.1:8042",
            orthanc_username="bridge",
            orthanc_password="secret",
            bridge_id="ORTHANC_TEST",
            upload_to_google_drive=False,
            upload_to_gcs=True,
            gcs_bucket="purbalingga-usg-data",
            upload_metadata_to_bigquery=True,
            trigger_whatsapp_webhook=True,
            whatsapp_webhook_url=(
                "https://n8n.id.spheres.oucru-id.org/webhook/send-usg:test"
            ),
            whatsapp_webhook_api_key="n8n_live_test_key_123456",
            whatsapp_trigger_not_before="2026-10-24T00:00:00+08:00",
        )
        study = {
            "ID": "study-1",
            "PatientMainDicomTags": {
                "PatientName": "SARI^AMIN",
                "PatientID": "7371012345678901",
            },
            "MainDicomTags": {
                "StudyInstanceUID": "1.2.3",
                "StudyDate": "20261022",
            },
            "RequestedTags": {
                "AccessionNumber": "081234567890",
                "PatientComments": "DR BUDI",
            },
        }
        state = FakeState()
        whatsapp = FakeWhatsApp()
        registry = FakeBigQuery()
        with patch.object(
            bridge, "instance_references", return_value=[("series-1", "instance-1")]
        ), patch.object(bridge, "image_candidates", return_value=([(
            "series-1", "instance-1", {"SOPInstanceUID": "1.2.3.1"}, 0
        )], 0)), patch.object(
            bridge,
            "interpret_dicom_identity_fields",
            side_effect=AssertionError("Trigger otomatis tidak boleh mem-parsing identitas DICOM lagi"),
        ):
            bridge.sync_study(
                config,
                FakeOrthanc(),
                None,
                FakeGcs(),
                state,
                study,
                bigquery=registry,
                whatsapp=whatsapp,
            )

        self.assertEqual(
            [item["study_key"] for item in whatsapp.candidates],
            [bridge.gcs_study_key(config, study)],
        )
        self.assertEqual(
            registry.updated,
            [("WA_" + "a" * 40, "request-token", "QUEUED")],
        )
        self.assertEqual(len(state.marked), 1)
        self.assertEqual(state.skipped, [])

        state.completed_at = "2026-10-23T23:59:59+08:00"
        state.marked.clear()
        whatsapp.candidates.clear()
        older_study = {
            **study,
            "ID": "study-before-cutoff",
            "MainDicomTags": {
                **study["MainDicomTags"],
                "StudyInstanceUID": "1.2.3.older",
            },
        }
        with patch.object(
            bridge, "instance_references", return_value=[("series-1", "instance-1")]
        ), patch.object(bridge, "image_candidates", return_value=([(
            "series-1", "instance-1", {"SOPInstanceUID": "1.2.3.1"}, 0
        )], 0)):
            bridge.sync_study(
                config,
                FakeOrthanc(),
                None,
                FakeGcs(),
                state,
                older_study,
                bigquery=FakeBigQuery(),
                whatsapp=whatsapp,
            )

        self.assertEqual(whatsapp.candidates, [])
        self.assertEqual(state.marked, [])
        self.assertEqual(len(state.skipped), 1)

    def test_failed_whatsapp_trigger_remains_pending_for_retry(self) -> None:
        class FakeWhatsApp:
            def trigger(self, _candidate: dict) -> str:
                raise bridge.BridgeError("webhook gagal")

        class FakeBigQuery:
            def __init__(self) -> None:
                self.statuses: list[str] = []

            def get_auto_whatsapp_candidate(self, study_key: str, bridge_id: str) -> dict:
                return {
                    "study_key": study_key,
                    "bridge_id": bridge_id,
                    "delivery_reference_id": "WA_" + "a" * 40,
                    "object_key": "b" * 64,
                    "patient_name": "SARI AMIN",
                    "patient_phone_e164": "+6281234567890",
                    "doctor_name": "DR BUDI",
                    "source_sequence_number": 1,
                    "frame_index": 0,
                }

            def acquire_auto_whatsapp_delivery(self, candidate: dict) -> dict:
                return {**candidate, "state": "ACQUIRED", "request_token": "request-token"}

            def update_auto_whatsapp_delivery(
                self,
                _delivery_reference_id: str,
                _request_token: str,
                status: str,
                *_args: object,
            ) -> None:
                self.statuses.append(status)

        class FakeState:
            def __init__(self) -> None:
                self.marked: list[str] = []

            def gcs_images_completed(self, _source_key: str) -> bool:
                return True

            def gcs_dicoms_completed(self, _source_key: str) -> bool:
                return True

            def bigquery_completed(self, _source_key: str) -> bool:
                return True

            def whatsapp_trigger_completed(self, _source_key: str) -> bool:
                return False

            def whatsapp_trigger_skipped(self, _source_key: str) -> bool:
                return False

            def completion_time(self, _collection: str, _source_key: str) -> str:
                return "2026-10-24T01:00:00+08:00"

            def mark_whatsapp_trigger_completed(self, source_key: str) -> None:
                self.marked.append(source_key)

            def mark_whatsapp_trigger_skipped(self, _source_key: str) -> None:
                raise AssertionError("Studi baru tidak boleh dilewati")

        config = bridge.BridgeConfig(
            orthanc_url="http://127.0.0.1:8042",
            orthanc_username="bridge",
            orthanc_password="secret",
            bridge_id="ORTHANC_TEST",
            upload_to_google_drive=False,
            upload_to_gcs=True,
            gcs_bucket="purbalingga-usg-data",
            upload_metadata_to_bigquery=True,
            trigger_whatsapp_webhook=True,
            whatsapp_webhook_url=(
                "https://n8n.id.spheres.oucru-id.org/webhook/send-usg:test"
            ),
            whatsapp_webhook_api_key="n8n_live_test_key_123456",
            whatsapp_trigger_not_before="2026-10-24T00:00:00+08:00",
        )
        study = {
            "ID": "study-1",
            "PatientMainDicomTags": {
                "PatientName": "SARI^AMIN",
                "PatientID": "7371012345678901",
            },
            "MainDicomTags": {"StudyInstanceUID": "1.2.3"},
            "RequestedTags": {
                "AccessionNumber": "081234567890",
                "PatientComments": "DR BUDI",
            },
        }
        state = FakeState()
        registry = FakeBigQuery()
        with patch.object(
            bridge, "instance_references", return_value=[("series-1", "instance-1")]
        ), patch.object(bridge, "image_candidates", return_value=([(
            "series-1", "instance-1", {"SOPInstanceUID": "1.2.3.1"}, 0
        )], 0)):
            bridge.sync_study(
                config,
                object(),
                None,
                object(),
                state,
                study,
                bigquery=registry,
                whatsapp=FakeWhatsApp(),
            )

        self.assertEqual(state.marked, [])
        self.assertEqual(registry.statuses, ["FAILED"])


if __name__ == "__main__":
    unittest.main()
