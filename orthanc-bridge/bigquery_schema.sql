-- Jalankan sebagai GoogleSQL di BigQuery Console.
-- Project : stellar-orb-451904-d9
-- Region  : asia-southeast2 (Jakarta)

CREATE SCHEMA IF NOT EXISTS `stellar-orb-451904-d9.dicom_usg`
OPTIONS (
  location = 'asia-southeast2',
  description = 'Registri privat metadata studi USG dan referensi objek GCS.',
  labels = [('application', 'bpjs-usg'), ('data_class', 'restricted')]
);

CREATE TABLE IF NOT EXISTS `stellar-orb-451904-d9.dicom_usg.studies` (
  study_key STRING NOT NULL,
  bridge_id STRING NOT NULL,
  orthanc_study_id STRING,
  study_instance_uid STRING,
  patient_name STRING,
  patient_nik STRING,
  patient_phone STRING,
  patient_phone_e164 STRING,
  doctor_name STRING,
  identity_status STRING NOT NULL,
  metadata_warnings ARRAY<STRING>,
  nik_sources ARRAY<STRING>,
  phone_sources ARRAY<STRING>,
  doctor_sources ARRAY<STRING>,
  patient_id_raw STRING,
  accession_number_raw STRING,
  patient_comments_raw STRING,
  patient_birth_date DATE,
  study_date DATE,
  study_time TIME,
  study_datetime_local DATETIME,
  study_timezone STRING,
  study_description STRING,
  modality STRING,
  institution_name STRING,
  station_name STRING,
  gcs_bucket STRING NOT NULL,
  gcs_study_prefix STRING NOT NULL,
  gcs_uri_prefix STRING NOT NULL,
  jpeg_count INT64 NOT NULL,
  dicom_count INT64 NOT NULL,
  whatsapp_ready BOOL NOT NULL,
  whatsapp_block_reasons ARRAY<STRING>,
  metadata_parser_version STRING NOT NULL,
  first_seen_at TIMESTAMP NOT NULL,
  gcs_completed_at TIMESTAMP,
  bigquery_synced_at TIMESTAMP NOT NULL
)
CLUSTER BY study_key, patient_nik, identity_status
OPTIONS (
  description = 'Satu baris per studi DICOM USG; berisi identitas terinterpretasi, nilai mentah, status, dan ringkasan file.'
);

CREATE TABLE IF NOT EXISTS `stellar-orb-451904-d9.dicom_usg.study_files` (
  object_key STRING NOT NULL,
  study_key STRING NOT NULL,
  file_type STRING NOT NULL,
  sequence_number INT64 NOT NULL,
  frame_index INT64,
  source_series_id STRING,
  source_instance_id STRING,
  sop_instance_uid STRING,
  gcs_bucket STRING NOT NULL,
  object_name STRING NOT NULL,
  gcs_uri STRING NOT NULL,
  content_type STRING NOT NULL,
  size_bytes INT64 NOT NULL,
  sha256 STRING NOT NULL,
  gcs_observed_at TIMESTAMP NOT NULL,
  bigquery_synced_at TIMESTAMP NOT NULL
)
CLUSTER BY study_key, file_type
OPTIONS (
  description = 'Satu baris per objek DICOM atau JPEG di GCS; banyak file tetap menjadi banyak baris, bukan banyak URL dalam satu sel.'
);

CREATE TABLE IF NOT EXISTS `stellar-orb-451904-d9.dicom_usg.whatsapp_deliveries` (
  delivery_reference_id STRING NOT NULL,
  study_key STRING NOT NULL,
  request_source STRING NOT NULL,
  requested_by STRING,
  requested_at TIMESTAMP NOT NULL,
  status STRING NOT NULL,
  attempt_count INT64 NOT NULL,
  image_count INT64 NOT NULL,
  selected_object_keys ARRAY<STRING>,
  destination_masked STRING,
  provider STRING,
  provider_message_ids ARRAY<STRING>,
  last_attempt_at TIMESTAMP,
  sent_at TIMESTAMP,
  delivered_at TIMESTAMP,
  updated_at TIMESTAMP NOT NULL,
  last_error STRING,
  request_token STRING
)
CLUSTER BY study_key, status
OPTIONS (
  description = 'Outbox pengiriman foto USG melalui WhatsApp; satu baris per pilihan foto dengan delivery_reference_id stabil.'
);

