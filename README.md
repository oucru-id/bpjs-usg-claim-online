# Sistem Klaim USG BPJS

Google Apps Script application for integrated USG claim management, supporting documents, Orthanc DICOM intake, and private Drive backup. The existing FastAPI/LAN application in the parent directory is preserved; this sibling project does not use FastAPI, Node, Firebase, Supabase, PostgreSQL, or another backend.

Current milestone: **complete claim workflow plus a confirm-before-import OrthancBridge integration for a single Puskesmas**.

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
- Indonesian claim dashboard with search, status/date filters, and complete patient names, NIK, and No. HP values for authorized users;
- create, view, and edit claim data with server-side NIK, No. HP, and date validation;
- facility-scoped staff access and administrator-only claim archiving;
- private per-claim Drive folder creation using claim codes without patient identifiers;
- sequential multi-image USG upload from a computer with browser-side resizing and JPEG optimization;
- mobile camera upload for KTP (identity), Buku KIA, SPP/FKPP BPJS, and other documents, compressed without cropping to a landscape 1280 x 720 or portrait 720 x 1280 HD boundary;
- direct phone login, facility-scoped claim selection, and camera upload from the normal claim page;
- retained short-lived hashed QR-token workflow, disabled by default through `ENABLE_MOBILE_QR_UPLOAD`;
- server-authorized private thumbnails and full-image previews without Drive sharing links;
- SHA-256 duplicate detection and recoverable document deletion with audit records;
- PDF selection, client-side 90-degree rotation, and persistent drag-and-drop ordering;
- configurable required-document validation and mandatory same-patient confirmation;
- A4 PDF composition through a temporary private Google Doc, with the full NIK and No. HP on the authorized cover;
- sequential PDF versions stored privately in each claim's `OUTPUT` folder;
- authorized in-app PDF preview/download without Drive sharing links;
- claim completion and administrator-only reopening;
- local outbound-only OrthancBridge ingestion with hashed bearer-key authentication;
- Orthanc inbox review, DICOM metadata prefill, JPEG preview import, duplicate-study protection, and stored Study/Series/Instance references;
- resumable upload of each original DICOM instance into the private claim `DICOM` folder;
- optional secondary-Drive backup of original DICOM files and generated claim PDFs using anonymous deterministic storage names, with private database reconstruction metadata;
- fail-closed access-denied page;
- Bahasa Indonesia responsive application shell;
- no direct/public Drive sharing.

The remaining work is live acceptance testing against Google Apps Script, Google Docs conversion, Drive, desktop browsers, and the clinic's phones. Local static checks cannot prove those external behaviors.

The bundled QR generator is listed in [docs/THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md).

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
node .\tests\backup-service-tests.js
node .\tests\identity-display-tests.js
node .\tests\claim-phone-tests.js
node .\tests\orthanc-service-tests.js
.\orthanc-bridge\.venv\Scripts\python.exe -m unittest discover -s .\orthanc-bridge\tests -v
```

Static checks do not prove live Apps Script, Sheet, Drive, or phone-camera behavior. Complete the administrator/staff upload tests in the deployment guide before beginning PDF work.

## Secondary Drive backup

Create a private folder in the approved second Google Drive account and share only that folder as **Editor** with the account that deploys Apps Script. Set its folder ID as the `BACKUP_DRIVE_FOLDER_ID` Script Property, run `setupApplication()`, then run `validateSecondaryBackupConfiguration()` once from the Apps Script editor. Do not put a password, OAuth client secret, service-account JSON, or a whole Drive configuration in source code.

The backup root receives private `DICOM RAW`, `DICOM`, and `KLAIM` subfolders. Every original DICOM is copied immediately to `DICOM RAW`, whether or not a claim has been created. Drive filenames contain only a file-type prefix, a versioned HMAC code, an optional sequence/version suffix, and the extension: `DICOM_RAW_F1<KODE>.dcm`, `DICOM_F1<KODE>[_NNN].dcm`, `KLAIM_F1<KODE>_vNNN.pdf`, and `KLAIM_F1<KODE>.pdf`. The private Spreadsheet stores the original/logical filename, anonymous storage filename, and Drive URL. PDF downloads reconstruct the original filename automatically; DICOM mappings can be resolved from the `ORTHANC_DICOMS` row. Never replace or delete the `FILENAME_CODE_SECRET` Script Property after setup. Run `backupExistingClaimFiles()` repeatedly to anonymize and backfill current raw DICOM, claim-linked DICOM, latest generated PDFs, URLs, and filename mappings; it is idempotent and processes bounded batches.

The administrator should back up the database Spreadsheet and private Drive tree according to the organization’s approved health-data retention and encryption policy. Do not copy patient files to public or personal storage. Test restoration periodically and preserve the relationship between metadata and Drive file IDs.
