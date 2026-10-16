# Panduan Implementasi Sistem Klaim USG BPJS

## Puskesmas dengan PC dan Akun Google Sendiri, Terhubung ke Akun Backup dan Verifikator

**Versi aplikasi acuan:** `6.10.1-verifier-readable-filenames`

**Tanggal dokumen:** 3 Oktober 2026
**Sasaran:** administrator TI, penanggung jawab program, dan petugas Puskesmas

---

## 1. Tujuan

Dokumen ini menjelaskan pemasangan satu ekosistem Sistem Klaim USG BPJS pada Puskesmas baru dengan prinsip berikut:

1. Puskesmas memakai akun Google operasional milik institusi sendiri.
2. Aplikasi, database utama, dan folder klaim utama dimiliki akun operasional Puskesmas.
3. Alat USG mengirim DICOM ke Orthanc pada PC Puskesmas melalui jaringan lokal.
4. OrthancBridge mengirim data keluar melalui HTTPS ke Apps Script; Orthanc tidak dibuka ke internet.
5. Akun Google backup yang terpisah menyimpan salinan DICOM dan PDF klaim pada folder privat.
6. Akun Google verifikator yang terpisah menerima setiap versi PDF yang baru dibuat pada folder privat.
7. Petugas tetap harus memeriksa identitas pasien sebelum pemeriksaan Orthanc dibuat menjadi klaim.

Panduan ini adalah prosedur instalasi baru. Jangan menyalin rahasia, password pepper, kunci bridge, sesi, atau berkas konfigurasi privat dari Puskesmas lain.

### Catatan penting untuk rilis terbaru

Source saat ini menggunakan nama penyimpanan anonim `F1` berbasis HMAC dan `FILENAME_CODE_SECRET`. Rilis ini **tidak** memakai Cloud KMS, filename `E1`, `FILENAME_KMS_KEY_NAME`, scope `cloud-platform`, atau `FilenameCryptoService.gs`. Jika masih memiliki salinan panduan eksperimen KMS sebelumnya, jangan ikuti bagian tersebut untuk instalasi ini. `FILENAME_CODE_SECRET` dibuat otomatis oleh `setupApplication()` dan tidak boleh disalin dari Puskesmas lain.

## 2. Topologi yang akan dibuat

```text
Alat USG
  | DICOM lokal: TCP 4242
  v
PC Puskesmas
  |- Orthanc (REST hanya localhost:8042)
  `- OrthancBridge
       | koneksi keluar HTTPS
       v
Akun Google operasional Puskesmas
  |- Apps Script Web App
  |- Spreadsheet database privat
  `- Drive utama privat: BPJS_USG_APP
       |
       | salinan oleh Apps Script
       v
Akun Google backup
  `- Folder privat BPJS_USG_BACKUP
       |- DICOM RAW
       |- DICOM
       `- KLAIM

Akun Google verifikator
  `- Folder privat BPJS_USG_VERIFIKATOR
       `- KLAIM (PDF per versi)
```

PC lain dan ponsel petugas tidak perlu memasang Orthanc. Perangkat tersebut cukup membuka URL produksi `/exec` melalui browser dan masuk memakai username/password aplikasi.

## 3. Pembagian akun dan tanggung jawab

| Komponen | Pemilik yang disarankan | Fungsi |
|---|---|---|
| Akun Google operasional | Puskesmas | Membuat Apps Script, deployment, database, dan Drive utama |
| Akun Google backup | Institusi/penanggung jawab backup | Memiliki folder backup privat |
| Akun Google verifikator | Verifikator klaim yang berwenang | Memiliki folder penerimaan PDF privat |
| Akun aplikasi ADMIN | Administrator Puskesmas | Mengelola pengguna, diagnostik, dan OrthancBridge |
| Akun aplikasi STAFF | Petugas berwenang | Mengelola klaim dan dokumen sesuai izin |
| Akun Windows bridge | PC Orthanc | Menjalankan Scheduled Task OrthancBridge |

Aturan akun:

- Gunakan akun institusi, bukan akun pribadi petugas.
- Aktifkan verifikasi dua langkah pada ketiga akun Google.
- Simpan metode pemulihan dan recovery code sesuai kebijakan institusi.
- Batasi pemegang akun operasional, backup, dan verifikator kepada petugas yang diberi kewenangan atas data pasien.
- Jangan memakai password Google sebagai password aplikasi.
- Jangan membagikan database, folder utama, folder backup, atau folder verifikator dengan opsi **Anyone with the link**.
- Jangan memasukkan password akun backup/verifikator ke source, Script Properties, `config.json`, chat, atau Git.

## 4. Cakupan koneksi ke akun backup

Backup Drive kedua yang sudah diimplementasikan aplikasi mencakup:

| Data | Lokasi backup | Waktu penyalinan |
|---|---|---|
| DICOM asli sebelum klaim dikonfirmasi | `DICOM RAW` | Setelah DICOM diterima aplikasi |
| DICOM yang sudah dikaitkan dengan klaim | `DICOM` | Setelah petugas mengonfirmasi klaim |
| PDF klaim terbaru | `KLAIM` | Setelah PDF berhasil dibuat |

Nama fisik pada kedua Drive menggunakan kode anonim HMAC (`DICOM_RAW_F1<KODE>.dcm`, `DICOM_F1<KODE>[_NNN].dcm`, `KLAIM_F1<KODE>_vNNN.pdf`, dan `KLAIM_F1<KODE>.pdf`). Spreadsheet privat menyimpan nama logis, nama fisik anonim, dan URL file untuk rekonstruksi nama asli. Kode `F1` tidak dapat didekripsi; rekonstruksi bergantung pada mapping database privat.

