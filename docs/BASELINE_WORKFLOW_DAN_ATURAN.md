# Baseline Workflow, Logika, dan Aturan BPJS USG

## 1. Identitas dokumen

| Item | Nilai |
|---|---|
| Aplikasi | BPJS USG Online Claim App |
| Versi baseline | `5.0.0-orthanc-bridge` |
| Tanggal baseline | 13 September 2026 |
| Lingkup | Satu Puskesmas, Google Apps Script, Google Sheets, Google Drive, dan Orthanc lokal |
| Bahasa antarmuka | Bahasa Indonesia |
| Metode masuk | Nama pengguna dan kata sandi aplikasi |

Dokumen ini mencatat perilaku aplikasi yang berlaku sebelum revisi berikutnya. Dokumen ini adalah acuan workflow dan aturan operasional, bukan pengganti SOP pelayanan, kebijakan rekam medis, atau ketentuan BPJS.

## 2. Tujuan aplikasi

Aplikasi membantu petugas Puskesmas:

1. membuat data klaim USG BPJS;
2. memperoleh gambar USG melalui unggahan komputer atau impor dari Orthanc;
3. memperoleh foto berkas pendukung melalui komputer atau ponsel;
4. meninjau, memilih, memutar, dan mengurutkan berkas;
5. membuat PDF dokumen pendukung;
6. menyimpan metadata dan berkas secara privat serta dapat ditelusuri.

Aplikasi tidak mengirim klaim secara langsung ke sistem BPJS dan tidak menggantikan verifikasi petugas.

## 3. Batas sistem

```text
Alat USG
   |
   | DICOM
   v
Orthanc lokal <-- dibaca oleh -- OrthancBridge di PC Puskesmas
                                  |
                                  | koneksi HTTPS keluar
                                  v
Browser/ponsel <--> Google Apps Script
                         |
                         +--> Google Sheets privat (metadata)
                         +--> Google Drive privat (gambar dan PDF)
```

Aturan batas sistem:

- Orthanc tidak dibuka langsung ke internet.
- OrthancBridge hanya membaca Orthanc dan mengirim data keluar ke deployment Apps Script.
- Web app dijalankan sebagai akun Google administrator pemasang.
- Pengguna aplikasi tidak memperoleh akses langsung ke Spreadsheet atau folder Drive.
- Berkas tidak dibagikan menggunakan tautan Drive publik.
- Browser tidak membaca Orthanc secara langsung.
- Klaim tidak dibuat otomatis hanya karena sebuah studi masuk ke Orthanc.

## 4. Aktor dan tanggung jawab

### 4.1 Administrator

Administrator dapat:

- membuat dan mengubah akun pengguna;
- mengatur ulang kata sandi pengguna;
- menghapus pengguna yang belum mempunyai riwayat aktivitas;
- menonaktifkan pengguna yang sudah mempunyai riwayat;
- mengarsipkan klaim;
- membuka kembali klaim yang sudah selesai;
- menjalankan diagnostik sistem;
- membuat, mengganti, mengaktifkan, atau menonaktifkan kunci OrthancBridge.

Administrator yang sedang login tidak dapat menghapus akunnya sendiri.

### 4.2 Staf

Hak staf ditentukan oleh akun:

- **Buat klaim** (`can_create_claim`);
- **Lihat semua klaim** (`can_view_all_claims`);
- **Buat PDF** (`can_generate_pdf`);
- **Unduh PDF** (`can_download_pdf`).

Tanpa izin **Lihat semua klaim**, staf hanya dapat mengakses klaim pada fasilitasnya sendiri. Dalam desain satu Puskesmas, semua pengguna normalnya menggunakan fasilitas utama yang sama.

### 4.3 OrthancBridge

OrthancBridge adalah proses mesin, bukan akun staf. Bridge hanya boleh:

- memeriksa koneksi Orthanc;
- mencari studi terbaru;
- membaca metadata dan preview;
- mengirim metadata serta JPEG ke kotak masuk Orthanc web app;
- menandai proses penerimaan selesai.

Bridge tidak boleh membuat keputusan bahwa identitas pasien benar atau membuat klaim tanpa tindakan staf.

