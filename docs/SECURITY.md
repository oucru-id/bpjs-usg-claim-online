# Security model

## Password storage

- Plaintext passwords are never written to Sheets, Script Properties, logs, audit records, or HTML responses.
- Each account receives a unique random salt.
- Passwords are processed with a configurable iterated HMAC-SHA-256 derivation.
- A random application pepper is stored separately in Script Properties, never in the credential sheet or browser.
- Password comparison avoids early-exit string comparison.
- Password resets revoke all existing sessions for that user.

The `AUTH_CREDENTIALS` sheet stores only the username, salt, derived hash, algorithm/version, iteration count, lockout state, and timestamps. OWASP recommends purpose-built algorithms such as Argon2id, scrypt, bcrypt, or PBKDF2 where available; Apps Script does not provide those password APIs directly. This implementation uses a separate pepper, configurable work factor, forced temporary-password change, and online lockout, but Google/OIDC authentication remains the higher-assurance option.

See the [OWASP Password Storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).

## Login protection

- Usernames are normalized to lowercase and restricted to a safe character set.
- Passwords must be 6-128 characters. Longer unique passwords are strongly recommended.
- New accounts default to `admin123`, but this temporary password cannot access protected features and must be changed immediately after login.
- Administrator resets are also temporary and force another password change.
- Unknown users and incorrect, disabled, or locked accounts receive the same generic error.
- Five failed attempts lock the account for 15 minutes by default.
- Authentication success and known-account failures are audited without recording passwords.

## Sessions and authorization

- Successful login creates a random opaque session token.
- Browser menyimpan token di `localStorage` agar sesi tetap tersedia setelah halaman dimuat ulang atau iframe Google Apps Script dibuat ulang. `sessionStorage` dipakai sebagai cadangan kompatibilitas.
- Sheets stores only the SHA-256 token hash.
- Sessions expire after eight hours by default and can be revoked.
- Tombol **Keluar** menghapus token dari kedua penyimpanan browser dan mencabut sesi pada server. Karena komputer Puskesmas dapat dipakai bersama, petugas wajib menekan **Keluar** setelah selesai.
- A successful password change revokes the old session and issues a replacement session token.
- Every protected server function calls `requireAuthenticatedUser()`, `requireRole()`, or `requirePermission()`.
- A disabled user is rejected immediately even if a session previously existed.

## Storage boundary

The web app executes as the deploying administrator. Staff are not granted direct access to the Spreadsheet, Drive folders, images, or PDFs. No source function creates public Drive sharing.

PDF generation uses a temporary private Google Doc owned by the deploying administrator. The application converts it to PDF, stores the versioned output in the claim's private `OUTPUT` folder, and moves the temporary Google Doc to trash in a `finally` cleanup path. Preview and download return authorized content through the application and never expose a Drive sharing URL.

When verifier delivery is enabled, every newly generated PDF is also copied to a dedicated private folder owned by the approved verifier account. Only that folder is shared as Editor with the deployment account. By operational request, verifier filenames are readable and contain Puskesmas, examination date, NIK, and phone number; primary and backup Drive filenames remain anonymous. Verifier URLs remain only in the private database, and a delivery failure does not remove the primary PDF. Both the filename and PDF body therefore contain identifiable patient data, so the verifier account and retention process must remain inside the approved health-data boundary.

## Claim privacy and authorization

- Every claim list/detail/create/update/status/archive endpoint authenticates on the server.
- Staff access is restricted by facility unless an administrator explicitly grants **Lihat semua klaim**.
- The claim list remains access-filtered by role and facility and displays complete patient names, NIK, No. HP, and doctor names to authenticated users who can access those claims. The Orthanc inbox displays the complete patient name, raw DICOM PatientID/PatientComments, detected NIK, and detected doctor name only to users with claim-creation permission.
- Reopening or editing a completed claim requires an authenticated session and normal claim access; this allows staff within their facility/access scope without granting broader claim visibility. A data edit returns the claim to Collecting Documents and requires a new PDF version. Archiving remains administrator-only.
- Claim codes and Drive folder names never contain patient names, NIK, No. HP, doctor names, or birth dates.
- Claims are archived rather than permanently deleted.
- Audit details contain claim codes/statuses, not full patient payloads.

## Keamanan unggah gambar dan ponsel