Backup otomatis ini **tidak** mencakup:

- Spreadsheet database;
- Script Properties dan rahasia autentikasi;
- source/deployment Apps Script;
- akun aplikasi dan sesi login;
- file PDF asli dan foto dokumen pendukung selain halaman/gambar yang sudah dimasukkan ke PDF klaim;
- konfigurasi lokal Orthanc, `config.json`, atau `state.json`;
- pemulihan otomatis jika akun operasional tidak dapat digunakan.

Karena itu, akun backup adalah lokasi salinan data penting, bukan hot standby. Untuk pemulihan penuh, institusi tetap memerlukan SOP snapshot database, source versi rilis, konfigurasi terenkripsi, dan uji pemulihan berkala. Jangan menganggap folder backup saja cukup untuk membangun kembali aplikasi.

## 5. Prasyarat sebelum datang ke lokasi

Siapkan dan catat:

### 5.1 Akun dan Google

- [ ] Akun Google operasional Puskesmas aktif.
- [ ] Akun Google backup aktif dan disetujui sebagai penyimpan data kesehatan.
- [ ] Akun Google verifikator aktif dan disetujui untuk menerima PDF klaim.
- [ ] Verifikasi dua langkah aktif pada ketiga akun.
- [ ] Ruang Drive ketiga akun cukup untuk DICOM dan PDF.
- [ ] Kebijakan Google Workspace mengizinkan deployment web app yang diperlukan.
- [ ] Folder source `bpjs-usg-app` versi rilis tersedia.

### 5.2 PC dan jaringan

- [ ] PC Windows untuk Orthanc tersedia dan dalam kondisi sehat.
- [ ] PC mempunyai ruang disk yang cukup dan sinkronisasi waktu aktif.
- [ ] Alamat IP PC Orthanc dibuat tetap atau mendapat DHCP reservation.
- [ ] Internet stabil untuk koneksi keluar HTTPS.
- [ ] Browser PC dan ponsel dapat mengakses `cdnjs.cloudflare.com` untuk memuat PDF.js ketika pengguna memilih PDF pendukung.
- [ ] Python tersedia dan dapat dipanggil dengan perintah `python`.
- [ ] Akun Windows khusus/terkendali tersedia untuk menjalankan bridge.

### 5.3 Alat USG

Catat untuk setiap alat:

| Informasi | Nilai lokasi |
|---|---|
| Nama/tipe alat |  |
| IP alat USG |  |
| AE Title alat USG |  |
| DICOM port alat |  |
| Mendukung DICOM Send/PACS | Ya / Tidak |
| IP PC Orthanc |  |
| AE Title Orthanc |  |
| Port DICOM Orthanc | `4242` |

Jika alat tidak mendukung DICOM Send/PACS, alur OrthancBridge tidak dapat digunakan tanpa metode ekspor lain yang disetujui.

## 6. Fase A — Persiapan akun operasional dan akun backup

### Langkah A1 — Masuk ke profil browser yang benar

1. Buat profil browser khusus untuk akun Google operasional Puskesmas.
2. Pastikan avatar dan alamat email yang aktif adalah akun Puskesmas.
3. Jangan melakukan setup dari profil browser yang masih masuk sebagai akun pribadi atau akun Puskesmas lain.
4. Catat alamat email akun operasional pada lembar serah terima.

`setupApplication()` mengikat `ADMIN_EMAIL` kepada akun yang menjalankan setup pertama. Karena itu, pemeriksaan akun aktif sebelum menjalankan setup adalah langkah wajib.

### Langkah A2 — Buat folder di akun backup

1. Masuk ke Google Drive menggunakan akun backup.
2. Buat folder baru bernama, misalnya:

   ```text
   BPJS_USG_BACKUP_<NAMA_PUSKESMAS>
   ```

3. Pastikan **General access** adalah **Restricted**.
4. Bagikan hanya folder tersebut kepada akun Google operasional Puskesmas sebagai **Editor**.
5. Jangan membagikan seluruh My Drive akun backup.
6. Salin ID folder dari URL:

   ```text
   https://drive.google.com/drive/folders/FOLDER_ID
   ```

7. Simpan `FOLDER_ID` pada media administrasi yang aman. Jangan memasukkannya ke dokumen publik.

Koneksi antarakun dalam desain ini menggunakan izin folder. Tidak diperlukan password akun backup, OAuth client secret, atau service-account JSON.

### Langkah A3 — Buat folder di akun verifikator

1. Masuk ke Google Drive menggunakan akun verifikator.
2. Buat folder privat `BPJS_USG_VERIFIKATOR_<NAMA_PUSKESMAS>` dengan **General access: Restricted**.
3. Bagikan hanya folder tersebut kepada akun Google operasional sebagai **Editor**; jangan bagikan seluruh My Drive.
4. Salin ID folder dan simpan sebagai Script Property `VERIFIER_DRIVE_FOLDER_ID` setelah source disinkronkan.
5. Jangan menggunakan folder yang sama dengan Drive utama atau Drive backup.

## 7. Fase B — Membuat Apps Script pada akun Puskesmas

### Langkah B1 — Sesuaikan identitas Puskesmas sebelum setup pertama

Pada salinan source yang akan dipasang, buka `src/Config.gs` dan periksa:

