from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any
import uuid


class BigQueryRegistryError(RuntimeError):
    pass


class BigQueryRegistry:
    def __init__(
        self,
        *,
        credentials_path: Path,
        project_id: str,
        dataset_id: str,
        location: str,
        studies_table: str,
        files_table: str,
        deliveries_table: str = "whatsapp_deliveries",
        whatsapp_view: str = "v_whatsapp_delivery_reference",
        require_whatsapp: bool = False,
    ) -> None:
        try:
            from google.cloud import bigquery
            from google.api_core.exceptions import NotFound
        except ImportError as exc:
            raise BigQueryRegistryError(
                "Paket google-cloud-bigquery belum terpasang. Jalankan setup.ps1 kembali."
            ) from exc

        for value, label, pattern in (
            (project_id, "bigquery_project", r"[a-z][a-z0-9-]{4,61}[a-z0-9]"),
            (dataset_id, "bigquery_dataset", r"[A-Za-z_][A-Za-z0-9_]{0,1023}"),
            (studies_table, "bigquery_studies_table", r"[A-Za-z_][A-Za-z0-9_]{0,1023}"),
            (files_table, "bigquery_files_table", r"[A-Za-z_][A-Za-z0-9_]{0,1023}"),
            (deliveries_table, "bigquery_deliveries_table", r"[A-Za-z_][A-Za-z0-9_]{0,1023}"),
            (whatsapp_view, "bigquery_whatsapp_view", r"[A-Za-z_][A-Za-z0-9_]{0,1023}"),
            (location, "bigquery_location", r"[A-Za-z0-9-]{2,40}"),
        ):
            if not re.fullmatch(pattern, value or ""):
                raise BigQueryRegistryError(f"{label} tidak valid.")
        if len({studies_table, files_table, deliveries_table, whatsapp_view}) != 4:
            raise BigQueryRegistryError("Nama tabel/view BigQuery harus berbeda.")
        if not credentials_path.is_file():
            raise BigQueryRegistryError(f"Credential BigQuery tidak ditemukan: {credentials_path}")

        try:
            self.client = bigquery.Client.from_service_account_json(
                str(credentials_path), project=project_id
            )
        except Exception as exc:
            raise BigQueryRegistryError("Credential service account BigQuery tidak dapat dibaca.") from exc
        self.bigquery = bigquery
        self.not_found = NotFound
        self.project_id = project_id
        self.dataset_id = dataset_id
        self.location = location
        self.studies_table = studies_table
        self.files_table = files_table
        self.deliveries_table = deliveries_table
        self.whatsapp_view = whatsapp_view
        self.require_whatsapp = require_whatsapp
        self.dataset_ref = f"{project_id}.{dataset_id}"
        self.studies_ref = f"{self.dataset_ref}.{studies_table}"
        self.files_ref = f"{self.dataset_ref}.{files_table}"
        self.deliveries_ref = f"{self.dataset_ref}.{deliveries_table}"
        self.whatsapp_view_ref = f"{self.dataset_ref}.{whatsapp_view}"

    def close(self) -> None:
        close = getattr(self.client, "close", None)
        if callable(close):
            close()

    def provision(self) -> None:
        bigquery = self.bigquery
        dataset = bigquery.Dataset(self.dataset_ref)
        dataset.location = self.location
        dataset.description = (
            "Registri privat metadata studi DICOM USG dan referensi objek GCS. "
            "Berisi data pasien; batasi IAM berdasarkan kebutuhan tugas."
        )
        dataset.labels = {"application": "bpjs-usg", "data_class": "restricted"}
        try:
            try:
                created_dataset = self.client.get_dataset(self.dataset_ref)
            except self.not_found:
                created_dataset = self.client.create_dataset(dataset)
        except Exception as exc:
            raise BigQueryRegistryError("Dataset BigQuery tidak dapat dibuat atau dibaca.") from exc
        if str(created_dataset.location or "").lower() != self.location.lower():
            raise BigQueryRegistryError(
                f"Lokasi dataset {self.dataset_ref} bukan {self.location}."
            )

        studies = bigquery.Table(self.studies_ref, schema=self._studies_schema())
        studies.description = "Satu baris per studi USG dengan metadata DICOM dan status kesiapan WhatsApp."
        studies.clustering_fields = ["study_key", "patient_nik", "identity_status"]
        files = bigquery.Table(self.files_ref, schema=self._files_schema())
        files.description = "Satu baris per objek DICOM atau JPEG privat di Google Cloud Storage."
        files.clustering_fields = ["study_key", "file_type"]
        deliveries = bigquery.Table(self.deliveries_ref, schema=self._deliveries_schema())
        deliveries.description = (
            "Outbox pengiriman foto USG melalui WhatsApp dengan pilihan object key eksplisit."
        )
        deliveries.clustering_fields = ["study_key", "status"]
        try:
            self.client.create_table(studies, exists_ok=True)
            self.client.create_table(files, exists_ok=True)
            if self.require_whatsapp:
                self.client.create_table(deliveries, exists_ok=True)
                self.client.query(
                    f"ALTER TABLE `{self.deliveries_ref}` "
                    "ADD COLUMN IF NOT EXISTS selected_object_keys ARRAY<STRING>",
                    location=self.location,
                ).result(timeout=120)
                self.client.query(
                    f"CREATE OR REPLACE VIEW `{self.whatsapp_view_ref}` AS\n"
                    + self._whatsapp_view_select_sql(),
                    location=self.location,
                ).result(timeout=120)
        except Exception as exc:
            raise BigQueryRegistryError("Tabel/view registri BigQuery tidak dapat dibuat.") from exc
        self.verify_ready()

    def verify_ready(self) -> None:
        try:
            dataset = self.client.get_dataset(self.dataset_ref)
            studies = self.client.get_table(self.studies_ref)
            files = self.client.get_table(self.files_ref)
        except Exception as exc:
            raise BigQueryRegistryError(
                "Dataset/tabel BigQuery belum tersedia. Jalankan bridge.py --provision-bigquery."
            ) from exc
        if str(dataset.location or "").lower() != self.location.lower():
            raise BigQueryRegistryError(
                f"Lokasi dataset {self.dataset_ref} bukan {self.location}."
            )
        self._validate_schema(studies, self._studies_schema())
        self._validate_schema(files, self._files_schema())
        if self.require_whatsapp:
            try:
                deliveries = self.client.get_table(self.deliveries_ref)
                whatsapp_view = self.client.get_table(self.whatsapp_view_ref)
            except Exception as exc:
                raise BigQueryRegistryError(
                    "Tabel outbox atau view kandidat WhatsApp belum tersedia. "
                    "Jalankan migrasi bigquery_schema.sql sebelum mengaktifkan trigger."
                ) from exc
            self._validate_schema(deliveries, self._deliveries_schema())
            self._validate_schema(whatsapp_view, self._whatsapp_view_schema())
            view_definition = str(getattr(whatsapp_view, "view_query", "") or "")
            if (
                "'WA_'" not in view_definition
                or "ROW_NUMBER()" not in view_definition
                or "f.object_key" not in view_definition
            ):
                raise BigQueryRegistryError(
                    "View kandidat WhatsApp belum memakai kontrak satu-foto terbaru. "
                    "Jalankan migrasi bigquery_schema.sql sebelum mengaktifkan trigger."
                )

    def upsert_study(self, study: dict[str, Any], files: list[dict[str, Any]]) -> None:
        if not study.get("study_key"):
            raise BigQueryRegistryError("study_key wajib tersedia untuk sinkronisasi BigQuery.")
        if not files:
            raise BigQueryRegistryError("Sedikitnya satu objek GCS wajib tersedia untuk registri BigQuery.")
        if any(item.get("study_key") != study["study_key"] for item in files):
            raise BigQueryRegistryError("study_key pada daftar file tidak konsisten.")
        query = self._upsert_sql()
        job_config = self.bigquery.QueryJobConfig(
            query_parameters=[
                self.bigquery.ScalarQueryParameter(
                    "study_json", "STRING", json.dumps(study, ensure_ascii=False, separators=(",", ":"))
                ),
                self.bigquery.ScalarQueryParameter(
                    "files_json", "STRING", json.dumps(files, ensure_ascii=False, separators=(",", ":"))
                ),
            ]
        )
        try:
            self.client.query(query, job_config=job_config, location=self.location).result(timeout=120)
        except Exception as exc:
            raise BigQueryRegistryError("Metadata studi tidak dapat disinkronkan ke BigQuery.") from exc

    def get_auto_whatsapp_candidate(self, study_key: str, bridge_id: str) -> dict[str, Any] | None:
        if not re.fullmatch(r"[A-Za-z0-9._-]{3,128}", study_key or ""):
            raise BigQueryRegistryError("study_key kandidat WhatsApp tidak valid.")
        if not re.fullmatch(r"[A-Za-z0-9._-]{3,80}", bridge_id or ""):
            raise BigQueryRegistryError("bridge_id kandidat WhatsApp tidak valid.")
        query = f"""
SELECT delivery_reference_id, study_key, bridge_id, patient_name, patient_phone_e164,
  doctor_name, object_key, source_sequence_number, frame_index
FROM `{self.whatsapp_view_ref}`
WHERE study_key=@study_key AND bridge_id=@bridge_id AND image_position=1
ORDER BY source_sequence_number, COALESCE(frame_index, 0), object_key
LIMIT 1
"""
        parameters = [
            self.bigquery.ScalarQueryParameter("study_key", "STRING", study_key),
            self.bigquery.ScalarQueryParameter("bridge_id", "STRING", bridge_id),
        ]
        try:
            rows = list(self.client.query(
                query,
                job_config=self.bigquery.QueryJobConfig(query_parameters=parameters),
                location=self.location,
            ).result(timeout=60))
        except Exception as exc:
            raise BigQueryRegistryError("Kandidat WhatsApp tidak dapat dibaca dari BigQuery.") from exc
        if not rows:
            return None
        candidate = dict(rows[0].items())
        if not re.fullmatch(r"WA_[0-9a-f]{40}", str(candidate.get("delivery_reference_id") or "")):
            raise BigQueryRegistryError(
                "View WhatsApp belum memakai delivery_reference_id batch yang kompatibel."
            )
        if not re.fullmatch(r"[0-9a-f]{64}", str(candidate.get("object_key") or "")):
            raise BigQueryRegistryError("object_key kandidat WhatsApp tidak valid.")
        if not re.fullmatch(r"\+628[0-9]{8,11}", str(candidate.get("patient_phone_e164") or "")):
            raise BigQueryRegistryError("Nomor WhatsApp kandidat BigQuery tidak valid.")
        if not str(candidate.get("patient_name") or "").strip():
            raise BigQueryRegistryError("Nama pasien kandidat BigQuery tidak tersedia.")
        if not str(candidate.get("doctor_name") or "").strip():
            raise BigQueryRegistryError("Nama dokter kandidat BigQuery tidak tersedia.")
        return candidate

    def acquire_auto_whatsapp_delivery(self, candidate: dict[str, Any]) -> dict[str, Any]:
        reference_id = str(candidate.get("delivery_reference_id") or "")
        study_key = str(candidate.get("study_key") or "")
        object_key = str(candidate.get("object_key") or "")
        phone = str(candidate.get("patient_phone_e164") or "")
        request_token = str(uuid.uuid4())
        destination_masked = self._mask_phone(phone)
        query = self._acquire_auto_delivery_sql()
        parameters = [
            self.bigquery.ScalarQueryParameter("delivery_reference_id", "STRING", reference_id),
            self.bigquery.ScalarQueryParameter("study_key", "STRING", study_key),
            self.bigquery.ScalarQueryParameter("object_key", "STRING", object_key),
            self.bigquery.ScalarQueryParameter("destination_masked", "STRING", destination_masked),
            self.bigquery.ScalarQueryParameter("request_token", "STRING", request_token),
        ]
        try:
            rows = list(self.client.query(
                query,
                job_config=self.bigquery.QueryJobConfig(query_parameters=parameters),
                location=self.location,
            ).result(timeout=60))
        except Exception as exc:
            raise BigQueryRegistryError("Outbox WhatsApp otomatis tidak dapat diperoleh.") from exc
        if not rows:
            raise BigQueryRegistryError("Outbox WhatsApp otomatis tidak terbentuk.")
        current = dict(rows[0].items())
        status = str(current.get("status") or "").upper()
        if str(current.get("request_token") or "") == request_token and status == "REQUESTED":
            return {"state": "ACQUIRED", "request_token": request_token, **candidate}
        if current.get("sent_at") or status in {"SENT", "DELIVERED", "READ"}:
            return {"state": "ALREADY_SENT", **candidate}
        if status in {"REQUESTED", "QUEUED", "PROCESSING"}:
            return {"state": "PENDING", **candidate}
        raise BigQueryRegistryError("Outbox WhatsApp otomatis berada pada status yang tidak dapat dipakai.")

    def _acquire_auto_delivery_sql(self) -> str:
        return f"""
DECLARE has_blocking_delivery BOOL DEFAULT FALSE;

BEGIN TRANSACTION;

SET has_blocking_delivery = (
  SELECT COUNT(*) > 0
  FROM `{self.deliveries_ref}` existing,
    UNNEST(IFNULL(existing.selected_object_keys, ARRAY<STRING>[])) existing_key
  WHERE existing.study_key=@study_key AND existing_key=@object_key
    AND (existing.sent_at IS NOT NULL
      OR UPPER(COALESCE(existing.status, '')) IN ('SENT','DELIVERED','READ')
      OR (UPPER(COALESCE(existing.status, '')) IN ('REQUESTED','QUEUED','PROCESSING')
        AND existing.updated_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 15 MINUTE)))
);

IF NOT has_blocking_delivery THEN
MERGE `{self.deliveries_ref}` target
USING (SELECT @delivery_reference_id AS delivery_reference_id, @study_key AS study_key) source
ON target.delivery_reference_id=source.delivery_reference_id
WHEN MATCHED AND target.study_key=source.study_key AND target.sent_at IS NULL
  AND (UPPER(target.status) IN ('FAILED','REJECTED','CANCELLED')
    OR (UPPER(target.status) IN ('REQUESTED','QUEUED')
      AND target.updated_at < TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 15 MINUTE))) THEN
  UPDATE SET status='REQUESTED', request_source='ORTHANC_BRIDGE_AUTO', requested_by=NULL,
    requested_at=CURRENT_TIMESTAMP(), updated_at=CURRENT_TIMESTAMP(),
    last_attempt_at=CURRENT_TIMESTAMP(), last_error=NULL,
    attempt_count=COALESCE(target.attempt_count, 0)+1, request_token=@request_token,
    image_count=1, selected_object_keys=[@object_key], destination_masked=@destination_masked
WHEN NOT MATCHED AND NOT EXISTS (
  SELECT 1 FROM `{self.deliveries_ref}` existing,
    UNNEST(IFNULL(existing.selected_object_keys, ARRAY<STRING>[])) existing_key
  WHERE existing.study_key=@study_key AND existing_key=@object_key
    AND (existing.sent_at IS NOT NULL
      OR UPPER(COALESCE(existing.status, '')) IN ('SENT','DELIVERED','READ')
      OR (UPPER(COALESCE(existing.status, '')) IN ('REQUESTED','QUEUED','PROCESSING')
        AND existing.updated_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 15 MINUTE)))
) THEN
  INSERT (delivery_reference_id, study_key, request_source, requested_by, requested_at,
    status, attempt_count, image_count, selected_object_keys, destination_masked,
    last_attempt_at, updated_at, request_token)
  VALUES (@delivery_reference_id, @study_key, 'ORTHANC_BRIDGE_AUTO', NULL,
    CURRENT_TIMESTAMP(), 'REQUESTED', 1, 1, [@object_key], @destination_masked,
    CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP(), @request_token);
END IF;

COMMIT TRANSACTION;

SELECT delivery_reference_id, status, sent_at, request_token
FROM `{self.deliveries_ref}`
WHERE study_key=@study_key AND (
  delivery_reference_id=@delivery_reference_id
  OR @object_key IN UNNEST(IFNULL(selected_object_keys, ARRAY<STRING>[]))
)
ORDER BY
  CASE
    WHEN sent_at IS NOT NULL OR UPPER(COALESCE(status, '')) IN ('SENT','DELIVERED','READ') THEN 0
    WHEN UPPER(COALESCE(status, '')) IN ('REQUESTED','QUEUED','PROCESSING')
      AND updated_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 15 MINUTE) THEN 1
    WHEN delivery_reference_id=@delivery_reference_id THEN 2
    ELSE 3
  END,
  COALESCE(updated_at, requested_at) DESC
LIMIT 1;
"""

    def update_auto_whatsapp_delivery(
        self,
        delivery_reference_id: str,
        request_token: str,
        status: str,
        error_message: str = "",
    ) -> None:
        if status not in {"QUEUED", "FAILED"}:
            raise BigQueryRegistryError("Status outbox WhatsApp otomatis tidak valid.")
        query = f"""
UPDATE `{self.deliveries_ref}`
SET status=@status, updated_at=CURRENT_TIMESTAMP(), last_error=@last_error
WHERE delivery_reference_id=@delivery_reference_id
  AND request_token=@request_token AND status='REQUESTED'
"""
        parameters = [
            self.bigquery.ScalarQueryParameter("status", "STRING", status),
            self.bigquery.ScalarQueryParameter("last_error", "STRING", str(error_message or "")[:180]),
            self.bigquery.ScalarQueryParameter("delivery_reference_id", "STRING", delivery_reference_id),
            self.bigquery.ScalarQueryParameter("request_token", "STRING", request_token),
        ]
        try:
            self.client.query(
                query,
                job_config=self.bigquery.QueryJobConfig(query_parameters=parameters),
                location=self.location,
            ).result(timeout=60)
        except Exception as exc:
            raise BigQueryRegistryError("Status outbox WhatsApp otomatis gagal diperbarui.") from exc

    @staticmethod
    def _mask_phone(value: str) -> str:
        digits = re.sub(r"\D", "", value or "")
        if not digits:
            return ""
        hidden = "*" * max(len(digits) - 7, 1)
        return digits[:4] + hidden + digits[-3:]

    def _studies_schema(self) -> list[Any]:
        field = self.bigquery.SchemaField
        return [
            field("study_key", "STRING", mode="REQUIRED"),
            field("bridge_id", "STRING", mode="REQUIRED"),
            field("orthanc_study_id", "STRING"),
            field("study_instance_uid", "STRING"),
            field("patient_name", "STRING"),
            field("patient_nik", "STRING"),
            field("patient_phone", "STRING"),
            field("patient_phone_e164", "STRING"),
            field("doctor_name", "STRING"),
            field("identity_status", "STRING", mode="REQUIRED"),
            field("metadata_warnings", "STRING", mode="REPEATED"),
            field("nik_sources", "STRING", mode="REPEATED"),
            field("phone_sources", "STRING", mode="REPEATED"),
            field("doctor_sources", "STRING", mode="REPEATED"),
            field("patient_id_raw", "STRING"),
            field("accession_number_raw", "STRING"),
            field("patient_comments_raw", "STRING"),
            field("patient_birth_date", "DATE"),
            field("study_date", "DATE"),
            field("study_time", "TIME"),
            field("study_datetime_local", "DATETIME"),
            field("study_timezone", "STRING"),
            field("study_description", "STRING"),
            field("modality", "STRING"),
            field("institution_name", "STRING"),
            field("station_name", "STRING"),
            field("gcs_bucket", "STRING", mode="REQUIRED"),
            field("gcs_study_prefix", "STRING", mode="REQUIRED"),
            field("gcs_uri_prefix", "STRING", mode="REQUIRED"),
            field("jpeg_count", "INTEGER", mode="REQUIRED"),
            field("dicom_count", "INTEGER", mode="REQUIRED"),
            field("whatsapp_ready", "BOOLEAN", mode="REQUIRED"),
            field("whatsapp_block_reasons", "STRING", mode="REPEATED"),
            field("metadata_parser_version", "STRING", mode="REQUIRED"),
            field("first_seen_at", "TIMESTAMP", mode="REQUIRED"),
            field("gcs_completed_at", "TIMESTAMP"),
            field("bigquery_synced_at", "TIMESTAMP", mode="REQUIRED"),
        ]

    def _files_schema(self) -> list[Any]:
        field = self.bigquery.SchemaField
        return [
            field("object_key", "STRING", mode="REQUIRED"),
            field("study_key", "STRING", mode="REQUIRED"),
            field("file_type", "STRING", mode="REQUIRED"),
            field("sequence_number", "INTEGER", mode="REQUIRED"),
            field("frame_index", "INTEGER"),
            field("source_series_id", "STRING"),
            field("source_instance_id", "STRING"),
            field("sop_instance_uid", "STRING"),
            field("gcs_bucket", "STRING", mode="REQUIRED"),
            field("object_name", "STRING", mode="REQUIRED"),
            field("gcs_uri", "STRING", mode="REQUIRED"),
            field("content_type", "STRING", mode="REQUIRED"),
            field("size_bytes", "INTEGER", mode="REQUIRED"),
            field("sha256", "STRING", mode="REQUIRED"),
            field("gcs_observed_at", "TIMESTAMP", mode="REQUIRED"),
            field("bigquery_synced_at", "TIMESTAMP", mode="REQUIRED"),
        ]

    def _deliveries_schema(self) -> list[Any]:
        field = self.bigquery.SchemaField
        return [
            field("delivery_reference_id", "STRING", mode="REQUIRED"),
            field("study_key", "STRING", mode="REQUIRED"),
            field("request_source", "STRING", mode="REQUIRED"),
            field("requested_by", "STRING"),
            field("requested_at", "TIMESTAMP", mode="REQUIRED"),
            field("status", "STRING", mode="REQUIRED"),
            field("attempt_count", "INTEGER", mode="REQUIRED"),
            field("image_count", "INTEGER", mode="REQUIRED"),
            field("selected_object_keys", "STRING", mode="REPEATED"),
            field("destination_masked", "STRING"),
            field("provider", "STRING"),
            field("provider_message_ids", "STRING", mode="REPEATED"),
            field("last_attempt_at", "TIMESTAMP"),
            field("sent_at", "TIMESTAMP"),
            field("delivered_at", "TIMESTAMP"),
            field("updated_at", "TIMESTAMP", mode="REQUIRED"),
            field("last_error", "STRING"),
            field("request_token", "STRING"),
        ]

    def _whatsapp_view_schema(self) -> list[Any]:
        field = self.bigquery.SchemaField
        return [
            field("delivery_reference_id", "STRING"),
            field("study_key", "STRING"),
            field("bridge_id", "STRING"),
            field("patient_name", "STRING"),
            field("patient_phone_e164", "STRING"),
            field("doctor_name", "STRING"),
            field("object_key", "STRING"),
            field("source_sequence_number", "INTEGER"),
            field("frame_index", "INTEGER"),
            field("image_position", "INTEGER"),
        ]

    def _whatsapp_view_select_sql(self) -> str:
        return f"""
WITH eligible_images AS (
  SELECT
    CONCAT('WA_', SUBSTR(LOWER(TO_HEX(SHA256(CONCAT(s.study_key, '|', f.object_key)))), 1, 40))
      AS delivery_reference_id,
    s.study_key, s.bridge_id, s.orthanc_study_id, s.study_instance_uid,
    s.patient_name, s.patient_nik, s.patient_phone, s.patient_phone_e164,
    REGEXP_REPLACE(s.patient_phone_e164, r'^\\+', '') AS whatsapp_to,
    s.doctor_name, s.study_date, s.study_time, s.study_datetime_local,
    s.study_timezone, s.study_description, s.institution_name,
    f.object_key, f.sequence_number AS source_sequence_number, f.frame_index,
    f.gcs_bucket, f.object_name, f.gcs_uri, f.content_type, f.size_bytes, f.sha256,
    ROW_NUMBER() OVER (
      PARTITION BY s.study_key
      ORDER BY f.sequence_number, COALESCE(f.frame_index, 0), f.object_key
    ) AS image_position,
    COUNT(*) OVER (PARTITION BY s.study_key) AS total_images,
    s.first_seen_at, s.gcs_completed_at, s.bigquery_synced_at AS study_synced_at,
    f.gcs_observed_at, f.bigquery_synced_at AS file_synced_at
  FROM `{self.studies_ref}` s
  JOIN `{self.files_ref}` f ON f.study_key=s.study_key
  WHERE s.whatsapp_ready=TRUE
    AND s.identity_status='READY'
    AND s.patient_name IS NOT NULL AND TRIM(s.patient_name) != ''
    AND s.doctor_name IS NOT NULL AND TRIM(s.doctor_name) != ''
    AND s.patient_phone_e164 IS NOT NULL
    AND REGEXP_CONTAINS(s.patient_phone_e164, r'^\\+628[0-9]{{8,11}}$')
    AND f.file_type='JPEG' AND f.content_type='image/jpeg'
    AND STARTS_WITH(f.gcs_uri, 'gs://')
)
SELECT *, image_position=total_images AS is_last_image
FROM eligible_images
"""

    @staticmethod
    def _validate_schema(table: Any, expected: list[Any]) -> None:
        actual = {item.name: (item.field_type.upper(), item.mode.upper()) for item in table.schema}
        missing_or_changed = [
            item.name for item in expected
            if actual.get(item.name) != (item.field_type.upper(), item.mode.upper())
        ]
        if missing_or_changed:
            raise BigQueryRegistryError(
                "Skema BigQuery tidak sesuai pada kolom: " + ", ".join(missing_or_changed)
            )

    def _upsert_sql(self) -> str:
        studies = f"`{self.studies_ref}`"
        files = f"`{self.files_ref}`"
        return f"""
DECLARE incoming_study JSON DEFAULT PARSE_JSON(@study_json);
DECLARE incoming_files ARRAY<JSON> DEFAULT JSON_QUERY_ARRAY(PARSE_JSON(@files_json));

BEGIN TRANSACTION;

MERGE {studies} AS target
USING (
  SELECT
    JSON_VALUE(incoming_study, '$.study_key') AS study_key,
    JSON_VALUE(incoming_study, '$.bridge_id') AS bridge_id,
    JSON_VALUE(incoming_study, '$.orthanc_study_id') AS orthanc_study_id,
    JSON_VALUE(incoming_study, '$.study_instance_uid') AS study_instance_uid,
    JSON_VALUE(incoming_study, '$.patient_name') AS patient_name,
    JSON_VALUE(incoming_study, '$.patient_nik') AS patient_nik,
    JSON_VALUE(incoming_study, '$.patient_phone') AS patient_phone,
    JSON_VALUE(incoming_study, '$.patient_phone_e164') AS patient_phone_e164,
    JSON_VALUE(incoming_study, '$.doctor_name') AS doctor_name,
    JSON_VALUE(incoming_study, '$.identity_status') AS identity_status,
    COALESCE(JSON_VALUE_ARRAY(incoming_study, '$.metadata_warnings'), []) AS metadata_warnings,
    COALESCE(JSON_VALUE_ARRAY(incoming_study, '$.nik_sources'), []) AS nik_sources,
    COALESCE(JSON_VALUE_ARRAY(incoming_study, '$.phone_sources'), []) AS phone_sources,
    COALESCE(JSON_VALUE_ARRAY(incoming_study, '$.doctor_sources'), []) AS doctor_sources,
    JSON_VALUE(incoming_study, '$.patient_id_raw') AS patient_id_raw,
    JSON_VALUE(incoming_study, '$.accession_number_raw') AS accession_number_raw,
    JSON_VALUE(incoming_study, '$.patient_comments_raw') AS patient_comments_raw,
    SAFE_CAST(JSON_VALUE(incoming_study, '$.patient_birth_date') AS DATE) AS patient_birth_date,
    SAFE_CAST(JSON_VALUE(incoming_study, '$.study_date') AS DATE) AS study_date,
    SAFE_CAST(JSON_VALUE(incoming_study, '$.study_time') AS TIME) AS study_time,
    SAFE_CAST(JSON_VALUE(incoming_study, '$.study_datetime_local') AS DATETIME) AS study_datetime_local,
    JSON_VALUE(incoming_study, '$.study_timezone') AS study_timezone,
    JSON_VALUE(incoming_study, '$.study_description') AS study_description,
    JSON_VALUE(incoming_study, '$.modality') AS modality,
    JSON_VALUE(incoming_study, '$.institution_name') AS institution_name,
    JSON_VALUE(incoming_study, '$.station_name') AS station_name,
    JSON_VALUE(incoming_study, '$.gcs_bucket') AS gcs_bucket,
    JSON_VALUE(incoming_study, '$.gcs_study_prefix') AS gcs_study_prefix,
    JSON_VALUE(incoming_study, '$.gcs_uri_prefix') AS gcs_uri_prefix,
    SAFE_CAST(JSON_VALUE(incoming_study, '$.jpeg_count') AS INT64) AS jpeg_count,
    SAFE_CAST(JSON_VALUE(incoming_study, '$.dicom_count') AS INT64) AS dicom_count,
    SAFE_CAST(JSON_VALUE(incoming_study, '$.whatsapp_ready') AS BOOL) AS whatsapp_ready,
    COALESCE(JSON_VALUE_ARRAY(incoming_study, '$.whatsapp_block_reasons'), []) AS whatsapp_block_reasons,
    JSON_VALUE(incoming_study, '$.metadata_parser_version') AS metadata_parser_version,
    SAFE_CAST(JSON_VALUE(incoming_study, '$.gcs_completed_at') AS TIMESTAMP) AS gcs_completed_at
) AS source
ON target.study_key = source.study_key
WHEN MATCHED THEN UPDATE SET
  bridge_id = source.bridge_id,
  orthanc_study_id = source.orthanc_study_id,
  study_instance_uid = source.study_instance_uid,
  patient_name = source.patient_name,
  patient_nik = source.patient_nik,
  patient_phone = source.patient_phone,
  patient_phone_e164 = source.patient_phone_e164,
  doctor_name = source.doctor_name,
  identity_status = source.identity_status,
  metadata_warnings = source.metadata_warnings,
  nik_sources = source.nik_sources,
  phone_sources = source.phone_sources,
  doctor_sources = source.doctor_sources,
  patient_id_raw = source.patient_id_raw,
  accession_number_raw = source.accession_number_raw,
  patient_comments_raw = source.patient_comments_raw,
  patient_birth_date = source.patient_birth_date,
  study_date = source.study_date,
  study_time = source.study_time,
  study_datetime_local = source.study_datetime_local,
  study_timezone = source.study_timezone,
  study_description = source.study_description,
  modality = source.modality,
  institution_name = source.institution_name,
  station_name = source.station_name,
  gcs_bucket = source.gcs_bucket,
  gcs_study_prefix = source.gcs_study_prefix,
  gcs_uri_prefix = source.gcs_uri_prefix,
  jpeg_count = source.jpeg_count,
  dicom_count = source.dicom_count,
  whatsapp_ready = source.whatsapp_ready,
  whatsapp_block_reasons = source.whatsapp_block_reasons,
  metadata_parser_version = source.metadata_parser_version,
  gcs_completed_at = source.gcs_completed_at,
  bigquery_synced_at = CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN INSERT (
  study_key, bridge_id, orthanc_study_id, study_instance_uid, patient_name,
  patient_nik, patient_phone, patient_phone_e164, doctor_name, identity_status,
  metadata_warnings, nik_sources, phone_sources, doctor_sources, patient_id_raw,
  accession_number_raw, patient_comments_raw, patient_birth_date, study_date,
  study_time, study_datetime_local, study_timezone, study_description, modality,
  institution_name, station_name, gcs_bucket, gcs_study_prefix, gcs_uri_prefix,
  jpeg_count, dicom_count, whatsapp_ready, whatsapp_block_reasons,
  metadata_parser_version, first_seen_at, gcs_completed_at, bigquery_synced_at
) VALUES (
  source.study_key, source.bridge_id, source.orthanc_study_id, source.study_instance_uid,
  source.patient_name, source.patient_nik, source.patient_phone, source.patient_phone_e164,
  source.doctor_name, source.identity_status, source.metadata_warnings, source.nik_sources,
  source.phone_sources, source.doctor_sources, source.patient_id_raw,
  source.accession_number_raw, source.patient_comments_raw, source.patient_birth_date,
  source.study_date, source.study_time, source.study_datetime_local, source.study_timezone,
  source.study_description, source.modality, source.institution_name, source.station_name,
  source.gcs_bucket, source.gcs_study_prefix, source.gcs_uri_prefix, source.jpeg_count,
  source.dicom_count, source.whatsapp_ready, source.whatsapp_block_reasons,
  source.metadata_parser_version, CURRENT_TIMESTAMP(), source.gcs_completed_at,
  CURRENT_TIMESTAMP()
);

DELETE FROM {files}
WHERE study_key = JSON_VALUE(incoming_study, '$.study_key');

INSERT INTO {files} (
  object_key, study_key, file_type, sequence_number, frame_index, source_series_id,
  source_instance_id, sop_instance_uid, gcs_bucket, object_name, gcs_uri,
  content_type, size_bytes, sha256, gcs_observed_at, bigquery_synced_at
)
SELECT
  JSON_VALUE(item, '$.object_key'),
  JSON_VALUE(item, '$.study_key'),
  JSON_VALUE(item, '$.file_type'),
  SAFE_CAST(JSON_VALUE(item, '$.sequence_number') AS INT64),
  SAFE_CAST(JSON_VALUE(item, '$.frame_index') AS INT64),
  JSON_VALUE(item, '$.source_series_id'),
  JSON_VALUE(item, '$.source_instance_id'),
  JSON_VALUE(item, '$.sop_instance_uid'),
  JSON_VALUE(item, '$.gcs_bucket'),
  JSON_VALUE(item, '$.object_name'),
  JSON_VALUE(item, '$.gcs_uri'),
  JSON_VALUE(item, '$.content_type'),
  SAFE_CAST(JSON_VALUE(item, '$.size_bytes') AS INT64),
  JSON_VALUE(item, '$.sha256'),
  SAFE_CAST(JSON_VALUE(item, '$.gcs_observed_at') AS TIMESTAMP),
  CURRENT_TIMESTAMP()
FROM UNNEST(incoming_files) AS item;

COMMIT TRANSACTION;
"""