- Gambar diperkecil di browser dan dikirim satu per satu; server membatasi ukuran hasil optimasi hingga 6 MB.
- Berkas pendukung PDF dibatasi 25 MB dan 20 halaman. PDF.js merender setiap halaman menjadi JPEG di browser; file PDF asli tidak dikirim ke cdnjs atau disimpan sebagai dokumen klaim. Evaluasi kode dan scripting PDF dinonaktifkan.
- Server hanya menerima JPEG/PNG, memeriksa tanda tangan byte berkas, dimensi, jenis dokumen, dan batas jumlah dokumen.
- SHA-256 digunakan untuk menolak gambar duplikat yang masih aktif dalam klaim yang sama.
- Nama berkas gambar pendukung dibuat dari jenis dokumen dan UUID. Nama fisik DICOM dan PDF di Drive memakai kode HMAC anonim berbasis ID internal dan `FILENAME_CODE_SECRET`; nama logis yang memuat identitas hanya disimpan bersama URL pada database privat untuk rekonstruksi. Seluruh folder utama, database, dan backup tetap wajib privat dan tidak boleh dibagikan melalui tautan publik.
- Kode `F1` bersifat satu arah dan tidak dapat didekripsi. Pemulihan nama asli membutuhkan mapping privat pada `CLAIMS` dan `ORTHANC_DICOMS`; database, file ID, dan URL Drive harus dicadangkan bersama data Drive.
- Foto berkas pendukung dari ponsel diperkecil di browser tanpa dipotong ke batas lanskap 1280 x 720 atau potret 720 x 1280. Server menolak unggahan baru yang melewati batas tersebut; gambar USG dari komputer memakai batas terpisah agar detail klinis tidak ikut diturunkan.
- Thumbnail dan pratinjau dikirim sebagai Base64 hanya setelah otorisasi server; aplikasi tidak memberikan URL Drive.
- Token ponsel terdiri dari nilai acak 96 karakter; hanya hash token yang disimpan pada `CLAIMS`.
- Pengguna ponsel harus memiliki sesi aplikasi aktif, akses ke klaim, dan token yang belum kedaluwarsa/dicabut.
- Membuat QR baru mengganti token lama. Menyelesaikan unggah, mengarsipkan klaim, atau kedaluwarsa membuat token tidak berlaku.
- Penghapusan oleh staf menandai metadata sebagai terhapus dan memindahkan file ke Sampah Drive agar riwayat audit tetap tersedia.
- Dalam mode Puskesmas tunggal, ponsel memakai halaman klaim biasa. Setiap unggahan tetap memerlukan sesi aplikasi aktif dan akses ke fasilitas klaim.
- Alur token/QR dipertahankan tetapi dinonaktifkan secara bawaan melalui `ENABLE_MOBILE_QR_UPLOAD=false`.

## Keamanan OrthancBridge

- Orthanc tidak boleh dipublikasikan langsung ke internet. Bridge berjalan pada PC lokal dan hanya membuat koneksi HTTPS keluar menuju deployment Apps Script.
- Administrator membuat kunci acak 96 karakter. Apps Script hanya menyimpan hash SHA-256 kunci; nilai asli ditampilkan satu kali untuk disimpan pada `config.json` di PC Orthanc.
- ID bridge dan kunci diperiksa menggunakan pembandingan waktu-konstan sebelum metadata atau gambar diproses.
- Bridge mengirim gambar satu per satu. Server memeriksa jenis JPEG, tanda tangan byte, ukuran, dimensi, dan identitas studi sebelum menyimpannya pada folder penampungan privat.
- Nama pasien, NIK, No. HP, Nama Dokter, dan gambar tidak ditulis ke log bridge atau detail audit.
- Daftar kotak masuk menyamarkan identitas. Data lengkap, thumbnail, dan pratinjau gambar ukuran penuh hanya diberikan melalui aplikasi setelah sesi mempunyai izin membuat klaim; URL Drive tidak dibagikan.
- Klaim tidak dibuat otomatis. Petugas wajib memeriksa data pasien, memilih gambar, dan mencentang konfirmasi pasien.
- `StudyInstanceUID`, ID study/series/instance Orthanc, serta indeks frame disimpan untuk mencegah impor berulang dan menjaga ketertelusuran.
- Menonaktifkan bridge menghentikan permintaan baru tanpa menghapus data yang sudah diterima. Mengganti kunci langsung membatalkan kunci lama.

Because the login page is internet reachable and this application will handle identifiable health records, use unique high-entropy passwords, restrict administrator/editor access, review `AUDIT_LOG`, and rotate passwords when staff leave or devices are lost.