```javascript
TIMEZONE: 'Asia/Makassar',
DEFAULT_FACILITY_ID: 'FACILITY_DEFAULT',
DEFAULT_FACILITY_NAME: 'Fasilitas Utama'
```

Ganti `DEFAULT_FACILITY_NAME` menjadi nama resmi Puskesmas. Pada `DEFAULT_SETTINGS`, ganti nilai awal `CLINIC_NAME` dengan nama yang sama. Ubah timezone hanya jika lokasi Puskesmas memang berada di zona waktu lain.

Lakukan penyesuaian ini sebelum `setupApplication()` pertama. Setup yang dijalankan ulang tidak menimpa baris fasilitas atau setting yang sudah ada.

### Langkah B2 — Buat proyek Apps Script baru

1. Dengan akun operasional Puskesmas, buka `https://script.google.com`.
2. Pilih **New project**.
3. Beri nama yang jelas, misalnya `BPJS USG - Puskesmas <Nama>`.
4. Buka **Project Settings**.
5. Aktifkan **Show appsscript.json manifest file in editor**.
6. Atur timezone proyek sesuai lokasi Puskesmas.

### Langkah B3 — Salin source secara lengkap

1. Salin semua berkas `.gs`, `.html`, dan `appsscript.json` dari folder `src/` ke proyek baru.
2. Pertahankan nama berkas dan jenisnya.
3. Pastikan `PasswordAuthService.gs`, `BackupService.gs`, `OrthancBridgeService.gs`, `PdfService.gs`, dan `VendorQrCode.html` ikut tersalin.
4. Pastikan tidak ada `OAuthService.gs` lama.
5. Ganti isi manifest dengan `src/appsscript.json` versi saat ini.
6. Simpan semua perubahan.

Jangan menyalin `.clasp.json`, `orthanc-bridge/config.json`, `state.json`, log, password pepper, kunci bridge, atau data pasien dari instalasi lain.

### Langkah B4 — Tambahkan ID folder backup

Sebelum validasi backup:

1. Buka **Project Settings**.
2. Pada **Script Properties**, tambahkan:

   ```text
   BACKUP_DRIVE_FOLDER_ID=<ID_FOLDER_DARI_AKUN_BACKUP>
   ```

3. Periksa kembali agar yang ditempel hanya ID folder, bukan seluruh URL dan bukan ID folder Puskesmas lain.

### Langkah B5 — Jalankan setup

1. Kembali ke editor Apps Script.
2. Pilih fungsi `setupApplication`.
3. Klik **Run**.
4. Setujui izin Google Drive, Sheets, Documents, dan external request yang diminta.
5. Pastikan fungsi selesai tanpa error.
6. Catat hasil yang menampilkan:

   - `appVersion` = `6.10.1-verifier-readable-filenames`;
   - `databaseSpreadsheetId`;
   - `rootDriveFolderId`;
   - `claimsFolderId`;
   - `systemFolderId`;
   - `orthancInboxFolderId`;
   - email administrator yang benar.

Setup boleh dijalankan ulang pada proyek yang sama. Namun, bila ID folder/database yang sudah dikonfigurasi tidak dapat diakses, setup sengaja berhenti dan tidak membuat pengganti diam-diam.

### Langkah B6 — Verifikasi hasil setup

Pada Drive akun operasional, pastikan tersedia:

```text
BPJS_USG_APP/
|- CLAIMS/
`- SYSTEM/
   |- ORTHANC_INBOX/
   `- BPJS_USG_APP_DATABASE
```

Pada Spreadsheet database, pastikan sedikitnya tersedia sheet:

```text
USERS
FACILITIES
CLAIMS
DOCUMENTS
AUDIT_LOG
AUTH_CREDENTIALS
AUTH_SESSIONS
ORTHANC_INBOX
ORTHANC_IMAGES
ORTHANC_DICOMS
SETTINGS
```

Pada Script Properties, pastikan ID utama, `ADMIN_EMAIL`, `PASSWORD_PEPPER`, `FILENAME_CODE_SECRET`, dan pengaturan autentikasi sudah terbentuk. Jangan menyalin nilai rahasia tersebut ke laporan atau chat. Pastikan tidak ada kewajiban menambahkan `FILENAME_KMS_KEY_NAME` untuk source versi ini.

## 8. Fase C — Menghubungkan dan menguji akun backup

### Langkah C1 — Validasi folder backup

