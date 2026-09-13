from __future__ import annotations

import argparse
import base64
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


class BridgeError(RuntimeError):
    pass


@dataclass(frozen=True)
class BridgeConfig:
    orthanc_url: str
    orthanc_username: str
    orthanc_password: str
    apps_script_url: str
    bridge_id: str
    bridge_key: str
    lookback_days: int = 2
    poll_seconds: int = 60
    max_images_per_study: int = 30
    max_frames_per_instance: int = 1
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
        if not re.fullmatch(r"[0-9a-fA-F]{96}", self.bridge_key):
            raise BridgeError("bridge_key harus berupa kunci 96 karakter dari aplikasi.")
        endpoint = urlparse(self.apps_script_url)
        if endpoint.scheme != "https" or endpoint.hostname != "script.google.com" or not endpoint.path.endswith("/exec"):
            raise BridgeError("apps_script_url harus berupa URL deployment https://script.google.com yang berakhiran /exec.")
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
                "PatientName", "PatientID", "PatientBirthDate", "StudyDate",
                "StudyInstanceUID", "AccessionNumber", "StudyDescription",
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
        completed = self.values.setdefault("completed_studies", {})
        completed[source_key] = datetime.now(timezone.utc).isoformat()
        cutoff = datetime.now(timezone.utc) - timedelta(days=90)
        self.values["completed_studies"] = {
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


def clean_patient_name(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").replace("^", " ")).strip()[:120]


def nik_candidate(value: Any) -> str:
    digits = re.sub(r"\D", "", str(value or ""))
    return digits if len(digits) == 16 else ""


def merged_study_tags(study: dict[str, Any]) -> dict[str, Any]:
    tags: dict[str, Any] = {}
    for key in ("MainDicomTags", "PatientMainDicomTags", "RequestedTags"):
        candidate = study.get(key)
        if isinstance(candidate, dict):
            tags.update(candidate)
    return tags


def study_payload(study: dict[str, Any], expected_images: int) -> dict[str, Any]:
    tags = merged_study_tags(study)
    return {
        "orthanc_study_id": str(study.get("ID") or ""),
        "study_instance_uid": str(tags.get("StudyInstanceUID") or ""),
        "patient_name": clean_patient_name(tags.get("PatientName")),
        "patient_id": str(tags.get("PatientID") or "")[:80],
        "patient_birth_date": dicom_date(tags.get("PatientBirthDate")),
        "study_date": dicom_date(tags.get("StudyDate")),
        "accession_number": str(tags.get("AccessionNumber") or "")[:80],
        "study_description": str(tags.get("StudyDescription") or "")[:160],
        "expected_images": expected_images,
    }


def source_key(bridge_id: str, study: dict[str, Any]) -> str:
    payload = study_payload(study, 0)
    identifier = payload["study_instance_uid"] or payload["orthanc_study_id"]
    return f"{bridge_id}|{identifier}"


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
    webapp: AppsScriptClient,
    state: SyncState,
    study: dict[str, Any],
) -> None:
    study_id = str(study.get("ID") or "")
    if not study_id:
        return
    key = source_key(config.bridge_id, study)
    if state.completed(key):
        return
    references = instance_references(orthanc, study_id, config.max_images_per_study)
    candidates, tag_skipped = image_candidates(
        orthanc,
        references,
        config.max_frames_per_instance,
        config.max_images_per_study,
    )
    expected_images = len(candidates) + tag_skipped
    metadata = study_payload(study, expected_images)
    response = webapp.post("upsert_study", study=metadata)
    if not response.get("should_upload"):
        if response.get("status") in {"READY", "IMPORTED", "REJECTED"}:
            state.mark_completed(key)
        return

    received = 0
    skipped = tag_skipped
    for series_id, instance_id, tags, frame_index in candidates:
        try:
            raw = orthanc.preview(instance_id, frame_index)
            bundle = make_jpeg_bundle(raw)
            image = {
                "orthanc_study_id": metadata["orthanc_study_id"],
                "study_instance_uid": metadata["study_instance_uid"],
                "orthanc_series_id": series_id,
                "orthanc_instance_id": instance_id,
                "sop_instance_uid": str(tags.get("SOPInstanceUID") or ""),
                "frame_index": frame_index,
                "original_filename": f"orthanc_{instance_id}_{frame_index}.jpg",
                **bundle,
            }
            webapp.post("upload_image", image=image)
            received += 1
        except BridgeError as exc:
            skipped += 1
            LOGGER.warning("Instance %s dilewati: %s", instance_id, exc)

    message = ""
    if skipped:
        message = f"{skipped} instance atau frame tidak dapat dikonversi oleh OrthancBridge."
    final = webapp.post(
        "finalize_study",
        study={
            "orthanc_study_id": metadata["orthanc_study_id"],
            "study_instance_uid": metadata["study_instance_uid"],
            "expected_images": expected_images,
            "skipped_images": skipped,
            "message": message,
        },
    )
    if final.get("status") == "READY":
        state.mark_completed(key)
    LOGGER.info("Studi %s selesai: %s gambar diterima, %s dilewati.", study_id, received, skipped)


def sync_once(config: BridgeConfig, orthanc: OrthancClient, webapp: AppsScriptClient, state: SyncState) -> None:
    system = orthanc.system()
    LOGGER.info("Terhubung ke Orthanc %s.", system.get("Version", "versi tidak diketahui"))
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
            sync_study(config, orthanc, webapp, state, study)
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
    arguments = parser.parse_args(argv)
    config_path = Path(arguments.config).resolve()
    try:
        config = BridgeConfig.load(config_path)
        base = config_path.parent
        configure_logging((base / config.log_file).resolve())
        signal.signal(signal.SIGINT, request_stop)
        signal.signal(signal.SIGTERM, request_stop)
        state = SyncState((base / config.state_file).resolve())
        orthanc = OrthancClient(config)
        webapp = AppsScriptClient(config)
        try:
            while not STOP_REQUESTED:
                try:
                    sync_once(config, orthanc, webapp, state)
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
            webapp.close()
    except BridgeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
