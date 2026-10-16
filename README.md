# Sistem Klaim USG BPJS

Google Apps Script application for integrated USG claim management, supporting documents, Orthanc DICOM intake, and private Drive backup. The existing FastAPI/LAN application in the parent directory is preserved; this sibling project does not use FastAPI, Node, Firebase, Supabase, PostgreSQL, or another backend.

Current milestone: **complete claim workflow plus a confirm-before-import OrthancBridge integration for a single Puskesmas**.

Current application version: **`6.10.1-verifier-readable-filenames`**. This release retains the doctor/schema safeguards and adds automatic, status-tracked delivery of each generated PDF version to a separate private verifier Drive folder using its readable logical filename.

Implemented:

- idempotent `setupApplication()` for one Spreadsheet and private Drive hierarchy;
- exact `USERS`, `FACILITIES`, `CLAIMS`, `DOCUMENTS`, `AUDIT_LOG`, and `SETTINGS` schemas;
- salted and peppered password verification without plaintext password storage;
- configurable password work factor and temporary lockout after failed attempts;
- default initial password `admin123` with mandatory first-login password change;
- minimum password length of 6 characters and a maximum of 128 characters;
- hashed, expiring, and revocable application sessions;
- server-side allowlist, active-state, domain, role, permission, and claim-access helpers;
- admin-only user management and system diagnostics;
- administrator user deletion with self-delete and claim-history safeguards;
- Indonesian claim dashboard with search, status/date filters, and complete patient names, NIK, No. HP, and doctor names for authorized users;
- create, view, and edit claim data with server-side NIK, No. HP, doctor-name, and date validation;
- facility-scoped staff access and administrator-only claim archiving;
- private per-claim Drive folder creation using claim codes without patient identifiers;
- sequential multi-image USG upload from a computer with browser-side resizing and JPEG optimization;
- PDF/JPEG/PNG supporting-document selection for KTP (identity), Buku KIA, SPP/FKPP BPJS, and other documents; photos and PDF pages are optimized without cropping to a landscape 1280 x 720 or portrait 720 x 1280 HD boundary;
- direct phone login, facility-scoped claim selection, and supporting-document upload from the normal claim page without forcing the camera picker;
- retained short-lived hashed QR-token workflow, disabled by default through `ENABLE_MOBILE_QR_UPLOAD`;
- server-authorized private thumbnails and full-image previews without Drive sharing links;
- SHA-256 duplicate detection and recoverable document deletion with audit records;
- PDF selection, client-side 90-degree rotation, and persistent drag-and-drop ordering;
- configurable required-document validation and mandatory same-patient confirmation;
- A4 PDF composition through a temporary private Google Doc, with the full NIK, No. HP, and doctor name on the authorized cover;
- sequential PDF versions stored privately in each claim's `OUTPUT` folder;
- authorized in-app PDF preview/download without Drive sharing links;
- claim completion and reopening by any authenticated user who can access the claim;
- local outbound-only OrthancBridge ingestion with hashed bearer-key authentication;
- Orthanc inbox review with clickable full-size private image preview, flexible NIK/doctor detection from `PatientID` and `PatientComments`, DICOM metadata prefill, JPEG preview import, duplicate-study protection, and stored Study/Series/Instance references;
- resumable upload of each original DICOM instance into the private claim `DICOM` folder;
- optional secondary-Drive backup of original DICOM files and generated claim PDFs using anonymous deterministic storage names, with private database reconstruction metadata;
- fail-closed access-denied page;
- Bahasa Indonesia responsive application shell;
- no direct/public Drive sharing.

The remaining work is live acceptance testing against Google Apps Script, Google Docs conversion, Drive, desktop browsers, and the clinic's phones. Local static checks cannot prove those external behaviors.

The QR generator and the lazily loaded PDF.js component are listed in [docs/THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md).

The frozen workflow, logic, operational rules, and validation boundary for version `5.0.0-orthanc-bridge` are documented in [docs/BASELINE_WORKFLOW_DAN_ATURAN.md](docs/BASELINE_WORKFLOW_DAN_ATURAN.md), with a Word copy in [docs/BASELINE_WORKFLOW_DAN_ATURAN.docx](docs/BASELINE_WORKFLOW_DAN_ATURAN.docx).

## Project layout