1. Tetap masuk sebagai akun operasional yang melakukan setup.
2. Di editor Apps Script, pilih `validateSecondaryBackupConfiguration`.
3. Klik **Run** dan setujui izin jika diminta.
4. Pastikan hasil berisi `success: true` dan `enabled: true`.
5. Masuk ke akun backup dan pastikan terbentuk:

   ```text
   BPJS_USG_BACKUP_<NAMA_PUSKESMAS>/
   |- DICOM RAW/
   |- DICOM/
   `- KLAIM/
   ```

6. Pastikan ketiga subfolder tetap **Restricted**.

Fungsi validasi harus dijalankan langsung oleh email yang tercatat sebagai `ADMIN_EMAIL`. Menjadi Editor folder saja tidak membuat akun backup berhak menjalankan fungsi administrasi aplikasi.

### Langkah C2 — Verifikasi setting

Pada sheet `SETTINGS`, pastikan:

```text
ENABLE_SECONDARY_DRIVE_BACKUP = true
```

Jangan mengaktifkan backup sebelum folder dan izin antarakun berhasil divalidasi.

### Langkah C3 — Validasi folder verifikator

1. Jalankan `setupApplication()` setelah source versi 6.10 disinkronkan.
2. Jalankan `validateVerifierDriveConfiguration()` langsung sebagai `ADMIN_EMAIL`.
3. Pastikan hasil berisi `success: true` dan `enabled: true`, serta subfolder privat `KLAIM` muncul pada akun verifikator.
4. Pastikan sheet `SETTINGS` berisi `ENABLE_VERIFIER_DRIVE_DELIVERY = true`.
5. Buat PDF klaim fiktif dan pastikan pesan pengiriman berhasil tampil serta nama terbaca `KLAIM_<Puskesmas>_<YYYYMMDD>_<NIK>_<NO_HP>_vNNN.pdf` muncul di folder verifikator.
6. Untuk mengganti nama PDF verifikator lama yang masih `F1`, jalankan `renameExistingVerifierPdfFiles()` sebagai `ADMIN_EMAIL`. Jalankan ulang bila hasil menunjukkan masih ada lebih dari 100 klaim yang perlu diperiksa.

## 9. Fase D — Membuat deployment produksi

1. Pada Apps Script, pilih **Deploy → New deployment**.
2. Pilih jenis **Web app**.
3. Isi deskripsi versi, misalnya `Instalasi awal Puskesmas <Nama> - 6.7.0`.
4. Atur **Execute as: Me**.
5. Atur akses **Anyone** atau **Anyone with the link**, sesuai tampilan Workspace.
6. Klik **Deploy** dan selesaikan otorisasi.
7. Salin URL produksi yang berakhir dengan `/exec`.
8. Simpan URL pada bookmark PC/ponsel petugas dan pada lembar serah terima privat.

Halaman `/exec` dapat dijangkau dari internet agar browser petugas dan OrthancBridge dapat terhubung. Data tetap dilindungi oleh login aplikasi dan otorisasi server pada setiap fungsi. Jangan membagikan Sheet/Drive kepada petugas biasa.

Setiap pembaruan source harus dibuat sebagai **New version** pada deployment yang sama. Menyimpan source saja tidak memperbarui URL `/exec` yang sedang digunakan.

## 10. Fase E — Membuat administrator dan pengguna aplikasi

### Langkah E1 — Bootstrap administrator

1. Buka URL `/exec` dari profil akun Google operasional.
2. Gunakan akses installer untuk membuka menu **Pengguna**.
3. Edit pengguna Administrator.
4. Tetapkan username administrator yang unik.
5. Gunakan password sementara yang berbeda bila diperlukan; default awal adalah `admin123`.
6. Simpan. Setelah username administrator dibuat, bypass installer tidak lagi dipakai.
7. Keluar dan masuk kembali menggunakan username aplikasi.
8. Ganti password sementara saat diminta.

### Langkah E2 — Buat akun STAFF

Untuk setiap petugas:

1. Buka **Pengguna**.
2. Tambahkan nama lengkap, username, peran `STAFF`, fasilitas, dan izin yang diperlukan.
3. Berikan password sementara secara langsung dan aman.
4. Minta petugas login dari jendela incognito/private.
5. Pastikan layar **Ganti Kata Sandi** tampil sebelum dashboard.
6. Pastikan menu **Pengguna** dan **Sistem** tidak tampil bagi STAFF.
7. Nonaktifkan akun segera ketika petugas pindah tugas.

Jangan membuat satu username bersama untuk banyak petugas karena audit membutuhkan identitas pengguna yang berbeda.

### Langkah E3 — Uji berkas pendukung PDF/JPEG/PNG

Sejak versi `6.7.0-supporting-pdf-files`, aplikasi tidak lagi memaksa kamera ponsel terbuka. Dari bagian **Unggah Berkas Pendukung**, petugas memilih berkas untuk kategori KTP, Buku KIA, SPP/FKPP BPJS, atau Berkas Lainnya.

Aturan pemrosesan:

- format yang dapat dipilih adalah PDF, JPEG, atau PNG;
- satu PDF maksimal 25 MB dan 20 halaman;
- PDF.js dimuat dari cdnjs hanya ketika pengguna memilih PDF;
- isi PDF diproses di browser dan tidak dikirim ke cdnjs;
- setiap halaman PDF dirender menjadi JPEG dan diunggah sebagai dokumen terpisah dengan urutan halaman yang sama;
- foto dan halaman PDF dioptimalkan tanpa dipotong, maksimum 1280 × 720 untuk lanskap atau 720 × 1280 untuk potret;
- file PDF asli tidak disimpan sebagai dokumen klaim;
- tunggu pesan berhasil sebelum memilih berkas berikutnya.

Uji sedikitnya satu JPEG/PNG, satu PDF satu halaman, dan satu PDF beberapa halaman pada PC serta ponsel nyata. Jika PDF.js tidak dapat dimuat, periksa akses jaringan ke `cdnjs.cloudflare.com`; keberhasilan unggah foto saja belum membuktikan unggah PDF bekerja.

## 11. Fase F — Menyiapkan Orthanc pada PC Puskesmas

### Langkah F1 — Tetapkan jaringan lokal

Contoh nilai yang harus diganti dengan nilai lokasi:

```text
IP PC Orthanc    : 192.168.10.20
AE Title Orthanc : PUSKESMAS_PACS
DICOM port       : 4242
REST lokal       : http://127.0.0.1:8042
```

1. Buat DHCP reservation atau IP tetap untuk PC Orthanc.
2. Pastikan alat USG dan PC dapat saling menjangkau pada LAN.
3. Jangan melakukan port forwarding `4242` atau `8042` pada router internet.
4. Batasi Windows Firewall TCP `4242` hanya dari IP alat USG yang diketahui.
5. Jangan membuka TCP `8042` untuk internet. Untuk instalasi satu PC, gunakan REST melalui `127.0.0.1` saja.

### Langkah F2 — Instal dan amankan Orthanc

1. Instal Orthanc sebagai Windows service.
2. Cadangkan konfigurasi Orthanc sebelum mengubahnya.
3. Atur AE Title dan port DICOM, misalnya:

   ```json
   {
     "Name": "Puskesmas Orthanc",
     "DicomAet": "PUSKESMAS_PACS",
     "DicomPort": 4242,
     "HttpPort": 8042,
     "RemoteAccessAllowed": false,
     "AuthenticationEnabled": true,
     "RegisteredUsers": {
       "orthanc_bridge": "GANTI_DENGAN_PASSWORD_KUAT"
     }
   }
   ```

4. Buat kredensial Orthanc khusus untuk bridge sesuai kemampuan instalasi Orthanc.
5. Restart service Orthanc.
6. Buka `http://127.0.0.1:8042` dari PC yang sama dan pastikan Orthanc Explorer dapat diakses.
7. Catat lokasi konfigurasi dan prosedur restart service pada lembar serah terima.

