from __future__ import annotations

import argparse
import base64
import hashlib
import json
import logging
from logging.handlers import RotatingFileHandler
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
import re
import signal
import sys
import time
from typing import Any, Iterable
from urllib.parse import urlparse

import httpx
from PIL import Image, ImageOps


LOGGER = logging.getLogger("orthanc_bridge")
STOP_REQUESTED = False
MAX_UPLOAD_BYTES = 5_750_000
METADATA_PARSER_VERSION = "1.0.0"


class BridgeError(RuntimeError):
    pass


@dataclass(frozen=True)
class BridgeConfig:
    orthanc_url: str
    orthanc_username: str
    orthanc_password: str
    bridge_id: str
    apps_script_url: str = ""
    bridge_key: str = ""
    upload_to_google_drive: bool = True
    upload_to_gcs: bool = False
    gcs_bucket: str = ""
    gcs_credentials_file: str = "gcs-service-account.json"
    gcs_prefix: str = "bpjs-usg"
    upload_metadata_to_bigquery: bool = False
    bigquery_credentials_file: str = "gcs-service-account.json"
    bigquery_project: str = ""
    bigquery_dataset: str = "dicom_usg"
    bigquery_location: str = "asia-southeast2"
    bigquery_studies_table: str = "studies"
    bigquery_files_table: str = "study_files"
    bigquery_deliveries_table: str = "whatsapp_deliveries"
    bigquery_whatsapp_view: str = "v_whatsapp_delivery_reference"
    study_timezone: str = "Asia/Makassar"
    trigger_whatsapp_webhook: bool = False
    whatsapp_webhook_url: str = ""
    whatsapp_webhook_api_key: str = ""
    whatsapp_webhook_timeout_seconds: int = 30
    whatsapp_trigger_not_before: str = ""
    lookback_days: int = 2
    poll_seconds: int = 600
    max_images_per_study: int = 30
    max_frames_per_instance: int = 1
    upload_original_dicoms: bool = True
    max_dicom_instances_per_study: int = 100
    verify_tls: bool = True
    state_file: str = "state.json"
    log_file: str = "logs/orthanc-bridge.log"

    @classmethod
    def load(cls, path: Path) -> "BridgeConfig":
        try:
            values = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise BridgeError(f"Konfigurasi tidak dapat dibaca: {path}") from exc
        if not isinstance(values, dict):
            raise BridgeError("Isi konfigurasi harus berupa objek JSON.")
        try:
            config = cls(**values)
        except TypeError as exc:
            raise BridgeError("Kolom konfigurasi tidak lengkap atau tidak dikenal.") from exc
        config.validate()
        return config

    def validate(self) -> None:
        if not re.fullmatch(r"[A-Za-z0-9._-]{3,80}", self.bridge_id):
            raise BridgeError("bridge_id tidak valid.")
        if not self.upload_to_google_drive and not self.upload_to_gcs:
            raise BridgeError("Aktifkan sedikitnya satu tujuan: Google Drive/web app atau Google Cloud Storage.")
        if self.upload_to_google_drive:
            if not re.fullmatch(r"[0-9a-fA-F]{96}", self.bridge_key):
                raise BridgeError("bridge_key harus berupa kunci 96 karakter dari aplikasi saat Google Drive diaktifkan.")
            endpoint = urlparse(self.apps_script_url)
            if endpoint.scheme != "https" or endpoint.hostname != "script.google.com" or not endpoint.path.endswith("/exec"):
                raise BridgeError("apps_script_url harus berupa URL deployment https://script.google.com yang berakhiran /exec.")
        if self.upload_to_gcs:
            if not re.fullmatch(r"(?=.{3,222}$)[a-z0-9][a-z0-9._-]*[a-z0-9]", self.gcs_bucket):
                raise BridgeError("gcs_bucket tidak valid. Isi nama bucket tanpa awalan gs://.")
            if not self.gcs_credentials_file.strip():
                raise BridgeError("gcs_credentials_file wajib diisi saat GCS diaktifkan.")
            validate_gcs_prefix(self.gcs_prefix)
        if self.upload_metadata_to_bigquery:
            if not self.upload_to_gcs:
                raise BridgeError("Sinkronisasi BigQuery memerlukan upload_to_gcs=true.")
            if not self.bigquery_credentials_file.strip():
                raise BridgeError("bigquery_credentials_file wajib diisi saat BigQuery diaktifkan.")
            if self.bigquery_project and not re.fullmatch(r"[a-z][a-z0-9-]{4,61}[a-z0-9]", self.bigquery_project):
                raise BridgeError("bigquery_project tidak valid.")
            for value, label in (
                (self.bigquery_dataset, "bigquery_dataset"),
                (self.bigquery_studies_table, "bigquery_studies_table"),
                (self.bigquery_files_table, "bigquery_files_table"),
                (self.bigquery_deliveries_table, "bigquery_deliveries_table"),
                (self.bigquery_whatsapp_view, "bigquery_whatsapp_view"),
            ):
                if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,1023}", value):
                    raise BridgeError(f"{label} tidak valid.")
            if len({
                self.bigquery_studies_table,
                self.bigquery_files_table,
                self.bigquery_deliveries_table,
                self.bigquery_whatsapp_view,
            }) != 4:
                raise BridgeError("Nama tabel/view BigQuery harus berbeda.")
            if not re.fullmatch(r"[A-Za-z0-9-]{2,40}", self.bigquery_location):
                raise BridgeError("bigquery_location tidak valid.")
            if not re.fullmatch(r"[A-Za-z_]+(?:/[A-Za-z_]+)*", self.study_timezone):
                raise BridgeError("study_timezone tidak valid.")
        if self.trigger_whatsapp_webhook:
            if not self.upload_metadata_to_bigquery:
                raise BridgeError("Trigger WhatsApp memerlukan upload_metadata_to_bigquery=true.")
            endpoint = urlparse(self.whatsapp_webhook_url)
            if (
                endpoint.scheme != "https"
                or (endpoint.hostname or "").lower() != "n8n.id.spheres.oucru-id.org"
                or not endpoint.path.startswith("/webhook/")
                or endpoint.username
                or endpoint.password
                or endpoint.fragment
            ):
                raise BridgeError(
                    "whatsapp_webhook_url harus berupa production URL HTTPS n8n yang valid."
                )
            api_key = self.whatsapp_webhook_api_key
            if (
                not 16 <= len(api_key) <= 512
                or api_key != api_key.strip()
                or any(ord(character) < 33 or ord(character) == 127 for character in api_key)
            ):
                raise BridgeError("whatsapp_webhook_api_key tidak valid.")
            if not 5 <= self.whatsapp_webhook_timeout_seconds <= 120:
                raise BridgeError("whatsapp_webhook_timeout_seconds harus antara 5 dan 120 detik.")
            try:
                not_before = datetime.fromisoformat(
                    self.whatsapp_trigger_not_before.replace("Z", "+00:00")
                )
            except (AttributeError, ValueError) as exc:
                raise BridgeError("whatsapp_trigger_not_before tidak valid.") from exc
            if not_before.tzinfo is None:
                raise BridgeError("whatsapp_trigger_not_before wajib menyertakan zona waktu.")
        orthanc_endpoint = urlparse(self.orthanc_url)
        if orthanc_endpoint.scheme not in {"http", "https"} or not orthanc_endpoint.hostname:
            raise BridgeError("orthanc_url harus menggunakan HTTP atau HTTPS.")
        if orthanc_endpoint.scheme == "http" and orthanc_endpoint.hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise BridgeError("Orthanc HTTP tanpa enkripsi hanya boleh diakses melalui localhost. Gunakan HTTPS untuk Orthanc di komputer lain.")
        if not self.verify_tls:
            raise BridgeError("verify_tls wajib true untuk melindungi data saat dikirim ke Apps Script.")
        if not 1 <= self.lookback_days <= 30:
            raise BridgeError("lookback_days harus antara 1 dan 30.")
        if not 15 <= self.poll_seconds <= 3600:
            raise BridgeError("poll_seconds harus antara 15 dan 3600 detik.")
        if not 1 <= self.max_images_per_study <= 30:
            raise BridgeError("max_images_per_study harus antara 1 dan 30.")
        if not 1 <= self.max_frames_per_instance <= 30:
            raise BridgeError("max_frames_per_instance harus antara 1 dan 30.")
        if not 1 <= self.max_dicom_instances_per_study <= 1000:
            raise BridgeError("max_dicom_instances_per_study harus antara 1 dan 1000.")