## 5. Autentikasi dan sesi

### 5.1 Akun baru

- Nama pengguna dinormalisasi menjadi huruf kecil.
- Kata sandi minimal 6 dan maksimal 128 karakter.
- Jika administrator tidak mengisi kata sandi saat membuat akun, kata sandi awal adalah `admin123`.
- Pengguna wajib mengganti kata sandi awal sebelum dapat menggunakan fitur aplikasi.
- Kata sandi baru tidak boleh tetap `admin123`.

### 5.2 Penyimpanan kata sandi

- Kata sandi asli tidak disimpan di Sheets, Script Properties, log, atau audit.
- Setiap akun mempunyai salt acak.
- Hash menggunakan derivasi HMAC-SHA-256 berulang dan pepper aplikasi.
- Pepper disimpan pada Script Properties, terpisah dari sheet kredensial.

### 5.3 Perlindungan login

- Lima kegagalan login berturut-turut mengunci akun selama 15 menit secara default.
- Pesan kesalahan untuk nama pengguna tidak dikenal, kata sandi salah, akun nonaktif, atau akun terkunci dibuat umum agar tidak membocorkan keberadaan akun.
- Penggantian atau reset kata sandi mencabut sesi lama.

### 5.4 Masa sesi

- Masa sesi default adalah 8 jam.
- Browser menyimpan token sesi pada `localStorage`, dengan `sessionStorage` sebagai cadangan kompatibilitas.
- Hanya hash token yang disimpan pada server.
- Tombol **Keluar** mencabut sesi server dan menghapus token browser.
- Pengguna wajib keluar setelah selesai menggunakan komputer atau ponsel bersama.

## 6. Workflow klaim manual

### 6.1 Membuat klaim

1. Pengguna membuka menu klaim.
2. Pengguna memilih **Buat Klaim Baru**.
3. Pengguna mengisi nama pasien, NIK, tanggal lahir, tanggal pemeriksaan USG, dan fasilitas.
4. Server memvalidasi data dan hak fasilitas.
5. Klaim dibuat dengan status `DRAFT`.
6. Sistem menghasilkan kode klaim acak tanpa nama atau NIK pasien.

Aturan data:

- nama pasien minimal 2 karakter;
- NIK wajib tepat 16 angka;
- tanggal lahir tidak boleh setelah tanggal pemeriksaan;
- tanggal pemeriksaan tidak boleh berada di masa depan;
- fasilitas harus aktif;
- staf hanya dapat membuat klaim untuk fasilitasnya sendiri.

### 6.2 Memulai pengumpulan berkas

Klaim `DRAFT` dapat diubah menjadi `COLLECTING_DOCUMENTS`. Data klaim hanya dapat diedit pada status `DRAFT` atau `COLLECTING_DOCUMENTS`.

### 6.3 Mengunggah gambar USG dari komputer

1. Pengguna membuka klaim yang benar.
2. Pengguna memilih satu atau beberapa JPEG/PNG.
3. Browser memperbaiki orientasi dan mengoptimalkan gambar.
4. Gambar dikirim satu per satu.
5. Server memvalidasi sesi, akses klaim, MIME, tanda tangan berkas, ukuran, dimensi, dan hash.
6. Gambar serta thumbnail disimpan pada Drive privat.
7. Metadata disimpan pada `DOCUMENTS` dan tindakan dicatat pada `AUDIT_LOG`.

Gambar USG dari komputer menggunakan batas sisi panjang sampai 2800 piksel untuk mempertahankan detail yang diperlukan. Ukuran hasil optimasi server maksimal 6 MB.

### 6.4 Mengunggah berkas dari ponsel

Dalam mode satu Puskesmas:

1. Pengguna membuka URL `/exec` yang sama pada ponsel.
2. Pengguna login menggunakan akun aplikasi.
3. Pengguna memilih klaim.
4. Pengguna memeriksa pasien, tanggal pemeriksaan, dan fasilitas.
5. Pengguna mengambil foto berdasarkan kategori.

Kategori berkas pendukung yang berlaku:

- KTP (Identitas);
- Buku KIA;
- Berkas SPP & FKPP BPJS;
- Berkas Lainnya.

Foto ponsel dikompresi tanpa dipotong:

- lanskap: maksimum dalam batas 1280 x 720;
- potret: maksimum dalam batas 720 x 1280;
- rasio gambar dipertahankan, sehingga salah satu sisi dapat lebih kecil.

Alur QR tetap tersedia dalam kode tetapi dinonaktifkan secara default dengan `ENABLE_MOBILE_QR_UPLOAD=false`.

## 7. Workflow Orthanc

### 7.1 Penerimaan DICOM

1. Alat USG mengirim DICOM ke Orthanc.
2. Orthanc menandai studi stabil setelah penerimaan selesai.
3. OrthancBridge mencari studi berdasarkan `StudyDate` dalam jendela `lookback_days`.
4. Bridge membaca metadata studi, series, dan instance.
5. Bridge mengambil preview setiap instance/frame terpilih dari REST API Orthanc.
6. Preview dinormalisasi menjadi JPEG dan dibuatkan thumbnail.
7. Metadata dan gambar dikirim satu per satu ke Apps Script.
8. Web app menyimpan data pada kotak masuk privat.
9. Status kotak masuk menjadi `READY` jika sedikitnya satu gambar berhasil diterima.

### 7.2 Pemetaan metadata DICOM

| Tag DICOM | Tujuan | Aturan |
|---|---|---|
| `PatientName` | Nama pasien | Karakter `^` diubah menjadi spasi; tetap wajib diperiksa |
| `PatientID` | Calon NIK | Otomatis digunakan hanya jika setelah normalisasi terdapat tepat 16 angka |
| `PatientBirthDate` | Tanggal lahir | Format DICOM diubah menjadi tanggal; nilai kosong/tidak valid harus diisi manual |
| `StudyDate` | Tanggal pemeriksaan | Digunakan bila valid; petugas tetap wajib memeriksa |
| `AccessionNumber` | Informasi referensi | Ditampilkan sebagai informasi tambahan |
| `StudyDescription` | Deskripsi pemeriksaan | Ditampilkan sebagai informasi tambahan |
| `StudyInstanceUID` | Identitas studi | Digunakan untuk deduplikasi dan ketertelusuran |
| `SOPInstanceUID` | Identitas instance | Disimpan bersama dokumen hasil impor |

`PatientID` tidak selalu merupakan NIK. Sistem tidak menebak atau mengubah nomor rekam medis menjadi NIK.

### 7.3 Konversi gambar Orthanc

- Bridge menggunakan preview hasil decoding Orthanc, kemudian mengubahnya menjadi JPEG.
- Orientasi EXIF dinormalisasi bila tersedia.
- Sisi panjang gambar dibatasi sampai 2800 piksel.
- Ukuran JPEG bridge dibatasi sekitar 5,75 MB agar tetap di bawah batas 6 MB server.
- Thumbnail dibatasi sampai 400 x 400 piksel.
- Rasio gambar tidak diubah.
- Default `max_frames_per_instance=1`, sehingga hanya frame pertama dari instance multi-frame yang diambil.
- Default `max_images_per_study=30`.
- Cine multi-frame tidak diubah menjadi video; frame tambahan hanya diambil jika konfigurasi dinaikkan.

### 7.4 Peninjauan oleh petugas

Studi yang diterima muncul pada **Kotak Masuk Orthanc**. Daftar awal menyamarkan identitas. Pengguna dengan izin membuat klaim dapat membuka detail dan:

1. memeriksa atau memperbaiki nama;
2. mengisi atau memperbaiki NIK;
3. memeriksa atau mengisi tanggal lahir;
4. memeriksa tanggal pemeriksaan;
5. memilih gambar USG yang benar;
6. mencentang konfirmasi bahwa identitas dan gambar berasal dari pasien yang sama;
7. membuat klaim.

Tanpa konfirmasi dan sedikitnya satu gambar terpilih, server menolak pembuatan klaim.

### 7.5 Pembuatan klaim dari Orthanc

Setelah konfirmasi:

- klaim dibuat langsung dengan status `COLLECTING_DOCUMENTS`;
- gambar terpilih disalin ke folder privat klaim;
- `source_type` dokumen menjadi `ORTHANC_IMPORT`;
- ID study, series, instance, dan frame disimpan pada `DOCUMENTS`;
- seluruh staging image Orthanc, termasuk gambar yang tidak dipilih, dipindahkan ke Sampah setelah penyalinan berhasil; gambar terpilih sudah mempunyai salinan pada folder klaim;
- status kotak masuk menjadi `IMPORTED` dan ditautkan ke klaim.

Jika petugas memilih **Abaikan Pemeriksaan**, status menjadi `REJECTED` dan staging image dipindahkan ke Sampah. Klaim tidak dibuat.

## 8. Status dan transisi

### 8.1 Status klaim

```text
DRAFT
  -> COLLECTING_DOCUMENTS
  -> PDF_GENERATED
  -> COMPLETED

COMPLETED -- hanya ADMIN --> COLLECTING_DOCUMENTS
status aktif -- hanya ADMIN --> ARCHIVED
```

Aturan penting:

- impor Orthanc memulai klaim pada `COLLECTING_DOCUMENTS`;
- `READY` masih dikenali untuk kompatibilitas data/status lama, tetapi versi baseline ini tidak mengubah klaim ke `READY` secara otomatis;
- pembuatan PDF diizinkan dari `COLLECTING_DOCUMENTS`, status kompatibilitas `READY`, atau `PDF_GENERATED` jika persyaratan dokumen terpenuhi;
- klaim hanya dapat diselesaikan dari `PDF_GENERATED`;
- `COMPLETED` mengunci perubahan berkas;
- hanya administrator yang dapat membuka kembali klaim selesai;
- klaim diarsipkan, bukan dihapus permanen.

### 8.2 Status kotak masuk Orthanc

| Status | Arti |
|---|---|
| `RECEIVING` | Metadata/gambar sedang dikirim |
| `READY` | Sedikitnya satu gambar diterima dan siap ditinjau |
| `IMPORTED` | Sudah menjadi klaim |
| `REJECTED` | Diabaikan oleh petugas |
| `ERROR` | Tidak ada gambar yang berhasil diterima atau proses gagal |

Studi dengan `READY`, `IMPORTED`, atau `REJECTED` tidak menerima unggahan ulang melalui alur normal.

## 9. Deduplikasi dan ketertelusuran

### 9.1 Dokumen biasa

- SHA-256 digunakan untuk mendeteksi gambar aktif yang sama pada klaim yang sama.
- Nama file asli disimpan sebagai metadata, tetapi nama file Drive menggunakan jenis dokumen dan UUID.
- Penghapusan dokumen bersifat recoverable: metadata ditandai terhapus dan file dipindahkan ke Sampah.

### 9.2 Orthanc

- Sumber studi diidentifikasi menggunakan kombinasi ID bridge dan `StudyInstanceUID`; bila UID tidak ada, digunakan ID studi Orthanc.
- Gambar diidentifikasi menggunakan inbox, ID instance, dan indeks frame.
- Apps Script menolak duplikasi studi/gambar pada sisi server.
- `state.json` mencatat studi yang sudah selesai agar bridge tidak mengirim ulang pada setiap polling.
- Riwayat state lokal dipertahankan selama 90 hari.
- Menghapus `state.json` membuat bridge memeriksa kembali studi, tetapi deduplikasi server tetap melindungi data selama database web app tidak dihapus.

## 10. Pengelolaan berkas dan PDF

Petugas dapat:

- melihat thumbnail dan gambar penuh melalui aplikasi;
- memutar gambar 90 derajat;
- memilih apakah gambar disertakan dalam PDF;
- mengatur urutan menggunakan drag-and-drop atau tombol urutan;
- menghapus gambar yang salah sebelum klaim dikunci.

Aturan PDF:

- sedikitnya satu gambar USG terpilih wajib tersedia;
- KTP, Buku KIA, dan SPP/FKPP tidak diwajibkan secara default, tetapi dapat diwajibkan melalui `SETTINGS`;
- konfirmasi bahwa seluruh berkas berasal dari pasien yang sama wajib dicentang;
- PDF dibuat dalam ukuran A4 melalui Google Docs privat sementara;
- dokumen sementara dipindahkan ke Sampah setelah konversi;
- PDF disimpan secara versioned sebagai `v001`, `v002`, dan seterusnya;
- versi lama tidak ditimpa;
- sampul PDF menampilkan NIK lengkap untuk pengguna yang telah diotorisasi;
- pratinjau dan unduh dilakukan melalui aplikasi tanpa memberikan URL Drive.

## 11. Penyimpanan data

### 11.1 Google Sheets

Sheet utama:

- `USERS`;
- `FACILITIES`;
- `CLAIMS`;
- `DOCUMENTS`;
- `AUDIT_LOG`;
- `AUTH_CREDENTIALS`;
- `AUTH_SESSIONS`;
- `ORTHANC_INBOX`;
- `ORTHANC_IMAGES`;
- `SETTINGS`.

Sheet adalah metadata source of truth. Header tidak boleh diubah, dikosongkan, dipindahkan, atau ditambahkan manual tanpa migrasi kode.

### 11.2 Google Drive

Struktur logis:

```text
BPJS_USG_APP/
  CLAIMS/
    CLAIM-YYYYMMDD-XXXXXX/
      USG/
      KTP/
      BUKU_KIA/
      SPP_FKPP_BPJS/
      OTHER/
      THUMBNAILS/
      OUTPUT/
  SYSTEM/
    ORTHANC_INBOX/
```

Nama folder klaim tidak memuat nama, NIK, atau tanggal lahir pasien.

### 11.3 PC Orthanc

File lokal penting:

- `config.json`: URL dan kredensial bridge; rahasia dan tidak boleh dibagikan;
- `state.json`: daftar studi yang sudah selesai dikirim;
- `logs/orthanc-bridge.log`: log operasional tanpa nama pasien atau NIK;
- `.venv/`: lingkungan Python lokal.

## 12. Keamanan OrthancBridge

- Apps Script hanya menerima endpoint `doPost` yang mempunyai ID bridge dan kunci yang benar.
- Kunci bridge adalah token acak 96 karakter.
- Apps Script hanya menyimpan hash SHA-256 dari kunci.
- Nilai asli kunci hanya ditampilkan satu kali kepada administrator.
- Mengganti kunci langsung membatalkan kunci lama.
- Endpoint Apps Script harus berupa HTTPS resmi `script.google.com` yang berakhir `/exec`.
- URL Orthanc `http://` hanya diizinkan untuk `127.0.0.1`, `localhost`, atau `::1`.
- Orthanc pada komputer lain harus menggunakan HTTPS dengan sertifikat valid.
- Port Orthanc 8042 tidak boleh diteruskan ke internet.
- `config.json` tidak boleh dikirim melalui surel, chat, atau disimpan pada folder publik.

## 13. Operasi OrthancBridge di Windows

### 13.1 Uji satu kali

```powershell
powershell -ExecutionPolicy Bypass -File .\run-once.ps1
```

Perintah melakukan satu siklus sinkronisasi lalu berhenti.

### 13.2 Menjalankan terus-menerus

```powershell
powershell -ExecutionPolicy Bypass -File .\run-continuous.ps1
```

Bridge melakukan polling sesuai `poll_seconds`, default 60 detik.

### 13.3 Menjalankan otomatis

```powershell
powershell -ExecutionPolicy Bypass -File .\install-startup-task.ps1
```

Task bernama `BPJS-USG-OrthancBridge` dibuat untuk pengguna Windows saat ini.

Perilaku setelah komputer dimatikan:

1. bridge berhenti saat Windows mati;
2. setelah komputer dinyalakan, pengguna Windows harus login;
3. task menjalankan bridge secara tersembunyi;
4. tidak perlu membuka jendela PowerShell terus-menerus.

Jika belum ada pengguna yang login, task baseline belum berjalan. PC, Orthanc, dan koneksi internet harus tersedia.

Perintah operasional:

```powershell
Get-ScheduledTask -TaskName "BPJS-USG-OrthancBridge"
Get-ScheduledTaskInfo -TaskName "BPJS-USG-OrthancBridge"
Start-ScheduledTask -TaskName "BPJS-USG-OrthancBridge"
Stop-ScheduledTask -TaskName "BPJS-USG-OrthancBridge"
```

Menghapus task:

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall-startup-task.ps1
```

## 14. Konfigurasi OrthancBridge

| Parameter | Default/aturan |
|---|---|
| `orthanc_url` | `http://127.0.0.1:8042` bila pada PC yang sama |
| `orthanc_username` | Kosong jika autentikasi Orthanc lokal dinonaktifkan |
| `orthanc_password` | Kosong jika autentikasi Orthanc lokal dinonaktifkan |
| `apps_script_url` | URL deployment operasional yang berakhir `/exec` |
| `bridge_id` | Disalin dari menu Sistem |
| `bridge_key` | Disalin sekali dari menu Sistem dan harus dirahasiakan |
| `lookback_days` | Default 2; valid 1-30 hari berdasarkan `StudyDate` |
| `poll_seconds` | Default 60; valid 15-3600 detik |
| `max_images_per_study` | Default 30; valid 1-30 |
| `max_frames_per_instance` | Default 1; valid 1-30 |
| `verify_tls` | Wajib `true` untuk koneksi Apps Script |
| `state_file` | Default `state.json` |
| `log_file` | Default `logs/orthanc-bridge.log` |

Snapshot lingkungan lokal yang diamati pada 13 September 2026:

- URL: `http://127.0.0.1:8042`;
- nama Orthanc: `MyOrthanc`;
- versi Orthanc: `1.12.11`;
- `AuthenticationEnabled=false`;
- `RemoteAccessAllowed=false`.

Snapshot tidak boleh dianggap permanen; periksa kembali setelah pembaruan Orthanc atau perubahan konfigurasi.

## 15. Audit

Tindakan penting dicatat pada `AUDIT_LOG`, antara lain:

- login berhasil/gagal untuk akun yang dikenal;
- pembuatan/perubahan/pengarsipan klaim;
- unggah, hapus, rotasi, pemilihan, dan pengurutan dokumen;
- penerimaan studi Orthanc;
- impor Orthanc menjadi klaim;
- pembuatan, pratinjau, dan pengunduhan PDF;
- penyelesaian dan pembukaan kembali klaim;
- perubahan konfigurasi/kunci OrthancBridge.

Audit tidak boleh menyimpan kata sandi, kunci bridge, nama pasien lengkap, NIK lengkap, atau gambar.

## 16. Penanganan kegagalan

| Kondisi | Perilaku/tindakan |
|---|---|
| PC mati | Bridge berhenti; berjalan lagi setelah login Windows jika startup task terpasang |
| Internet putus | Siklus gagal dicatat; mode continuous mencoba lagi pada siklus berikutnya |
| Orthanc belum stabil | Studi dilewati sementara dan diperiksa pada polling berikutnya |
| Sebagian gambar gagal | Gambar berhasil tetap diterima; jumlah gambar gagal ditampilkan untuk ditinjau |
| Semua gambar gagal | Inbox menjadi `ERROR`; periksa codec Orthanc dan log bridge |
| Kunci tidak sesuai | Apps Script menolak dengan `ORTHANC_BRIDGE_UNAUTHORIZED` |
| Bridge dinonaktifkan | Permintaan baru ditolak tanpa menghapus data lama |
| PatientID bukan 16 angka | NIK tidak diisi otomatis; petugas wajib mengisi manual |
| Data pasien meragukan | Jangan membuat klaim; koreksi atau abaikan pemeriksaan |
| Duplikasi studi | Diblokir oleh state lokal dan source key server |
| Sesi pengguna habis | Pengguna harus login kembali; data server yang sudah berhasil disimpan tetap ada |

## 17. Aturan operasional wajib