Jangan mengganti seluruh konfigurasi Orthanc dengan contoh di atas. Gabungkan nilai yang diperlukan ke konfigurasi yang sudah ada dan pertahankan pengaturan/plugin lain.

### Langkah F3 — Konfigurasi alat USG

Pada menu DICOM/PACS alat USG, tambahkan tujuan:

```text
Destination AE Title : PUSKESMAS_PACS
Destination IP       : <IP_PC_ORTHANC>
Destination Port     : 4242
```

1. Jalankan C-ECHO atau fungsi **Verify** dari alat USG jika tersedia.
2. Kirim satu studi DICOM fiktif.
3. Pastikan studi muncul di Orthanc.
4. Periksa nama pasien, PatientID, PatientComments, NIK dan dokter yang terdeteksi, tanggal lahir, StudyDate, jumlah instance, dan preview.
5. Jangan melanjutkan ke data pasien nyata sebelum uji fiktif berhasil.

Jika terdapat beberapa alat USG, arahkan semuanya ke satu PC Orthanc pusat bila jaringan dan kapasitas memungkinkan. Catat AE Title dan IP setiap alat; jangan menggunakan IP dinamis tanpa reservasi.

## 12. Fase G — Memasang OrthancBridge

### Langkah G1 — Salin program ke lokasi stabil

Salin folder `orthanc-bridge` dari source rilis ke lokasi lokal yang tidak disinkronkan OneDrive, misalnya:

```text
C:\BPJS-USG-OrthancBridge
```

Folder kerja tidak boleh berada di folder publik dan hanya boleh diakses akun Windows yang berwenang.

### Langkah G2 — Buat kunci bridge pada aplikasi

1. Masuk ke `/exec` sebagai ADMIN.
2. Buka menu **Sistem**.
3. Pada bagian OrthancBridge, klik **Buat Kunci Koneksi**.
4. Klik **Salin Konfigurasi**.
5. Simpan langsung pada PC Orthanc.

Kunci hanya ditampilkan satu kali. Membuat kunci baru membatalkan kunci lama.

### Langkah G3 — Instal dependensi bridge

Buka PowerShell pada folder bridge:

```powershell
Set-Location -LiteralPath 'C:\BPJS-USG-OrthancBridge'
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

Perintah membuat `.venv`, memasang dependensi, dan membuat `config.json` dari contoh bila berkas tersebut belum ada.

### Langkah G4 — Isi `config.json`

Masukkan URL `/exec`, ID bridge, kunci bridge, dan kredensial Orthanc:

```json
{
  "orthanc_url": "http://127.0.0.1:8042",
  "orthanc_username": "orthanc_bridge",
  "orthanc_password": "GANTI_DENGAN_PASSWORD_ORTHANC",
  "apps_script_url": "https://script.google.com/macros/s/DEPLOYMENT_ID/exec",
  "bridge_id": "SALIN_DARI_MENU_SISTEM",
  "bridge_key": "SALIN_DARI_MENU_SISTEM",
  "lookback_days": 2,
  "poll_seconds": 600,
  "max_images_per_study": 30,
  "max_frames_per_instance": 1,
  "upload_original_dicoms": true,
  "max_dicom_instances_per_study": 100,
  "verify_tls": true,
  "state_file": "state.json",
  "log_file": "logs/orthanc-bridge.log"
}
```

Aturan:

- URL Apps Script harus URL produksi `/exec`, bukan URL editor atau `/dev`.
- Gunakan `http://` hanya untuk Orthanc pada `127.0.0.1`, `localhost`, atau `::1`.
- Biarkan `verify_tls: true` untuk Apps Script.
- Jangan commit `config.json`, `state.json`, `.venv`, atau log ke Git.
- Jangan mengirim isi `config.json` melalui chat atau email.

### Langkah G5 — Uji satu kali

```powershell
Set-Location -LiteralPath 'C:\BPJS-USG-OrthancBridge'
powershell -ExecutionPolicy Bypass -File .\run-once.ps1
Get-Content -LiteralPath '.\logs\orthanc-bridge.log' -Tail 100
```