class OrthancClient:
    def __init__(self, config: BridgeConfig):
        auth = None
        if config.orthanc_username:
            auth = httpx.BasicAuth(config.orthanc_username, config.orthanc_password)
        self.client = httpx.Client(
            base_url=config.orthanc_url.rstrip("/"),
            auth=auth,
            timeout=30,
            follow_redirects=True,
        )

    def close(self) -> None:
        self.client.close()

    def system(self) -> dict[str, Any]:
        return self._request("GET", "/system").json()

    def recent_studies(self, start_date: date) -> list[dict[str, Any]]:
        body = {
            "Level": "Study",
            "Query": {"StudyDate": start_date.strftime("%Y%m%d") + "-"},
            "Expand": True,
            "RequestedTags": [
                "PatientName", "PatientID", "PatientComments", "PatientBirthDate", "StudyDate",
                "PatientTelephoneNumbers", "StudyInstanceUID", "StudyTime", "AccessionNumber",
                "StudyDescription", "Modality", "InstitutionName", "StationName",
                "PerformingPhysicianName", "OperatorsName", "ReferringPhysicianName",
            ],
        }
        response = self._request("POST", "/tools/find", json=body, allow_status={400})
        if response.status_code == 400:
            body.pop("RequestedTags")
            response = self._request("POST", "/tools/find", json=body)
        result = response.json()
        if not isinstance(result, list):
            raise BridgeError("Jawaban pencarian Orthanc tidak valid.")
        return result

    def study(self, study_id: str) -> dict[str, Any]:
        return self._request("GET", f"/studies/{study_id}").json()

    def series(self, series_id: str) -> dict[str, Any]:
        return self._request("GET", f"/series/{series_id}").json()

    def instance_tags(self, instance_id: str) -> dict[str, Any]:
        return self._request("GET", f"/instances/{instance_id}/simplified-tags").json()

    def preview(self, instance_id: str, frame_index: int = 0) -> bytes:
        path = (
            f"/instances/{instance_id}/preview?quality=90"
            if frame_index == 0
            else f"/instances/{instance_id}/frames/{frame_index}/preview?quality=90"
        )
        response = self._request("GET", path, headers={"Accept": "image/jpeg"})
        return response.content

    def instance_file(self, instance_id: str) -> bytes:
        response = self._request(
            "GET",
            f"/instances/{instance_id}/file",
            headers={"Accept": "application/dicom"},
        )
        if not response.content:
            raise BridgeError("Orthanc mengembalikan DICOM kosong.")
        return response.content

    def _request(self, method: str, path: str, allow_status: set[int] | None = None, **kwargs: Any) -> httpx.Response:
        try:
            response = self.client.request(method, path, **kwargs)
        except httpx.HTTPError as exc:
            raise BridgeError("Tidak dapat terhubung ke Orthanc lokal.") from exc
        if allow_status and response.status_code in allow_status:
            return response
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise BridgeError(f"Orthanc mengembalikan HTTP {response.status_code} untuk {path}.") from exc
        return response


class AppsScriptClient:
    def __init__(self, config: BridgeConfig):
        self.url = config.apps_script_url
        self.bridge_id = config.bridge_id
        self.bridge_key = config.bridge_key
        self.client = httpx.Client(timeout=90, follow_redirects=True, verify=config.verify_tls)

    def close(self) -> None:
        self.client.close()

    def post(self, action: str, **values: Any) -> dict[str, Any]:
        payload = {"action": action, "bridge_id": self.bridge_id, "bridge_key": self.bridge_key, **values}
        try:
            response = self.client.post(self.url, json=payload)
            response.raise_for_status()
            result = response.json()
        except (httpx.HTTPError, json.JSONDecodeError) as exc:
            raise BridgeError("Tidak dapat mengirim data ke web app Apps Script.") from exc
        if not result.get("success"):
            raise BridgeError(f"Web app menolak permintaan: {result.get('code', 'UNKNOWN')} - {result.get('message', 'tanpa pesan')}")
        return result.get("data") or {}

    def upload_dicom(self, upload_url: str, content: bytes) -> str:
        endpoint = urlparse(upload_url)
        hostname = (endpoint.hostname or "").lower()
        if endpoint.scheme != "https" or not (hostname == "googleapis.com" or hostname.endswith(".googleapis.com")):
            raise BridgeError("URL unggah DICOM dari server Google tidak valid.")
        try:
            response = self.client.put(
                upload_url,
                content=content,
                headers={
                    "Content-Type": "application/dicom",
                    "Content-Length": str(len(content)),
                },
                timeout=600,
            )
            response.raise_for_status()
            result = response.json()
        except (httpx.HTTPError, json.JSONDecodeError) as exc:
            raise BridgeError("DICOM asli tidak dapat diunggah ke Google Drive.") from exc
        file_id = str(result.get("id") or "")
        if not re.fullmatch(r"[A-Za-z0-9._-]{10,120}", file_id):
            raise BridgeError("Google Drive tidak mengembalikan ID file DICOM yang valid.")
        return file_id


class GcsClient:
    def __init__(self, config: BridgeConfig, base_path: Path):
        try:
            from google.api_core.exceptions import PreconditionFailed
            from google.cloud import storage
        except ImportError as exc:
            raise BridgeError(
                "Paket google-cloud-storage belum terpasang. Jalankan setup.ps1 kembali."
            ) from exc
        credentials_path = Path(config.gcs_credentials_file)
        if not credentials_path.is_absolute():
            credentials_path = base_path / credentials_path
        credentials_path = credentials_path.resolve()
        if not credentials_path.is_file():
            raise BridgeError(f"Credential GCS tidak ditemukan: {credentials_path}")
        try:
            client = storage.Client.from_service_account_json(str(credentials_path))
        except Exception as exc:
            raise BridgeError("Credential service account GCS tidak dapat dibaca.") from exc
        self.bucket_name = config.gcs_bucket
        self.prefix = validate_gcs_prefix(config.gcs_prefix)
        self.bucket = client.bucket(config.gcs_bucket)
        self.precondition_failed = PreconditionFailed

    def close(self) -> None:
        close = getattr(self.bucket.client, "close", None)
        if callable(close):
            close()

    def upload(self, object_name: str, content: bytes, content_type: str) -> str:
        blob = self.bucket.blob(object_name)
        try:
            blob.upload_from_string(
                content,
                content_type=content_type,
                if_generation_match=0,
                timeout=600,
                checksum="auto",
            )
            return "UPLOADED"
        except self.precondition_failed:
            # Every object name includes a content digest, so an existing object is
            # the same immutable payload from an earlier attempt.
            return "EXISTS"
        except Exception as exc:
            raise BridgeError(f"Objek GCS gagal diunggah: {object_name}") from exc