-- Migrasi aman untuk tabel yang sudah dibuat oleh versi 7.1.
ALTER TABLE `stellar-orb-451904-d9.dicom_usg.whatsapp_deliveries`
ADD COLUMN IF NOT EXISTS selected_object_keys ARRAY<STRING>;

-- Kandidat privat untuk WhatsApp. OrthancBridge hanya mengambil image_position=1;
-- foto lain tetap tersedia untuk pilihan manual di web app.
CREATE OR REPLACE VIEW `stellar-orb-451904-d9.dicom_usg.v_whatsapp_delivery_reference` AS
WITH eligible_images AS (
  SELECT
    CONCAT(
      'WA_',
      SUBSTR(
        LOWER(TO_HEX(SHA256(CONCAT(s.study_key, '|', f.object_key)))),
        1,
        40
      )
    ) AS delivery_reference_id,
    s.study_key,
    s.bridge_id,
    s.orthanc_study_id,
    s.study_instance_uid,
    s.patient_name,
    s.patient_nik,
    s.patient_phone,
    s.patient_phone_e164,
    REGEXP_REPLACE(s.patient_phone_e164, r'^\+', '') AS whatsapp_to,
    s.doctor_name,
    s.study_date,
    s.study_time,
    s.study_datetime_local,
    s.study_timezone,
    s.study_description,
    s.institution_name,
    f.object_key,
    f.sequence_number AS source_sequence_number,
    f.frame_index,
    f.gcs_bucket,
    f.object_name,
    f.gcs_uri,
    f.content_type,
    f.size_bytes,
    f.sha256,
    ROW_NUMBER() OVER (
      PARTITION BY s.study_key
      ORDER BY f.sequence_number, COALESCE(f.frame_index, 0), f.object_key
    ) AS image_position,
    COUNT(*) OVER (PARTITION BY s.study_key) AS total_images,
    s.first_seen_at,
    s.gcs_completed_at,
    s.bigquery_synced_at AS study_synced_at,
    f.gcs_observed_at,
    f.bigquery_synced_at AS file_synced_at
  FROM `stellar-orb-451904-d9.dicom_usg.studies` AS s
  JOIN `stellar-orb-451904-d9.dicom_usg.study_files` AS f
    ON f.study_key = s.study_key
  WHERE s.whatsapp_ready = TRUE
    AND s.identity_status = 'READY'
    AND s.patient_name IS NOT NULL
    AND TRIM(s.patient_name) != ''
    AND s.doctor_name IS NOT NULL
    AND TRIM(s.doctor_name) != ''
    AND s.patient_phone_e164 IS NOT NULL
    AND REGEXP_CONTAINS(s.patient_phone_e164, r'^\+628[0-9]{8,11}$')
    AND f.file_type = 'JPEG'
    AND f.content_type = 'image/jpeg'
    AND STARTS_WITH(f.gcs_uri, 'gs://')
)
SELECT
  *,
  image_position = total_images AS is_last_image
FROM eligible_images;

-- Pemeriksaan hasil. Nilai yang diharapkan: 3 tabel dan 1 view.
SELECT table_name
FROM `stellar-orb-451904-d9.dicom_usg.INFORMATION_SCHEMA.TABLES`
WHERE table_name IN (
  'studies',
  'study_files',
  'whatsapp_deliveries',
  'v_whatsapp_delivery_reference'
)
ORDER BY table_name;
