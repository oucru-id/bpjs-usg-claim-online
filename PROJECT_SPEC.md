# BPJS USG Online Claim App — implementation scope

This project implements the supplied “BPJS USG Online Claim App — Codex-Cursor Build Specification” as a modular Google Apps Script web app backed by one private Google Sheet and private Google Drive folders.

Security invariants:

- Users authenticate with application-managed usernames and passwords.
- The deployed web app executes as the deploying administrator.
- Every protected server function authorizes independently against `USERS`.
- Blank active-user email fails closed.
- Sheet, folders, images, and PDFs are never shared publicly or directly with staff.
- Patient identifiers do not appear in URLs, public links, technical logs, or generated storage filenames.
- Direct public Orthanc access, a browser DICOM viewer, external Google accounts, and BPJS submission remain outside the application boundary. Orthanc integration uses a separate outbound-only local bridge and mandatory staff confirmation.

The revised authentication boundary uses salted/peppered password hashes, login lockout, and hashed expiring sessions while retaining server-side role and facility authorization. Claim and document operations must not be enabled until the live Phase 1 tests pass.