class WhatsAppWebhookClient:
    def __init__(self, config: BridgeConfig):
        self.url = config.whatsapp_webhook_url
        self.api_key = config.whatsapp_webhook_api_key
        self.client = httpx.Client(
            timeout=config.whatsapp_webhook_timeout_seconds,
            follow_redirects=False,
            verify=True,
        )

    def close(self) -> None:
        self.client.close()

    def trigger(self, candidate: dict[str, Any]) -> str:
        study_key = str(candidate.get("study_key") or "")
        delivery_reference_id = str(candidate.get("delivery_reference_id") or "")
        object_key = str(candidate.get("object_key") or "")
        if not re.fullmatch(r"[A-Za-z0-9._-]{3,128}", study_key):
            raise BridgeError("study_key untuk webhook WhatsApp tidak valid.")
        if not re.fullmatch(r"WA_[0-9a-f]{40}", delivery_reference_id):
            raise BridgeError("delivery_reference_id untuk webhook WhatsApp tidak valid.")
        if not re.fullmatch(r"[0-9a-f]{64}", object_key):
            raise BridgeError("object_key untuk webhook WhatsApp tidak valid.")
        sequence_number = int(candidate.get("source_sequence_number") or 0)
        frame_index = candidate.get("frame_index")
        try:
            response = self.client.post(
                self.url,
                headers={
                    "X-API-Key": self.api_key,
                    "Accept": "application/json",
                },
                json={
                    "study_key": study_key,
                    "delivery_reference_id": delivery_reference_id,
                    "request_source": "ORTHANC_BRIDGE_AUTO",
                    "selected_object_keys": [object_key],
                    "selected_images": [{
                        "object_key": object_key,
                        "sequence_number": sequence_number,
                        "frame_index": frame_index,
                    }],
                },
            )
            response.raise_for_status()
            result = response.json()
        except (httpx.HTTPError, json.JSONDecodeError) as exc:
            status = getattr(getattr(exc, "response", None), "status_code", None)
            suffix = f" (HTTP {status})" if status else ""
            raise BridgeError(f"Webhook WhatsApp gagal menerima trigger{suffix}.") from exc
        if not isinstance(result, dict):
            raise BridgeError("Webhook WhatsApp mengembalikan respons yang tidak valid.")
        return str(result.get("message") or "Trigger diterima.")


class SyncState:
    def __init__(self, path: Path):
        self.path = path
        self.values: dict[str, Any] = {"completed_studies": {}}
        if path.exists():
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    self.values.update(loaded)
            except (OSError, json.JSONDecodeError):
                LOGGER.warning("State lokal rusak; sinkronisasi akan memeriksa ulang tanpa menghapus data server.")

    def completed(self, source_key: str) -> bool:
        return source_key in self.values.get("completed_studies", {})

    def mark_completed(self, source_key: str) -> None:
        self._mark("completed_studies", source_key)

    def dicoms_completed(self, source_key: str) -> bool:
        return source_key in self.values.get("completed_dicoms", {})

    def mark_dicoms_completed(self, source_key: str) -> None:
        self._mark("completed_dicoms", source_key)

    def gcs_images_completed(self, source_key: str) -> bool:
        return source_key in self.values.get("completed_gcs_images", {})

    def mark_gcs_images_completed(self, source_key: str) -> None:
        self._mark("completed_gcs_images", source_key)

    def gcs_dicoms_completed(self, source_key: str) -> bool:
        return source_key in self.values.get("completed_gcs_dicoms", {})

    def mark_gcs_dicoms_completed(self, source_key: str) -> None:
        self._mark("completed_gcs_dicoms", source_key)

    def bigquery_completed(self, source_key: str) -> bool:
        return source_key in self.values.get("completed_bigquery", {})

    def mark_bigquery_completed(self, source_key: str) -> None:
        self._mark("completed_bigquery", source_key)

    def whatsapp_trigger_completed(self, source_key: str) -> bool:
        return source_key in self.values.get("completed_whatsapp_triggers", {})

    def mark_whatsapp_trigger_completed(self, source_key: str) -> None:
        self._mark("completed_whatsapp_triggers", source_key)

    def whatsapp_trigger_skipped(self, source_key: str) -> bool:
        return source_key in self.values.get("skipped_whatsapp_triggers", {})

    def mark_whatsapp_trigger_skipped(self, source_key: str) -> None:
        self._mark("skipped_whatsapp_triggers", source_key)

    def completion_time(self, collection: str, source_key: str) -> str:
        return str(self.values.get(collection, {}).get(source_key) or "")

    def _mark(self, collection: str, source_key: str) -> None:
        completed = self.values.setdefault(collection, {})
        completed[source_key] = datetime.now(timezone.utc).isoformat()
        cutoff = datetime.now(timezone.utc) - timedelta(days=90)
        self.values[collection] = {
            key: value for key, value in completed.items()
            if parse_iso_datetime(value) >= cutoff
        }
        self.save()

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(self.path.suffix + ".tmp")
        temporary.write_text(json.dumps(self.values, indent=2), encoding="utf-8")
        temporary.replace(self.path)