Hasil yang harus diverifikasi:

- koneksi Orthanc berhasil;
- koneksi Apps Script berhasil;
- studi fiktif muncul pada menu **Orthanc** sebagai siap ditinjau;
- klaim belum dibuat otomatis;
- DICOM mentah muncul pada akun backup di `DICOM RAW`;
- log tidak memuat nama pasien, NIK, atau gambar.

Nilai `0 studies` tidak selalu berarti gagal. Periksa apakah `StudyDate` berada dalam `lookback_days` dan apakah studi sudah tercatat di `state.json`.

### Langkah G6 — Tinjau dan impor studi fiktif

1. Di web app, buka menu **Orthanc**.
2. Tinjau nama pasien, nilai mentah ID/Comment, calon NIK, calon nama dokter, tanggal lahir, tanggal pemeriksaan, dan gambar.
3. Isi No. HP secara manual.
4. Pastikan tepat satu NIK 16 digit dari `PatientID` atau `PatientComments` diisi otomatis; konflik harus menghasilkan peringatan dan isian manual.
5. Klik thumbnail dan pastikan pratinjau besar terbuka tanpa mengubah centang pilihan gambar.
6. Jika metadata nama/NIK kosong, gunakan teks yang tercetak pada gambar hanya sebagai petunjuk lalu cocokkan dengan sumber identitas pasien.
7. Pilih gambar yang benar.
8. Konfirmasi bahwa data dan gambar berasal dari pasien yang sama.
9. Buat klaim.
10. Pastikan status klaim adalah **Mengumpulkan berkas**.
11. Pastikan DICOM terkait klaim muncul pada folder utama klaim dan pada backup `DICOM`.
12. Buat PDF uji dan pastikan muncul pada backup `KLAIM`.
13. Jalankan bridge lagi dan pastikan studi yang sama tidak diduplikasi.

### Langkah G7 — Jalankan otomatis

Setelah uji satu kali lulus:

```powershell
Set-Location -LiteralPath 'C:\BPJS-USG-OrthancBridge'
powershell -ExecutionPolicy Bypass -File .\install-startup-task.ps1
Get-ScheduledTask -TaskName 'BPJS-USG-OrthancBridge'
Get-ScheduledTaskInfo -TaskName 'BPJS-USG-OrthancBridge'
```

Scheduled Task berjalan saat akun Windows yang memasangnya login. Lakukan sign-out/sign-in atau jalankan task secara manual, lalu periksa log. PC dan akun Windows tersebut harus tetap aktif agar sinkronisasi berjalan.

## 13. Fase H — Uji penerimaan sebelum go-live

Gunakan data fiktif. Semua item berikut harus lulus.

### 13.1 Aplikasi dan hak akses

- [ ] Header menampilkan versi `6.10.1-verifier-readable-filenames`.
- [ ] ADMIN dapat membuka menu Pengguna dan Sistem.
- [ ] STAFF tidak dapat membuka menu admin.
- [ ] STAFF dari fasilitas lain tidak dapat melihat klaim tanpa izin eksplisit.
- [ ] Logout mencabut sesi.
- [ ] Lima password salah memicu penguncian sementara sesuai konfigurasi.
- [ ] Staff tidak dapat membuka database atau Drive utama secara langsung.

### 13.2 Klaim dan dokumen

- [ ] Klaim fiktif dapat dibuat dan diedit.
- [ ] NIK harus 16 digit dan No. HP tervalidasi.
- [ ] Nama folder klaim tidak berisi nama pasien, NIK, atau No. HP.
- [ ] Gambar dari PC dapat diunggah.
- [ ] Pemilih berkas pada PC dan ponsel menerima PDF, JPEG, dan PNG tanpa memaksa kamera terbuka.
- [ ] PDF pendukung satu halaman dan beberapa halaman dapat diproses serta diunggah per halaman.
- [ ] PDF lebih dari 25 MB atau lebih dari 20 halaman ditolak dengan pesan yang jelas.
- [ ] Setiap halaman PDF menjadi gambar JPEG dan tetap berada dalam batas HD tanpa terpotong atau terdistorsi.
- [ ] Duplikat gambar ditolak.
- [ ] Rotasi, urutan, dan pilihan gambar tetap benar setelah halaman dimuat ulang.
- [ ] PDF `v001` dan `v002` dapat dibuat tanpa menimpa versi utama sebelumnya.
- [ ] PDF baru diperiksa secara visual, bukan hanya dipastikan filenya ada.
- [ ] Klaim selesai terkunci dan dapat dibuka kembali oleh pengguna yang memiliki akses ke klaim; klaim di luar fasilitas/izin tetap tidak dapat diakses.

### 13.3 Orthanc dan backup

- [ ] C-ECHO/Verify dari alat USG berhasil.
- [ ] Studi fiktif tampil di Orthanc.
- [ ] `run-once.ps1` berhasil.
- [ ] Studi tampil di inbox web app tanpa membuat klaim otomatis.
- [ ] DICOM mentah tampil di `DICOM RAW` akun backup.
- [ ] DICOM klaim tampil di `DICOM` akun backup.
- [ ] PDF terbaru tampil di `KLAIM` akun backup.
- [ ] Regenerasi PDF mengganti backup bernama sama, bukan membuat duplikat tak terkendali.
- [ ] Filename fisik memakai kode anonim `F1` dan tidak menampilkan Puskesmas, NIK, atau No. HP.
- [ ] Nama asli dapat direkonstruksi dari pasangan nama logis dan nama penyimpanan pada database privat.
- [ ] Snapshot database menyimpan mapping nama logis, nama `F1`, file ID, dan URL Drive yang diperlukan untuk pemulihan.
- [ ] Pemeriksaan `Rahasia kode nama file` menunjukkan `OK`.
- [ ] Menu **Sistem → Jalankan Diagnostik** menunjukkan folder Drive cadangan `OK`.
- [ ] Studi yang sama tidak diduplikasi ketika bridge dijalankan kembali.