```text
bpjs-usg-app/
├── src/                  Apps Script source and manifest
├── docs/                 deployment, security, architecture, user guide
├── tests/                local static security/schema checks
├── .claspignore
├── .gitignore
└── PROJECT_SPEC.md
```

## Deploy

Read [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). In short: replace the Apps Script files, delete the obsolete OAuth service, run `setupApplication()`, redeploy as the administrator, then use Pengguna to assign usernames. New accounts use `admin123` and must change it immediately after the first login. For Orthanc, continue with [docs/ORTHANC_BRIDGE.md](docs/ORTHANC_BRIDGE.md).

Never grant normal staff direct access to the database Spreadsheet, root folder, claim folders, or stored files.

## Local verification

From this directory in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\tests\static-checks.ps1
node .\tests\auth-flow-tests.js
node .\tests\browser-auth-smoke.js
node .\tests\client-image-tests.js
node .\tests\pdf-layout-tests.js
node .\tests\browser-supporting-upload-smoke.js
node .\tests\backup-service-tests.js
node .\tests\identity-display-tests.js
node .\tests\claim-phone-tests.js
node .\tests\claim-doctor-reopen-tests.js
node .\tests\orthanc-service-tests.js
.\orthanc-bridge\.venv\Scripts\python.exe -m unittest discover -s .\orthanc-bridge\tests -v
```

Static checks do not prove live Apps Script, Sheet, Drive, supporting-file selection, or phone behavior. Complete the administrator/staff upload tests in the deployment guide before beginning PDF work.

## Secondary Drive backup

Create a private folder in the approved second Google Drive account and share only that folder as **Editor** with the account that deploys Apps Script. Set its folder ID as the `BACKUP_DRIVE_FOLDER_ID` Script Property, run `setupApplication()`, then run `validateSecondaryBackupConfiguration()` once from the Apps Script editor. Do not put a password, OAuth client secret, service-account JSON, or a whole Drive configuration in source code.

The backup root receives private `DICOM RAW`, `DICOM`, and `KLAIM` subfolders. Every original DICOM is copied immediately to `DICOM RAW`, whether or not a claim has been created. Drive filenames contain only a file-type prefix, a versioned HMAC code, an optional sequence/version suffix, and the extension: `DICOM_RAW_F1<KODE>.dcm`, `DICOM_F1<KODE>[_NNN].dcm`, `KLAIM_F1<KODE>_vNNN.pdf`, and `KLAIM_F1<KODE>.pdf`. The private Spreadsheet stores the original/logical filename, anonymous storage filename, file ID, and Drive URL. PDF downloads reconstruct the original filename automatically; DICOM mappings can be resolved from the `ORTHANC_DICOMS` row. `F1` is one-way, so preserve this database mapping with the Drive data. Never replace or delete the `FILENAME_CODE_SECRET` Script Property after setup. Run `backupExistingClaimFiles()` repeatedly to anonymize and backfill current raw DICOM, claim-linked DICOM, latest generated PDFs, URLs, and filename mappings; it is idempotent and processes bounded batches.

## Verifier Drive delivery

Create a separate private folder in the verifier's Google Drive account and share only that folder as **Editor** with the Apps Script deployment account. Set its ID as the `VERIFIER_DRIVE_FOLDER_ID` Script Property, run `setupApplication()`, then run `validateVerifierDriveConfiguration()` once from the Apps Script editor. This enables automatic delivery of every newly generated PDF to the verifier folder; the primary PDF and secondary backup remain independent.

The verifier root receives a private `KLAIM` subfolder. Unlike the primary and backup Drive copies, verifier files use the readable logical name `KLAIM_<Puskesmas>_<YYYYMMDD>_<NIK>_<NO_HP>_vNNN.pdf`. Earlier versions are retained for verification history. The file ID, private URL, timestamp, and delivery status stay in the private `CLAIMS` sheet, and no verifier Drive URL is returned to the staff browser. Because the filename contains patient identifiers, keep this folder restricted. Do not enable link sharing or store the verifier account password, OAuth secret, or service-account JSON in the project.

The administrator should back up the database Spreadsheet and private Drive tree according to the organization’s approved health-data retention and encryption policy. Do not copy patient files to public or personal storage. Test restoration periodically and preserve the relationship between metadata and Drive file IDs.
