# Architecture

The Apps Script web app executes as its deploying administrator. Staff authenticate using application usernames and passwords; they never authenticate to the private Spreadsheet or Drive storage directly.

```text
Browser -> username/password -> server verification
                             -> hashed application session
                             -> role and facility authorization
                             -> private Sheets metadata
                             -> private Drive files
```

`AUTH_CREDENTIALS` stores password-verification metadata, account lockout state, and the `must_change_password` flag. `PASSWORD_PEPPER` is separate in Script Properties. `AUTH_SESSIONS` stores only session-token hashes and expiry/revocation timestamps. The raw password exists only during the login, password-change, or administrator reset request; the raw session token exists only in protected browser storage and is removed on logout.

An account created with the default `admin123` password, or reset by an administrator, can only bootstrap the password-change screen. Protected server functions reject that session until the flag is cleared by a successful password change. Changing the password revokes the temporary session and returns a newly generated session token.

The deploying administrator's Google identity is used only as a bootstrap path while that administrator has no application credential. Creating the administrator credential permanently disables that path during normal web requests. All users then require username/password authentication.

Phase 2 adds `ClaimService.gs` for filtered claim listing, validated create/update operations, status transition, and archiving. `DriveService.gs` creates a private folder named with the opaque claim code and the future upload/output subfolders. The `CLAIMS` Sheet remains the metadata source of truth; the browser receives only claims authorized for the current session.

Phase 3 adds `DocumentService.gs` for validated image upload, private thumbnail/preview delivery, duplicate detection, metadata, and recoverable deletion. In the default single-Puskesmas mode, PC and phone use the same authenticated claim page; the server authorizes every request by session and facility. `TokenService.gs` and the locally generated QR workflow are retained but disabled by `ENABLE_MOBILE_QR_UPLOAD=false`. If enabled later, only token hashes are stored and no token is sent to a QR service.

Phase 4 adds document selection, physical client-side image rotation, and atomic order persistence. `PdfService.gs` validates configured requirements, requires explicit same-patient confirmation, creates a temporary private A4 Google Doc, exports it to a versioned PDF in the claim's private `OUTPUT` folder, and trashes the temporary document. Preview and download return authorized Base64 content rather than a Drive URL. Completion locks document operations and claim-data editing. An authenticated user who passes the existing claim-access check must explicitly reopen a completed claim before editing it. Editing a Ready/PDF-generated claim returns it to Collecting Documents so the PDF must be regenerated, while archiving remains administrator-only.

`VerifierDriveService.gs` optionally copies each newly generated PDF to a separate private Drive folder owned by the verifier account. Delivery places the latest copy directly under `<BULAN INDONESIA YYYY>` in the configured verifier parent folder, without an intermediate `KLAIM` folder, using the readable filename `KLAIM_USG_PKM_<PUSKESMAS>_<YYYYMMDD>_<NAMA_PASIEN>_<NIK>_DR_<NAMA_DOKTER>.pdf`. It records the latest result in `CLAIMS` and is deliberately isolated from primary PDF creation and the secondary DICOM/PDF backup. Regeneration replaces the previously tracked verifier copy, while the primary version history remains intact. The primary and backup copies keep anonymous `F1` names. The staff browser receives only delivery status, never the verifier file ID or Drive URL.

`GcsService.gs` is a separate best-effort delivery target. `generateClaimPdf` creates a new private PDF version and marks its GCS status as waiting. When `completeClaim` locks the reviewed claim, the service authenticates as the bucket-scoped service account stored in Script Properties and uploads that anonymous versioned `F1` PDF through the GCS JSON API. A GCS failure is recorded without rolling back the completed claim or deleting its primary Drive PDF. OrthancBridge independently uploads content-addressed DICOM and JPEG objects with the Python GCS client. The local state tracks Drive, GCS DICOM, and GCS JPEG completion separately, so retry or disabling one destination does not mark another destination complete.

`WhatsAppService.gs` is an opt-in console over the private BigQuery/GCS registry. Every list query is filtered by the installation's configured `ORTHANC_BRIDGE_ID`; every endpoint also requires the explicit `can_send_whatsapp` permission. JPEG bytes are fetched server-side with the service account and returned only to an authenticated browser—no public or permanent signed URL is created. Manual sends validate the selected `object_key` values against that bridge-scoped study, acquire one stable BigQuery outbox row per selected batch, and call n8n with the explicit selection. Only provider-confirmed `SENT`/`DELIVERED` state (or `sent_at`) is shown as sent; webhook acceptance remains “Dalam proses”.

Automatic OrthancBridge delivery uses the same outbox and explicit-selection contract but selects only the first eligible JPEG ordered by sequence, frame, and object key. It reads the patient name, normalized phone, doctor, and selected image from the private BigQuery view after registry sync; it does not parse DICOM identity a second time for the trigger. Remaining JPEGs stay available for manual selection in the web app.

```text
PC/ponsel -> optimasi Canvas -> base64 satu gambar per permintaan
          -> sesi aplikasi + otorisasi klaim/token
          -> validasi MIME, signature, ukuran, hash duplikat
          -> file Drive privat + thumbnail privat
          -> satu baris DOCUMENTS + AUDIT_LOG
```