### 13.4 Browser dan perangkat

- [ ] `/exec` diuji pada jendela incognito/private baru.
- [ ] Login diuji pada PC petugas.
- [ ] Login serta pemilihan PDF/JPEG/PNG diuji pada ponsel nyata.
- [ ] Unggah PDF diuji pada jaringan Puskesmas untuk memastikan PDF.js dapat dimuat dari cdnjs.
- [ ] Tampilan diuji pada jaringan Puskesmas yang akan digunakan.
- [ ] Bookmark hanya menunjuk ke URL produksi `/exec`.

Go-live hanya boleh dilakukan setelah daftar di atas ditandatangani administrator teknis dan penanggung jawab Puskesmas.

## 14. Backfill dan pengecekan backup

Untuk instalasi baru, fungsi backfill biasanya tidak diperlukan. Bila terdapat berkas yang dibuat sebelum backup aktif, jalankan dari editor Apps Script sebagai akun pemasang:

```text
backupExistingClaimFiles()
```

Fungsi memproses batch terbatas dan aman dijalankan berulang. Ulangi sampai satu eksekusi berikutnya menghasilkan seluruh penghitung `Ready` dan `Error` bernilai `0`. Jika ada penghitung `Error`, periksa kolom error pada database dan izin folder; jangan sekadar mengulang tanpa mencari penyebab.

Backfill juga mengganti nama fisik lama yang masih memuat identitas pasien menjadi kode anonim `F1` serta mengisi pasangan nama logis, nama penyimpanan, dan URL Drive pada sheet `CLAIMS` dan `ORTHANC_DICOMS`. Karena `F1` tidak dapat dibalik, jangan menghapus database atau mapping tersebut setelah backfill.

Periksa backup secara berkala:

1. Bandingkan studi uji/terbaru dengan `DICOM RAW`.
2. Bandingkan klaim Orthanc yang sudah dikonfirmasi dengan `DICOM`.
3. Bandingkan PDF klaim terbaru dengan `KLAIM`.
4. Jalankan diagnostik aplikasi.
5. Periksa kapasitas Drive akun operasional dan backup.
6. Catat tanggal, petugas, hasil, dan tindak lanjut.

## 15. Operasi harian

### Petugas

1. Pastikan alat USG mengirim studi ke Orthanc.
2. Buka `/exec` dan login memakai akun aplikasi sendiri.
3. Tinjau inbox Orthanc.
4. Cocokkan identitas pasien; jangan percaya `PatientID` tanpa pemeriksaan.
5. Isi No. HP dan data yang belum tersedia.
6. Pilih gambar dan konfirmasi pasien yang sama.
7. Lengkapi dokumen pendukung.
8. Periksa tampilan PDF secara visual.
9. Selesaikan klaim.

### Administrator

1. Periksa log bridge dan Scheduled Task.
2. Jalankan diagnostik aplikasi.
3. Periksa error backup pada `CLAIMS` dan `ORTHANC_DICOMS`.
4. Pantau kapasitas Drive dan disk Orthanc.
5. Nonaktifkan akun petugas yang tidak lagi berwenang.
6. Jangan menghapus baris database secara manual ketika bridge berjalan.

## 16. Pemulihan masalah umum

| Gejala | Pemeriksaan |
|---|---|
| `/exec` masih menampilkan versi lama | Deployment harus diedit dan dibuat **New version** |
| Setup menolak akun | Pastikan akun aktif sama dengan akun pemasang/deployer |
| Folder backup tidak dapat dibuka | Periksa `BACKUP_DRIVE_FOLDER_ID` dan izin Editor untuk akun operasional |
| `ORTHANC_BRIDGE_DISABLED` | Buat/aktifkan bridge dari menu Sistem |
| `ORTHANC_BRIDGE_UNAUTHORIZED` | ID/kunci bridge tidak cocok; buat ulang kunci dan perbarui `config.json` |
| Studi tidak ditemukan bridge | Periksa `lookback_days`, `StudyDate`, stabilitas studi, dan `state.json` |
| USG tidak dapat mengirim | Periksa IP tetap, AE Title, port 4242, firewall, dan C-ECHO |
| REST Orthanc gagal | Periksa service, `127.0.0.1:8042`, username, dan password Orthanc |
| DICOM gagal diunggah | Periksa internet, deployment terbaru, izin Drive, scope external request, dan kapasitas |
| Scheduled Task tidak berjalan | Periksa user logon, action task, `Get-ScheduledTaskInfo`, dan log bridge |
| Backup PDF/DICOM error | Periksa izin folder backup, kapasitas Drive, dan kolom error terkait |
| Login lambat/gagal setelah migrasi | Uji dari incognito, periksa deployment baru, lalu Apps Script Executions/Cloud Logging |

Jangan menghapus `state.json` sebagai langkah pertama. Penghapusan dapat membuat studi lama diperiksa/dikirim ulang. Jika benar-benar diperlukan, hentikan bridge dan buat salinan aman terlebih dahulu.

