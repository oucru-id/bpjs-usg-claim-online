from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest

from google.cloud import bigquery


MODULE_PATH = Path(__file__).resolve().parents[1] / "bigquery_registry.py"
SPEC = importlib.util.spec_from_file_location("bpjs_bigquery_registry", MODULE_PATH)
assert SPEC and SPEC.loader
registry_module = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = registry_module
SPEC.loader.exec_module(registry_module)


class BigQuerySchemaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.registry = object.__new__(registry_module.BigQueryRegistry)
        self.registry.bigquery = bigquery
        self.registry.studies_ref = "project.dicom_usg.studies"
        self.registry.files_ref = "project.dicom_usg.study_files"
        self.registry.deliveries_ref = "project.dicom_usg.whatsapp_deliveries"
        self.registry.whatsapp_view_ref = "project.dicom_usg.v_whatsapp_delivery_reference"

    def test_studies_schema_keeps_raw_values_and_provenance(self) -> None:
        fields = {item.name: (item.field_type, item.mode) for item in self.registry._studies_schema()}
        for name in (
            "patient_name", "patient_nik", "patient_phone", "patient_phone_e164",
            "doctor_name", "patient_id_raw", "accession_number_raw", "patient_comments_raw",
            "identity_status", "whatsapp_ready", "gcs_uri_prefix",
        ):
            self.assertIn(name, fields)
        self.assertEqual(fields["metadata_warnings"], ("STRING", "REPEATED"))
        self.assertEqual(fields["nik_sources"], ("STRING", "REPEATED"))

    def test_files_schema_uses_one_row_per_private_object(self) -> None:
        fields = {item.name for item in self.registry._files_schema()}
        self.assertTrue({"study_key", "file_type", "object_name", "gcs_uri", "sha256"} <= fields)

    def test_whatsapp_schema_keeps_explicit_single_photo_selection(self) -> None:
        fields = {item.name: (item.field_type, item.mode) for item in self.registry._deliveries_schema()}
        self.assertEqual(fields["selected_object_keys"], ("STRING", "REPEATED"))
        self.assertIn("request_token", fields)
        self.assertIn("sent_at", fields)

    def test_auto_outbox_sql_selects_one_photo_and_blocks_duplicates(self) -> None:
        sql = self.registry._acquire_auto_delivery_sql()
        self.assertIn("image_count=1", sql)
        self.assertIn("selected_object_keys=[@object_key]", sql)
        self.assertIn("existing_key=@object_key", sql)
        self.assertIn("ORTHANC_BRIDGE_AUTO", sql)

    def test_whatsapp_view_uses_manual_compatible_reference_and_stable_first_photo(self) -> None:
        sql = self.registry._whatsapp_view_select_sql()
        self.assertIn("CONCAT('WA_'", sql)
        self.assertIn("CONCAT(s.study_key, '|', f.object_key)", sql)
        self.assertIn("ORDER BY f.sequence_number, COALESCE(f.frame_index, 0), f.object_key", sql)
        self.assertIn("r'^\\+628[0-9]{8,11}$'", sql)

    def test_upsert_is_idempotent_and_replaces_file_rows_for_one_study(self) -> None:
        sql = self.registry._upsert_sql()
        self.assertIn("MERGE `project.dicom_usg.studies`", sql)
        self.assertIn("DELETE FROM `project.dicom_usg.study_files`", sql)
        self.assertIn("INSERT INTO `project.dicom_usg.study_files`", sql)
        self.assertIn("PARSE_JSON(@study_json)", sql)
        self.assertIn("PARSE_JSON(@files_json)", sql)
        self.assertNotIn("https://storage.googleapis.com", sql)


if __name__ == "__main__":
    unittest.main()