1. Gunakan data fiktif saat pengujian awal.
2. Periksa identitas pasien sebelum mengunggah atau mengimpor berkas.
3. Jangan menganggap `PatientID` selalu sebagai NIK.
4. Jangan membuat klaim Orthanc tanpa meninjau seluruh gambar.
5. Jangan mencampur dokumen dari pasien yang berbeda.
6. Jangan membagikan Spreadsheet, folder Drive, `config.json`, atau kunci bridge kepada staf umum.
7. Jangan membuka port 8042 ke internet.
8. Jangan mengubah sheet atau header secara manual ketika aplikasi/bridge berjalan.
9. Gunakan tombol **Keluar** pada perangkat bersama.
10. Tinjau PDF sebelum mengunduh atau menyelesaikan klaim.
11. Backup Spreadsheet dan Drive sesuai kebijakan perlindungan data Puskesmas.
12. Nonaktifkan akun petugas yang sudah tidak bertugas; jangan hapus jika mempunyai riwayat.

## 18. Validasi baseline

Sudah diuji secara lokal:

- sintaks seluruh Apps Script dan JavaScript;
- normalisasi metadata DICOM;
- validasi NIK kandidat;
- validasi tanggal DICOM;
- pembuatan JPEG dan thumbnail;
- batas endpoint HTTPS Apps Script;
- larangan Orthanc HTTP non-localhost;
- perhitungan gambar diterima/dilewati;
- pemeriksaan struktur dan pola keamanan statis;
- sintaks skrip Python dan PowerShell.

Belum dapat dinyatakan tervalidasi hanya dari pengujian lokal:

- konektivitas OrthancBridge ke deployment Apps Script nyata;
- kompatibilitas codec seluruh jenis DICOM alat USG;
- proses otomatis setelah restart pada PC operasional;
- perilaku beberapa pengguna secara bersamaan;
- kuota Google Apps Script, Drive, Sheets, dan Google Docs pada penggunaan nyata;
- hasil PDF untuk seluruh variasi dokumen;
- penerimaan klinis dan SOP Puskesmas/BPJS.

## 19. Checklist penerimaan sebelum digunakan pada data nyata

- [ ] `setupApplication()` berhasil untuk versi `5.0.0-orthanc-bridge`.
- [ ] Deployment `/exec` menampilkan versi yang benar.
- [ ] Login administrator dan staf berhasil.
- [ ] Kata sandi awal wajib diganti.
- [ ] Akses staf terbatas sesuai fasilitas dan izin.
- [ ] OrthancBridge aktif dan `ping` berhasil.
- [ ] DICOM fiktif muncul di Kotak Masuk Orthanc.
- [ ] Metadata yang kosong/salah dapat dikoreksi.
- [ ] NIK non-16 angka tidak digunakan otomatis.
- [ ] Thumbnail dan gambar JPEG dapat dibuka.
- [ ] Klaim tidak terbentuk sebelum konfirmasi staf.
- [ ] Studi yang sama tidak menghasilkan duplikasi.
- [ ] Unggah KTP, Buku KIA, SPP/FKPP, dan berkas lain dari ponsel berhasil.
- [ ] Gambar ponsel memenuhi batas HD dan tidak terdistorsi.
- [ ] PDF menampilkan data dan urutan berkas yang benar.
- [ ] Penyelesaian klaim mengunci perubahan.
- [ ] `AUDIT_LOG` mencatat tindakan tanpa membocorkan rahasia/identitas lengkap.
- [ ] Startup task berjalan kembali setelah restart dan login Windows.
- [ ] Backup dan prosedur pemulihan telah diuji.

## 20. Aturan perubahan setelah baseline

Setiap revisi berikutnya harus:

1. mempunyai nomor versi baru;
2. mencatat perubahan workflow, aturan, schema, atau keamanan;
3. mempertahankan data lama atau menyediakan migrasi yang aman;
4. tidak menghapus klaim/dokumen lama secara otomatis;
5. tidak membuka akses publik ke Orthanc, Drive, atau Sheets;
6. mempertahankan konfirmasi manusia sebelum klaim Orthanc dibuat;
7. menambah atau memperbarui pengujian;
8. membedakan hasil uji lokal dari validasi deployment nyata;
9. diuji memakai data fiktif sebelum digunakan pada pasien;
10. memperbarui dokumen baseline atau membuat catatan perubahan yang merujuk baseline ini.
