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

Phase 4 adds document selection, physical client-side image rotation, and atomic order persistence. `PdfService.gs` validates configured requirements, requires explicit same-patient confirmation, creates a temporary private A4 Google Doc, exports it to a versioned PDF in the claim's private `OUTPUT` folder, and trashes the temporary document. Preview and download return authorized Base64 content rather than a Drive URL. Completion locks the claim; only an administrator can reopen it.

```text
PC/ponsel -> optimasi Canvas -> base64 satu gambar per permintaan
          -> sesi aplikasi + otorisasi klaim/token
          -> validasi MIME, signature, ukuran, hash duplikat
          -> file Drive privat + thumbnail privat
          -> satu baris DOCUMENTS + AUDIT_LOG
```