def parse_iso_datetime(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return datetime.min.replace(tzinfo=timezone.utc)


def dicom_date(value: Any) -> str:
    match = re.match(r"^(\d{4})(\d{2})(\d{2})", str(value or "").replace("-", ""))
    if not match:
        return ""
    try:
        parsed = date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return ""
    return parsed.isoformat()


def dicom_time(value: Any) -> str:
    match = re.match(r"^(\d{2})(\d{2})(\d{2})", re.sub(r"[^0-9.]", "", str(value or "")))
    if not match:
        return ""
    try:
        parsed = datetime(2000, 1, 1, int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return ""
    return parsed.strftime("%H:%M:%S")


def clean_patient_name(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").replace("^", " ")).strip()[:120]


NUMERIC_SEQUENCE_RE = re.compile(r"\+?\d(?:[\d\s()./\-]*\d)?")
DOCTOR_PREFIX_RE = re.compile(r"(?<![A-Za-z])(?:DR\.?|DOKTER)(?=\s|$)", re.IGNORECASE)


def numeric_sequences(value: Any) -> list[tuple[str, str]]:
    text = clean_patient_name(value)
    result: list[tuple[str, str]] = []
    for match in NUMERIC_SEQUENCE_RE.finditer(text):
        raw = match.group(0).strip()
        digits = re.sub(r"\D", "", raw)
        if digits:
            result.append((raw, digits))
    return result


def extract_nik_candidates(value: Any) -> list[str]:
    return list(dict.fromkeys(
        digits for _raw, digits in numeric_sequences(value) if len(digits) == 16
    ))


def nik_candidate(value: Any) -> str:
    candidates = extract_nik_candidates(value)
    return candidates[0] if len(candidates) == 1 else ""


def normalize_phone_digits(digits: str) -> tuple[str, str]:
    if re.fullmatch(r"08\d{8,11}", digits):
        local = digits
    elif re.fullmatch(r"628\d{8,11}", digits):
        local = "0" + digits[2:]
    else:
        return "", ""
    return local, "+62" + local[1:]


def extract_phone_candidates(value: Any) -> list[tuple[str, str]]:
    result: dict[str, str] = {}
    for _raw, digits in numeric_sequences(value):
        local, international = normalize_phone_digits(digits)
        if local:
            result[local] = international
    return list(result.items())


def phone_candidate(value: Any) -> tuple[str, str]:
    candidates = extract_phone_candidates(value)
    return candidates[0] if len(candidates) == 1 else ("", "")


def canonical_dicom_text(value: Any) -> str:
    return re.sub(r"[^A-Z0-9]", "", clean_patient_name(value).upper())


def clean_doctor_candidate(value: Any, patient_name: str) -> str:
    text = clean_patient_name(value)
    if not text or canonical_dicom_text(text) == canonical_dicom_text(patient_name):
        return ""
    text = re.sub(r"\b(?:NO\.?\s*)?(?:NIK|KTP|HP|TELP|TELEPON|PHONE)\b", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"\bID\b", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"^[\s:;,_\-./\\]+|[\s:;,_\-./\\]+$", "", text)
    text = re.sub(r"^(DR)\.\s*", r"\1 ", text, flags=re.IGNORECASE)
    text = re.sub(r"\s+", " ", text).strip()
    if not re.search(r"[A-Za-z]", text):
        return ""
    if canonical_dicom_text(text) == canonical_dicom_text(patient_name):
        return ""
    return text[:120]


def extract_doctor_candidates(
    value: Any,
    patient_name: str,
    *,
    require_prefix: bool,
) -> list[str]:
    text = clean_patient_name(value)
    if not text:
        return []
    text_without_numbers = NUMERIC_SEQUENCE_RE.sub(" ", text)
    if not require_prefix:
        candidate = clean_doctor_candidate(text_without_numbers, patient_name)
        return [candidate] if candidate else []

    prefix_matches = list(DOCTOR_PREFIX_RE.finditer(text_without_numbers))
    result: list[str] = []
    for index, match in enumerate(prefix_matches):
        end = prefix_matches[index + 1].start() if index + 1 < len(prefix_matches) else len(text_without_numbers)
        segment = text_without_numbers[match.start():end]
        candidate = clean_doctor_candidate(segment, patient_name)
        if candidate and candidate not in result:
            result.append(candidate)
    return result


def doctor_candidate(value: Any, patient_name: str, *, require_prefix: bool = False) -> str:
    candidates = extract_doctor_candidates(
        value,
        patient_name,
        require_prefix=require_prefix,
    )
    return candidates[0] if len(candidates) == 1 else ""


def _candidate_map(items: Iterable[tuple[str, str]]) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    for source, value in items:
        if not value:
            continue
        result.setdefault(value, [])
        if source not in result[value]:
            result[value].append(source)
    return result


def interpret_dicom_identity_fields(tags: dict[str, Any]) -> dict[str, Any]:
    patient_name = clean_patient_name(tags.get("PatientName"))
    mixed_sources = [
        ("PatientID", clean_patient_name(tags.get("PatientID"))[:80]),
        ("AccessionNumber", clean_patient_name(tags.get("AccessionNumber"))[:80]),
        ("PatientComments", clean_patient_name(tags.get("PatientComments"))[:160]),
    ]
    nik_candidates = _candidate_map(
        (source, candidate)
        for source, value in mixed_sources
        for candidate in extract_nik_candidates(value)
    )

    standard_phone_sources = [
        ("PatientTelephoneNumbers", clean_patient_name(tags.get("PatientTelephoneNumbers"))[:80])
    ]
    standard_phones = _candidate_map(
        (source, local)
        for source, value in standard_phone_sources
        for local, _international in extract_phone_candidates(value)
    )
    mixed_phones = _candidate_map(
        (source, local)
        for source, value in mixed_sources
        for local, _international in extract_phone_candidates(value)
    )
    phone_candidates = standard_phones or mixed_phones

    standard_doctor_sources = [
        ("PerformingPhysicianName", clean_patient_name(tags.get("PerformingPhysicianName"))[:120]),
        ("OperatorsName", clean_patient_name(tags.get("OperatorsName"))[:120]),
        ("ReferringPhysicianName", clean_patient_name(tags.get("ReferringPhysicianName"))[:120]),
    ]
    standard_doctors = _candidate_map(
        (source, doctor_candidate(value, patient_name)) for source, value in standard_doctor_sources
    )
    mixed_doctors = _candidate_map(
        (source, candidate)
        for source, value in mixed_sources
        for candidate in extract_doctor_candidates(
            value,
            patient_name,
            require_prefix=True,
        )
    )
    doctor_candidates = standard_doctors or mixed_doctors

    warnings: list[str] = []
    conflicts = False
    for candidates, conflict_message in (
        (nik_candidates, "Ditemukan lebih dari satu NIK berbeda pada metadata DICOM."),
        (phone_candidates, "Ditemukan lebih dari satu nomor telepon berbeda pada metadata DICOM."),
        (doctor_candidates, "Ditemukan lebih dari satu nama dokter berbeda pada metadata DICOM."),
    ):
        if len(candidates) > 1:
            conflicts = True
            warnings.append(conflict_message)

    patient_nik = next(iter(nik_candidates), "") if len(nik_candidates) == 1 else ""
    patient_phone = next(iter(phone_candidates), "") if len(phone_candidates) == 1 else ""
    doctor_name = next(iter(doctor_candidates), "") if len(doctor_candidates) == 1 else ""
    _, phone_e164 = phone_candidate(patient_phone)
    missing: list[str] = []
    if not patient_name:
        missing.append("Nama pasien tidak tersedia.")
    if not patient_nik and len(nik_candidates) <= 1:
        missing.append("NIK pasien tidak tersedia atau tidak valid.")
    if not patient_phone and len(phone_candidates) <= 1:
        missing.append("Nomor telepon pasien tidak tersedia atau tidak valid.")
    if not doctor_name and len(doctor_candidates) <= 1:
        missing.append("Nama dokter tidak tersedia.")
    warnings.extend(missing)
    if conflicts:
        status = "AMBIGUOUS"
    elif missing:
        status = "PARTIAL"
    else:
        status = "READY"
    return {
        "patient_name": patient_name,
        "patient_nik": patient_nik,
        "patient_phone": patient_phone,
        "patient_phone_e164": phone_e164,
        "doctor_name": doctor_name,
        "identity_status": status,
        "metadata_warnings": warnings,
        "nik_sources": nik_candidates.get(patient_nik, []) if patient_nik else [],
        "phone_sources": phone_candidates.get(patient_phone, []) if patient_phone else [],
        "doctor_sources": doctor_candidates.get(doctor_name, []) if doctor_name else [],
        "patient_id_raw": mixed_sources[0][1],
        "accession_number_raw": mixed_sources[1][1],
        "patient_comments_raw": mixed_sources[2][1],
    }


def merged_study_tags(study: dict[str, Any]) -> dict[str, Any]:
    tags: dict[str, Any] = {}
    for key in ("MainDicomTags", "PatientMainDicomTags", "RequestedTags"):
        candidate = study.get(key)
        if isinstance(candidate, dict):
            tags.update(candidate)
    return tags


def study_payload(study: dict[str, Any], expected_images: int, expected_dicoms: int = 0) -> dict[str, Any]:
    tags = merged_study_tags(study)
    return {
        "orthanc_study_id": str(study.get("ID") or ""),
        "study_instance_uid": str(tags.get("StudyInstanceUID") or ""),
        "patient_name": clean_patient_name(tags.get("PatientName")),
        "patient_id": str(tags.get("PatientID") or "")[:80],
        "patient_comments": str(tags.get("PatientComments") or "")[:160],
        "patient_birth_date": dicom_date(tags.get("PatientBirthDate")),
        "study_date": dicom_date(tags.get("StudyDate")),
        "study_time": dicom_time(tags.get("StudyTime")),
        "accession_number": str(tags.get("AccessionNumber") or "")[:80],
        "study_description": str(tags.get("StudyDescription") or "")[:160],
        "modality": str(tags.get("Modality") or "")[:40],
        "institution_name": clean_patient_name(tags.get("InstitutionName"))[:160],
        "station_name": clean_patient_name(tags.get("StationName"))[:80],
        "patient_telephone_numbers": str(tags.get("PatientTelephoneNumbers") or "")[:80],
        "performing_physician_name": clean_patient_name(tags.get("PerformingPhysicianName"))[:120],
        "operators_name": clean_patient_name(tags.get("OperatorsName"))[:120],
        "referring_physician_name": clean_patient_name(tags.get("ReferringPhysicianName"))[:120],
        "expected_images": expected_images,
        "expected_dicoms": expected_dicoms,
    }


def source_key(bridge_id: str, study: dict[str, Any]) -> str:
    payload = study_payload(study, 0)
    identifier = payload["study_instance_uid"] or payload["orthanc_study_id"]
    return f"{bridge_id}|{identifier}"


def validate_gcs_prefix(value: str) -> str:
    prefix = str(value or "").strip().strip("/")
    if not prefix or len(prefix) > 200 or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", prefix):
        raise BridgeError("gcs_prefix tidak valid.")
    if any(segment in {"", ".", ".."} for segment in prefix.split("/")):
        raise BridgeError("gcs_prefix mengandung segmen path yang tidak valid.")
    return prefix


def gcs_study_prefix(config: BridgeConfig, study: dict[str, Any]) -> str:
    digest = hashlib.sha256(source_key(config.bridge_id, study).encode("utf-8")).hexdigest()[:32]
    return f"{validate_gcs_prefix(config.gcs_prefix)}/orthanc/studies/{digest}"


def gcs_study_key(config: BridgeConfig, study: dict[str, Any]) -> str:
    return gcs_study_prefix(config, study).rsplit("/", 1)[-1]


def gcs_dicom_object_name(
    config: BridgeConfig,
    study: dict[str, Any],
    sequence: int,
    content: bytes,
) -> str:
    digest = hashlib.sha256(content).hexdigest()
    return f"{gcs_study_prefix(config, study)}/dicom/{sequence:04d}_{digest}.dcm"


def gcs_jpeg_object_name(
    config: BridgeConfig,
    study: dict[str, Any],
    sequence: int,
    frame_index: int,
    content: bytes,
) -> str:
    digest = hashlib.sha256(content).hexdigest()
    return f"{gcs_study_prefix(config, study)}/jpg/{sequence:04d}_{frame_index:03d}_{digest}.jpg"


def create_bigquery_registry(config: BridgeConfig, base_path: Path, provision: bool = False) -> Any:
    credentials_path = Path(config.bigquery_credentials_file)
    if not credentials_path.is_absolute():
        credentials_path = base_path / credentials_path
    credentials_path = credentials_path.resolve()
    if not credentials_path.is_file():
        raise BridgeError(f"Credential BigQuery tidak ditemukan: {credentials_path}")
    try:
        credential_values = json.loads(credentials_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise BridgeError("Credential BigQuery tidak dapat dibaca.") from exc
    project_id = config.bigquery_project or str(credential_values.get("project_id") or "")
    try:
        from bigquery_registry import BigQueryRegistry, BigQueryRegistryError
    except ImportError as exc:
        raise BridgeError(
            "Modul bigquery_registry.py atau dependensi BigQuery tidak tersedia."
        ) from exc
    try:
        registry = BigQueryRegistry(
            credentials_path=credentials_path,
            project_id=project_id,
            dataset_id=config.bigquery_dataset,
            location=config.bigquery_location,
            studies_table=config.bigquery_studies_table,
            files_table=config.bigquery_files_table,
            deliveries_table=config.bigquery_deliveries_table,
            whatsapp_view=config.bigquery_whatsapp_view,
            require_whatsapp=config.trigger_whatsapp_webhook,
        )
        if provision:
            registry.provision()
        else:
            registry.verify_ready()
        return registry
    except BigQueryRegistryError as exc:
        raise BridgeError(str(exc)) from exc


def gcs_file_record(
    config: BridgeConfig,
    study: dict[str, Any],
    *,
    file_type: str,
    sequence_number: int,
    frame_index: int | None,
    series_id: str,
    instance_id: str,
    sop_instance_uid: str,
    object_name: str,
    content_type: str,
    content: bytes,
    observed_at: str,
) -> dict[str, Any]:
    digest = hashlib.sha256(content).hexdigest()
    object_key = hashlib.sha256(
        f"{config.gcs_bucket}/{object_name}".encode("utf-8")
    ).hexdigest()
    return {
        "object_key": object_key,
        "study_key": gcs_study_key(config, study),
        "file_type": file_type,
        "sequence_number": sequence_number,
        "frame_index": frame_index,
        "source_series_id": series_id,
        "source_instance_id": instance_id,
        "sop_instance_uid": sop_instance_uid,
        "gcs_bucket": config.gcs_bucket,
        "object_name": object_name,
        "gcs_uri": f"gs://{config.gcs_bucket}/{object_name}",
        "content_type": content_type,
        "size_bytes": len(content),
        "sha256": digest,
        "gcs_observed_at": observed_at,
    }


def build_bigquery_study_record(
    config: BridgeConfig,
    study: dict[str, Any],
    file_records: list[dict[str, Any]],
    gcs_completed_at: str,
) -> dict[str, Any]:
    tags = merged_study_tags(study)
    identity = interpret_dicom_identity_fields(tags)
    payload = study_payload(study, 0)
    study_date = payload["study_date"]
    study_time_value = payload["study_time"]
    study_datetime_local = (
        f"{study_date}T{study_time_value}" if study_date and study_time_value else ""
    )
    jpeg_count = sum(item["file_type"] == "JPEG" for item in file_records)
    dicom_count = sum(item["file_type"] == "DICOM" for item in file_records)
    block_reasons = list(identity["metadata_warnings"])
    if jpeg_count == 0:
        block_reasons.append("Tidak ada JPEG yang tersedia untuk dikirim melalui WhatsApp.")
    whatsapp_ready = identity["identity_status"] == "READY" and jpeg_count > 0
    prefix = gcs_study_prefix(config, study)
    return {
        "study_key": gcs_study_key(config, study),
        "bridge_id": config.bridge_id,
        "orthanc_study_id": payload["orthanc_study_id"],
        "study_instance_uid": payload["study_instance_uid"],
        **identity,
        "patient_birth_date": payload["patient_birth_date"],
        "study_date": study_date,
        "study_time": study_time_value,
        "study_datetime_local": study_datetime_local,
        "study_timezone": config.study_timezone,
        "study_description": payload["study_description"],
        "modality": payload["modality"],
        "institution_name": payload["institution_name"],
        "station_name": payload["station_name"],
        "gcs_bucket": config.gcs_bucket,
        "gcs_study_prefix": prefix,
        "gcs_uri_prefix": f"gs://{config.gcs_bucket}/{prefix}/",
        "jpeg_count": jpeg_count,
        "dicom_count": dicom_count,
        "whatsapp_ready": whatsapp_ready,
        "whatsapp_block_reasons": block_reasons,
        "metadata_parser_version": METADATA_PARSER_VERSION,
        "gcs_completed_at": gcs_completed_at,
    }


def instance_references(orthanc: OrthancClient, study_id: str, maximum: int) -> list[tuple[str, str]]:
    result: list[tuple[str, str]] = []
    study = orthanc.study(study_id)
    for series_id in study.get("Series", []):
        series = orthanc.series(str(series_id))
        for instance_id in series.get("Instances", []):
            result.append((str(series_id), str(instance_id)))
            if len(result) >= maximum:
                return result
    return result


def frame_indexes(tags: dict[str, Any], maximum: int) -> Iterable[int]:
    try:
        count = max(1, int(tags.get("NumberOfFrames") or 1))
    except (TypeError, ValueError):
        count = 1
    return range(min(count, maximum))


def image_candidates(
    orthanc: OrthancClient,
    references: list[tuple[str, str]],
    max_frames_per_instance: int,
    maximum_images: int,
) -> tuple[list[tuple[str, str, dict[str, Any], int]], int]:
    candidates: list[tuple[str, str, dict[str, Any], int]] = []
    skipped = 0
    for series_id, instance_id in references:
        try:
            tags = orthanc.instance_tags(instance_id)
        except BridgeError as exc:
            skipped += 1
            LOGGER.warning("Tag instance %s tidak dapat dibaca: %s", instance_id, exc)
            continue
        for frame_index in frame_indexes(tags, max_frames_per_instance):
            candidates.append((series_id, instance_id, tags, frame_index))
            if len(candidates) >= maximum_images:
                return candidates, skipped
    return candidates, skipped


def encode_jpeg(image: Image.Image, quality: int) -> bytes:
    output = BytesIO()
    image.save(output, format="JPEG", quality=quality, optimize=True)
    return output.getvalue()


def make_jpeg_bundle(raw_image: bytes) -> dict[str, Any]:
    try:
        with Image.open(BytesIO(raw_image)) as source:
            image = ImageOps.exif_transpose(source).convert("RGB")
            image.thumbnail((2800, 2800), Image.Resampling.LANCZOS)
            width, height = image.size
            data = encode_jpeg(image, 90)
            for quality in (82, 74, 66):
                if len(data) <= MAX_UPLOAD_BYTES:
                    break
                data = encode_jpeg(image, quality)
            if len(data) > MAX_UPLOAD_BYTES:
                raise BridgeError("Gambar tetap melebihi batas unggahan setelah dikompresi.")
            thumbnail = image.copy()
            thumbnail.thumbnail((400, 400), Image.Resampling.LANCZOS)
            thumbnail_data = encode_jpeg(thumbnail, 76)
    except (OSError, ValueError) as exc:
        raise BridgeError("Preview DICOM tidak dapat dibaca sebagai gambar.") from exc
    return {
        "mime_type": "image/jpeg",
        "base64": base64.b64encode(data).decode("ascii"),
        "width": width,
        "height": height,
        "thumbnail_base64": base64.b64encode(thumbnail_data).decode("ascii"),
        "thumbnail_width": thumbnail.width,
        "thumbnail_height": thumbnail.height,
    }


def sync_study(
    config: BridgeConfig,
    orthanc: OrthancClient,
    webapp: AppsScriptClient | None,
    gcs: GcsClient | None,
    state: SyncState,
    study: dict[str, Any],
    bigquery: Any | None = None,
    whatsapp: WhatsAppWebhookClient | None = None,
) -> None:
    study_id = str(study.get("ID") or "")
    if not study_id:
        return
    key = source_key(config.bridge_id, study)
    drive_images_complete = not config.upload_to_google_drive or state.completed(key)
    drive_dicoms_complete = (
        not config.upload_to_google_drive
        or not config.upload_original_dicoms
        or state.dicoms_completed(key)
    )
    gcs_images_complete = not config.upload_to_gcs or state.gcs_images_completed(key)
    gcs_dicoms_complete = not config.upload_to_gcs or state.gcs_dicoms_completed(key)
    bigquery_complete = (
        not config.upload_metadata_to_bigquery or state.bigquery_completed(key)
    )
    whatsapp_complete = (
        not config.trigger_whatsapp_webhook
        or state.whatsapp_trigger_completed(key)
        or state.whatsapp_trigger_skipped(key)
    )
    if (
        drive_images_complete
        and drive_dicoms_complete
        and gcs_images_complete
        and gcs_dicoms_complete
        and bigquery_complete
        and whatsapp_complete
    ):
        return
    if config.upload_to_google_drive and webapp is None:
        raise BridgeError("Klien web app tidak tersedia saat tujuan Google Drive diaktifkan.")
    if config.upload_to_gcs and gcs is None:
        raise BridgeError("Klien GCS tidak tersedia saat tujuan GCS diaktifkan.")
    if config.upload_metadata_to_bigquery and bigquery is None:
        raise BridgeError("Klien BigQuery tidak tersedia saat sinkronisasi metadata diaktifkan.")
    if config.trigger_whatsapp_webhook and whatsapp is None:
        raise BridgeError("Klien webhook WhatsApp tidak tersedia saat trigger diaktifkan.")

    collect_bigquery_files = config.upload_metadata_to_bigquery and not bigquery_complete
    whatsapp_pending = config.trigger_whatsapp_webhook and not whatsapp_complete
    need_images = (
        not drive_images_complete
        or not gcs_images_complete
        or collect_bigquery_files
    )
    need_dicoms = not drive_dicoms_complete or not gcs_dicoms_complete or collect_bigquery_files
    reference_limit = max(
        config.max_images_per_study if need_images else 0,
        config.max_dicom_instances_per_study if need_dicoms else 0,
    )
    references = instance_references(orthanc, study_id, reference_limit) if reference_limit else []
    preview_references = references[:config.max_images_per_study]
    candidates: list[tuple[str, str, dict[str, Any], int]] = []
    tag_skipped = 0
    if need_images:
        candidates, tag_skipped = image_candidates(
            orthanc,
            preview_references,
            config.max_frames_per_instance,
            config.max_images_per_study,
        )
    expected_images = len(candidates) + tag_skipped
    metadata = study_payload(
        study,
        expected_images,
        len(references) if config.upload_original_dicoms else 0,
    )

    drive_needs_sync = config.upload_to_google_drive and (not drive_images_complete or not drive_dicoms_complete)
    response: dict[str, Any] = {}
    if drive_needs_sync and webapp:
        response = webapp.post("upsert_study", study=metadata)
        if response.get("status") == "REJECTED":
            state.mark_completed(key)
            if config.upload_original_dicoms:
                state.mark_dicoms_completed(key)
            drive_images_complete = True
            drive_dicoms_complete = True
            drive_needs_sync = False

    drive_images_received = 0
    drive_images_skipped = tag_skipped if drive_needs_sync and not drive_images_complete else 0
    gcs_images_received = 0
    gcs_images_skipped = tag_skipped if config.upload_to_gcs and not gcs_images_complete else 0
    should_upload_drive_images = bool(
        drive_needs_sync
        and not drive_images_complete
        and response.get("should_upload_images", response.get("should_upload"))
    )
    should_upload_gcs_images = config.upload_to_gcs and not gcs_images_complete
    file_records: list[dict[str, Any]] = []
    bigquery_files_skipped = tag_skipped if collect_bigquery_files else 0
    observed_at = datetime.now(timezone.utc).isoformat()
    if should_upload_drive_images or should_upload_gcs_images or collect_bigquery_files:
        for sequence, (series_id, instance_id, tags, frame_index) in enumerate(candidates, start=1):
            try:
                bundle = make_jpeg_bundle(orthanc.preview(instance_id, frame_index))
            except BridgeError as exc:
                if should_upload_drive_images:
                    drive_images_skipped += 1
                if should_upload_gcs_images:
                    gcs_images_skipped += 1
                if collect_bigquery_files:
                    bigquery_files_skipped += 1
                LOGGER.warning("Preview instance %s dilewati: %s", instance_id, exc)
                continue
            if should_upload_drive_images and webapp:
                try:
                    webapp.post("upload_image", image={
                        "orthanc_study_id": metadata["orthanc_study_id"],
                        "study_instance_uid": metadata["study_instance_uid"],
                        "orthanc_series_id": series_id,
                        "orthanc_instance_id": instance_id,
                        "sop_instance_uid": str(tags.get("SOPInstanceUID") or ""),
                        "frame_index": frame_index,
                        "original_filename": f"orthanc_{instance_id}_{frame_index}.jpg",
                        **bundle,
                    })
                    drive_images_received += 1
                except BridgeError as exc:
                    drive_images_skipped += 1
                    LOGGER.warning("Preview instance %s gagal dikirim ke web app: %s", instance_id, exc)
            if should_upload_gcs_images or collect_bigquery_files:
                try:
                    jpeg_content = base64.b64decode(bundle["base64"], validate=True)
                    object_name = gcs_jpeg_object_name(
                        config, study, sequence, frame_index, jpeg_content
                    )
                    if should_upload_gcs_images and gcs:
                        gcs.upload(object_name, jpeg_content, "image/jpeg")
                        gcs_images_received += 1
                except (BridgeError, ValueError) as exc:
                    if should_upload_gcs_images:
                        gcs_images_skipped += 1
                    if collect_bigquery_files:
                        bigquery_files_skipped += 1
                    LOGGER.warning("JPEG instance %s gagal dikirim ke GCS: %s", instance_id, exc)
                    continue
                if collect_bigquery_files:
                    file_records.append(gcs_file_record(
                        config,
                        study,
                        file_type="JPEG",
                        sequence_number=sequence,
                        frame_index=frame_index,
                        series_id=series_id,
                        instance_id=instance_id,
                        sop_instance_uid=str(tags.get("SOPInstanceUID") or ""),
                        object_name=object_name,
                        content_type="image/jpeg",
                        content=jpeg_content,
                        observed_at=observed_at,
                    ))

    drive_dicoms_received = 0
    drive_dicoms_skipped = 0
    gcs_dicoms_received = 0
    gcs_dicoms_skipped = 0
    should_upload_drive_dicoms = bool(
        drive_needs_sync
        and config.upload_original_dicoms
        and not drive_dicoms_complete
        and response.get("should_upload_dicoms")
    )
    should_upload_gcs_dicoms = config.upload_to_gcs and not gcs_dicoms_complete
    if should_upload_drive_dicoms or should_upload_gcs_dicoms or collect_bigquery_files:
        tag_cache = {instance_id: tags for _, instance_id, tags, _ in candidates}
        for sequence, (series_id, instance_id) in enumerate(references, start=1):
            try:
                raw_dicom = orthanc.instance_file(instance_id)
            except BridgeError as exc:
                if should_upload_drive_dicoms:
                    drive_dicoms_skipped += 1
                if should_upload_gcs_dicoms:
                    gcs_dicoms_skipped += 1
                if collect_bigquery_files:
                    bigquery_files_skipped += 1
                LOGGER.warning("DICOM asli instance %s tidak dapat dibaca: %s", instance_id, exc)
                continue
            if should_upload_drive_dicoms and webapp:
                try:
                    tags = tag_cache.get(instance_id) or orthanc.instance_tags(instance_id)
                    prepared = webapp.post("prepare_dicom_upload", dicom={
                        "orthanc_study_id": metadata["orthanc_study_id"],
                        "study_instance_uid": metadata["study_instance_uid"],
                        "orthanc_series_id": series_id,
                        "orthanc_instance_id": instance_id,
                        "sop_instance_uid": str(tags.get("SOPInstanceUID") or ""),
                        "sequence_number": sequence,
                        "original_filename": f"orthanc_{instance_id}.dcm",
                        "file_size_bytes": len(raw_dicom),
                        "sha256_hash": hashlib.sha256(raw_dicom).hexdigest(),
                    })
                    if prepared.get("should_upload"):
                        drive_file_id = webapp.upload_dicom(str(prepared.get("upload_url") or ""), raw_dicom)
                        webapp.post("complete_dicom_upload", dicom={
                            "orthanc_study_id": metadata["orthanc_study_id"],
                            "study_instance_uid": metadata["study_instance_uid"],
                            "dicom_id": prepared.get("dicom_id"),
                            "drive_file_id": drive_file_id,
                        })
                    drive_dicoms_received += 1
                except BridgeError as exc:
                    drive_dicoms_skipped += 1
                    LOGGER.warning("DICOM asli instance %s gagal dikirim ke web app: %s", instance_id, exc)
            if should_upload_gcs_dicoms or collect_bigquery_files:
                object_name = gcs_dicom_object_name(config, study, sequence, raw_dicom)
                if should_upload_gcs_dicoms and gcs:
                    try:
                        gcs.upload(object_name, raw_dicom, "application/dicom")
                        gcs_dicoms_received += 1
                    except BridgeError as exc:
                        gcs_dicoms_skipped += 1
                        LOGGER.warning("DICOM asli instance %s gagal dikirim ke GCS: %s", instance_id, exc)
                if collect_bigquery_files:
                    tags = tag_cache.get(instance_id) or orthanc.instance_tags(instance_id)
                    file_records.append(gcs_file_record(
                        config,
                        study,
                        file_type="DICOM",
                        sequence_number=sequence,
                        frame_index=None,
                        series_id=series_id,
                        instance_id=instance_id,
                        sop_instance_uid=str(tags.get("SOPInstanceUID") or ""),
                        object_name=object_name,
                        content_type="application/dicom",
                        content=raw_dicom,
                        observed_at=observed_at,
                    ))

    if should_upload_gcs_images and gcs_images_skipped == 0 and gcs_images_received >= len(candidates):
        state.mark_gcs_images_completed(key)
    if should_upload_gcs_dicoms and gcs_dicoms_skipped == 0 and gcs_dicoms_received >= len(references):
        state.mark_gcs_dicoms_completed(key)

    if drive_needs_sync and webapp:
        messages: list[str] = []
        if drive_images_skipped:
            messages.append(f"{drive_images_skipped} instance atau frame tidak dapat dikonversi atau dikirim oleh OrthancBridge.")
        if drive_dicoms_skipped:
            messages.append(f"{drive_dicoms_skipped} DICOM asli belum berhasil diunggah.")
        final = webapp.post("finalize_study", study={
            "orthanc_study_id": metadata["orthanc_study_id"],
            "study_instance_uid": metadata["study_instance_uid"],
            "expected_images": expected_images,
            "skipped_images": drive_images_skipped,
            "expected_dicoms": len(references) if config.upload_original_dicoms else 0,
            "skipped_dicoms": drive_dicoms_skipped,
            "message": " ".join(messages),
        })
        if final.get("status") in {"READY", "IMPORTED"}:
            state.mark_completed(key)
        if (
            config.upload_original_dicoms
            and drive_dicoms_skipped == 0
            and int(final.get("received_dicoms") or 0) >= len(references)
        ):
            state.mark_dicoms_completed(key)

    bigquery_status = "DISABLED" if not config.upload_metadata_to_bigquery else "ALREADY_COMPLETE"
    if collect_bigquery_files and bigquery:
        gcs_ready = state.gcs_images_completed(key) and state.gcs_dicoms_completed(key)
        if not gcs_ready:
            bigquery_status = "WAITING_GCS"
        elif bigquery_files_skipped:
            bigquery_status = "FILE_COLLECTION_FAILED"
            LOGGER.error(
                "Metadata studi %s belum dikirim ke BigQuery karena %s berkas tidak dapat direkonstruksi.",
                study_id,
                bigquery_files_skipped,
            )
        else:
            completion_values = [
                state.completion_time("completed_gcs_images", key),
                state.completion_time("completed_gcs_dicoms", key),
            ]
            completion_times = [parse_iso_datetime(value) for value in completion_values if value]
            gcs_completed_at = (
                max(completion_times).isoformat()
                if completion_times
                else datetime.now(timezone.utc).isoformat()
            )
            study_record = build_bigquery_study_record(
                config, study, file_records, gcs_completed_at
            )
            try:
                bigquery.upsert_study(study_record, file_records)
                state.mark_bigquery_completed(key)
                bigquery_status = "SYNCED"
            except Exception as exc:
                bigquery_status = "FAILED"
                LOGGER.error("Metadata studi %s gagal dikirim ke BigQuery: %s", study_id, exc)

    whatsapp_status = (
        "DISABLED" if not config.trigger_whatsapp_webhook else "ALREADY_TRIGGERED"
    )
    if whatsapp_pending and whatsapp:
        gcs_ready = state.gcs_images_completed(key) and state.gcs_dicoms_completed(key)
        bigquery_ready = state.bigquery_completed(key)
        if not gcs_ready:
            whatsapp_status = "WAITING_GCS"
        elif not bigquery_ready:
            whatsapp_status = "WAITING_BIGQUERY"
        elif parse_iso_datetime(state.completion_time("completed_bigquery", key)) < parse_iso_datetime(
            config.whatsapp_trigger_not_before
        ):
            state.mark_whatsapp_trigger_skipped(key)
            whatsapp_status = "SKIPPED_BEFORE_CUTOFF"
        else:
            acquired: dict[str, Any] | None = None
            try:
                candidate = bigquery.get_auto_whatsapp_candidate(
                    gcs_study_key(config, study), config.bridge_id
                )
                if not candidate:
                    whatsapp_status = "WAITING_BIGQUERY_CANDIDATE"
                else:
                    acquired = bigquery.acquire_auto_whatsapp_delivery(candidate)
                    if acquired["state"] == "ALREADY_SENT":
                        state.mark_whatsapp_trigger_completed(key)
                        whatsapp_status = "ALREADY_SENT"
                    elif acquired["state"] == "PENDING":
                        whatsapp_status = "OUTBOX_PENDING"
                    else:
                        whatsapp.trigger(acquired)
                        bigquery.update_auto_whatsapp_delivery(
                            acquired["delivery_reference_id"],
                            acquired["request_token"],
                            "QUEUED",
                        )
                        state.mark_whatsapp_trigger_completed(key)
                        whatsapp_status = "TRIGGERED"
            except Exception as exc:
                whatsapp_status = "FAILED"
                if acquired and acquired.get("state") == "ACQUIRED":
                    try:
                        bigquery.update_auto_whatsapp_delivery(
                            acquired["delivery_reference_id"],
                            acquired["request_token"],
                            "FAILED",
                            str(exc),
                        )
                    except Exception as outbox_exc:
                        LOGGER.error(
                            "Status outbox WhatsApp studi %s gagal diperbarui: %s",
                            study_id,
                            outbox_exc,
                        )
                LOGGER.error("Trigger WhatsApp studi %s gagal: %s", study_id, exc)

    LOGGER.info(
        "Studi %s selesai: Drive %s JPEG/%s DICOM, GCS %s JPEG/%s DICOM, BigQuery %s, WhatsApp %s; kegagalan Drive %s/%s, GCS %s/%s.",
        study_id,
        drive_images_received,
        drive_dicoms_received,
        gcs_images_received,
        gcs_dicoms_received,
        bigquery_status,
        whatsapp_status,
        drive_images_skipped,
        drive_dicoms_skipped,
        gcs_images_skipped,
        gcs_dicoms_skipped,
    )


def sync_once(
    config: BridgeConfig,
    orthanc: OrthancClient,
    webapp: AppsScriptClient | None,
    gcs: GcsClient | None,
    state: SyncState,
    bigquery: Any | None = None,
    whatsapp: WhatsAppWebhookClient | None = None,
) -> None:
    system = orthanc.system()
    LOGGER.info("Terhubung ke Orthanc %s.", system.get("Version", "versi tidak diketahui"))
    if config.upload_to_google_drive:
        if webapp is None:
            raise BridgeError("Klien web app tidak tersedia.")
        webapp.post("ping")
    start_date = date.today() - timedelta(days=config.lookback_days)
    studies = orthanc.recent_studies(start_date)
    LOGGER.info("Menemukan %s studi pada jendela pencarian.", len(studies))
    for study in studies:
        if STOP_REQUESTED:
            return
        if study.get("IsStable") is False:
            continue
        try:
            sync_study(
                config,
                orthanc,
                webapp,
                gcs,
                state,
                study,
                bigquery=bigquery,
                whatsapp=whatsapp,
            )
        except BridgeError as exc:
            LOGGER.error("Sinkronisasi studi %s gagal: %s", study.get("ID", "tanpa-id"), exc)


def configure_logging(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    handler = RotatingFileHandler(path, maxBytes=2_000_000, backupCount=5, encoding="utf-8")
    handler.setFormatter(formatter)
    console = logging.StreamHandler()
    console.setFormatter(formatter)
    LOGGER.setLevel(logging.INFO)
    LOGGER.addHandler(handler)
    LOGGER.addHandler(console)


def request_stop(_signum: int, _frame: Any) -> None:
    global STOP_REQUESTED
    STOP_REQUESTED = True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Jembatan aman Orthanc ke BPJS USG Apps Script")
    parser.add_argument("--config", default="config.json", help="Lokasi berkas konfigurasi JSON")
    parser.add_argument("--once", action="store_true", help="Jalankan satu siklus lalu berhenti")
    parser.add_argument(
        "--provision-bigquery",
        action="store_true",
        help="Buat atau validasi dataset, tabel, dan view BigQuery lalu berhenti",
    )
    arguments = parser.parse_args(argv)
    config_path = Path(arguments.config).resolve()
    try:
        config = BridgeConfig.load(config_path)
        base = config_path.parent
        if arguments.provision_bigquery:
            registry = create_bigquery_registry(config, base, provision=True)
            registry.close()
            object_names = (
                f"{config.bigquery_studies_table}/{config.bigquery_files_table}"
            )
            if config.trigger_whatsapp_webhook:
                object_names += (
                    f"/{config.bigquery_deliveries_table}/{config.bigquery_whatsapp_view}"
                )
            print(
                f"Dataset {config.bigquery_dataset} dan objek {object_names} siap "
                f"di {config.bigquery_location}."
            )
            return 0
        configure_logging((base / config.log_file).resolve())
        signal.signal(signal.SIGINT, request_stop)
        signal.signal(signal.SIGTERM, request_stop)
        state = SyncState((base / config.state_file).resolve())
        orthanc = OrthancClient(config)
        webapp = AppsScriptClient(config) if config.upload_to_google_drive else None
        gcs = GcsClient(config, base) if config.upload_to_gcs else None
        bigquery = (
            create_bigquery_registry(config, base)
            if config.upload_metadata_to_bigquery
            else None
        )
        whatsapp = (
            WhatsAppWebhookClient(config)
            if config.trigger_whatsapp_webhook
            else None
        )
        try:
            while not STOP_REQUESTED:
                try:
                    sync_once(
                        config,
                        orthanc,
                        webapp,
                        gcs,
                        state,
                        bigquery=bigquery,
                        whatsapp=whatsapp,
                    )
                except BridgeError as exc:
                    LOGGER.error("Siklus sinkronisasi gagal: %s", exc)
                    if arguments.once:
                        return 1
                if arguments.once:
                    break
                for _ in range(config.poll_seconds):
                    if STOP_REQUESTED:
                        break
                    time.sleep(1)
        finally:
            orthanc.close()
            if webapp:
                webapp.close()
            if gcs:
                gcs.close()
            if bigquery:
                bigquery.close()
            if whatsapp:
                whatsapp.close()
    except BridgeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