## 17. Perubahan, pembaruan, dan rotasi rahasia

### Pembaruan aplikasi

1. Cadangkan source versi aktif.
2. Sinkronkan seluruh berkas terdampak, bukan hanya satu fragment.
3. Jalankan pemeriksaan lokal dari root `bpjs-usg-app`:

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
   node .\tests\orthanc-service-tests.js
   .\orthanc-bridge\.venv\Scripts\python.exe -m unittest discover -s .\orthanc-bridge\tests -v
   ```

4. Jalankan `setupApplication()` untuk migrasi yang didukung.
5. Buat **New version** deployment.
6. Uji URL `/exec` dari sesi baru.
7. Uji PDF yang baru dibuat dan alur bridge nyata; hasil tes lokal saja tidak membuktikan deployment live.

### Rotasi kunci bridge

1. Hentikan Scheduled Task bridge.
2. Buat kunci baru dari menu Sistem.
3. Perbarui `bridge_key` di `config.json`.
4. Jalankan `run-once.ps1`.
5. Setelah berhasil, jalankan Scheduled Task kembali.

Saat ini aplikasi memiliki satu kunci bridge aktif. Rotasi kunci langsung membatalkan konfigurasi lama.

### Rahasia kode nama file

Jangan mengubah atau menghapus `FILENAME_CODE_SECRET` setelah file produksi dibuat. Kode anonim `F1` adalah HMAC satu arah; nama asli direkonstruksi menggunakan mapping pada database privat. Karena itu, database dan URL/file ID Drive harus selalu dicadangkan bersama.

### Password pepper

Jangan mengubah atau menghapus `PASSWORD_PEPPER` setelah akun pengguna dibuat. Perubahan pepper membuat semua hash password lama tidak dapat diverifikasi.

## 18. Batas pemulihan dan rencana kesinambungan

Jika akun operasional Puskesmas hilang/dinonaktifkan, folder backup tetap memberi akses ke salinan yang memang dimiliki akun backup, tetapi aplikasi tidak otomatis berpindah akun. Deployment, database, konfigurasi, dan hubungan file ID masih terikat ke instalasi utama.

Sebelum go-live, institusi harus menetapkan:

- siapa yang memulihkan akun Google operasional;
- siapa yang memiliki akun backup;
- lokasi source versi rilis;
- metode snapshot database dan retensi yang disetujui;
- cara memulihkan pasangan nama logis, nama `F1`, file ID, dan URL Drive dari snapshot database;
- metode backup konfigurasi Orthanc/bridge secara terenkripsi;
- target waktu pemulihan;
- jadwal uji pemulihan;
- prosedur insiden bila perangkat atau akun hilang.

Pemulihan ke akun Google baru harus diperlakukan sebagai migrasi terkontrol, bukan sekadar mengganti `ADMIN_EMAIL` atau `DATABASE_SPREADSHEET_ID`. Jangan mengubah ID dan rahasia secara coba-coba pada instalasi produksi.

## 19. Serah terima

Isi tanpa menuliskan password atau kunci rahasia:

| Item | Nilai/status |
|---|---|
| Nama Puskesmas |  |
| Email akun operasional |  |
| Email pemilik akun backup |  |
| Nama proyek Apps Script |  |
| Versi aplikasi | `6.10.1-verifier-readable-filenames` |
| URL produksi `/exec` |  |
| Nama folder backup |  |
| IP PC Orthanc |  |
| AE Title Orthanc |  |
| DICOM port | `4242` |
| Tanggal uji data fiktif |  |
| Hasil diagnostik | Lulus / Tidak lulus |
| Hasil uji backup | Lulus / Tidak lulus |
| Hasil uji PDF pendukung | Lulus / Tidak lulus |
| Hasil uji browser/ponsel | Lulus / Tidak lulus |
| Penanggung jawab Puskesmas |  |
| Administrator teknis |  |
| Tanggal go-live |  |

Lampirkan screenshot yang tidak mengandung data pasien untuk:

- versi aplikasi;
- hasil diagnostik;
- Scheduled Task aktif;
- keberadaan tiga subfolder backup;
- hasil uji fiktif pada inbox Orthanc;
- PDF uji yang sudah diperiksa secara visual.

## 20. Kriteria selesai

Implementasi dinyatakan selesai hanya bila:

1. akun operasional Puskesmas menjadi pemasang/deployer yang benar;
2. database dan Drive utama terbentuk serta tetap privat;
3. akun backup memiliki folder backup privat dan akun operasional hanya diberi Editor pada folder tersebut;
4. `validateSecondaryBackupConfiguration()` berhasil;
5. deployment produksi `/exec` dapat diakses dan login aplikasi bekerja;
6. PDF/JPEG/PNG pendukung berhasil dipilih dan diproses pada PC serta ponsel nyata;
7. alat USG berhasil mengirim studi fiktif ke Orthanc;
8. OrthancBridge berhasil mengirim studi ke inbox tanpa membuat klaim otomatis;
9. petugas berhasil meninjau dan mengonfirmasi pasien;
10. DICOM raw, DICOM klaim, dan PDF muncul pada akun backup;
11. diagnostik, browser, ponsel, PDF, restart/login Windows, dan deduplikasi sudah diuji;
12. daftar serah terima ditandatangani;
13. hasil lokal, deployment live, dan operasi klinik nyata tetap dicatat sebagai tiga tingkat verifikasi yang berbeda.
