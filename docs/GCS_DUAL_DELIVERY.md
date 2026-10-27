# Panduan Google Drive + Google Cloud Storage

Versi `7.0.0-gcs-dual-delivery` menambahkan tujuan Google Cloud Storage (GCS) tanpa menghapus alur Google Drive yang sudah ada.

## Batas fungsi yang penting

- `upload_to_google_drive` mengatur pengiriman otomatis dari OrthancBridge ke web app/Drive.
- `upload_to_gcs` mengatur pengiriman DICOM asli dan JPEG hasil konversi dari OrthancBridge langsung ke GCS.
- Web app tetap memakai Drive privat sebagai penyimpanan kerja klaim, gambar, dan PDF. Menonaktifkan `upload_to_google_drive` tidak menghapus ketergantungan internal web app terhadap Drive.
- Jika `upload_to_google_drive` bernilai `false`, studi tidak masuk ke **Kotak Masuk Orthanc** dan tidak dapat diimpor ke klaim melalui alur Orthanc. Untuk operasi klaim normal, biarkan nilainya `true`.
- **Buat PDF** menyimpan versi PDF ke Drive privat dan menandai pengiriman GCS sebagai `WAITING_COMPLETION`.
- PDF yang sudah diperiksa dikirim ke GCS ketika petugas menekan **Selesaikan Klaim**. Kegagalan GCS dicatat, tetapi tidak membatalkan status selesai atau menghapus PDF utama.
- Kegagalan salah satu tujuan tidak menghapus file yang sudah berhasil tersimpan di tujuan lain.

## Struktur objek privat

Nama objek Orthanc tidak memuat nama pasien, NIK, dokter, atau ID Orthanc mentah:

```text
bpjs-usg/orthanc/studies/<HASH_STUDI>/dicom/0001_<SHA256>.dcm
bpjs-usg/orthanc/studies/<HASH_STUDI>/jpg/0001_000_<SHA256>.jpg
bpjs-usg/klaim/pdf/KLAIM_F1<KODE>_v001.pdf
```

Bucket wajib privat. Jangan membuat objek publik, signed URL, atau link sharing. Mapping klaim dan status PDF tetap berada pada Spreadsheet privat.

## 1. Amankan credential

ZIP contoh menyertakan service-account JSON. Jangan commit, mengunggah, atau mengirim isi file itu melalui chat/surel. Jika ZIP pernah diteruskan di luar pihak yang berwenang, nonaktifkan key tersebut dan buat key baru sebelum produksi.

Pada PC Orthanc, letakkan credential di folder instalasi stabil di luar OneDrive, misalnya:

```text
C:\BPJS-USG-OrthancBridge\gcs-service-account.json
```

Batasi izin baca file kepada akun Windows yang menjalankan Scheduled Task dan `SYSTEM`. Role bucket yang cukup untuk alur ini adalah `roles/storage.objectUser` pada bucket yang dituju; tidak perlu memberi akses pada seluruh project.

## 2. Perbarui OrthancBridge

Salin isi folder `orthanc-bridge` versi terbaru ke folder instalasi tanpa menimpa `config.json`, `state.json`, credential, dan log. Jalankan ulang:

```powershell
Set-Location -LiteralPath 'C:\BPJS-USG-OrthancBridge'
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

`setup.ps1` memasang `google-cloud-storage` di virtual environment lokal.

## 3. Atur dua tujuan

Untuk Purbalingga dengan Drive dan GCS aktif, tambahkan nilai berikut pada `config.json` yang sudah ada:

```json
{
  "upload_to_google_drive": true,
  "upload_to_gcs": true,
  "gcs_bucket": "purbalingga-usg-data",
  "gcs_credentials_file": "gcs-service-account.json",
  "gcs_prefix": "bpjs-usg",
  "upload_original_dicoms": true
}
```

Jangan menghapus konfigurasi Orthanc, URL `/exec`, `bridge_id`, atau `bridge_key` yang sudah benar. `gcs_credentials_file` boleh berupa path absolut; path relatif dihitung dari folder `config.json`.

Pilihan mode:

| Drive/web app | GCS | Hasil |
|---|---|---|
| `true` | `true` | Studi masuk web app/Drive dan DICOM+JPEG juga masuk GCS |
| `true` | `false` | Perilaku lama; hanya web app/Drive |
| `false` | `true` | Arsip DICOM+JPEG ke GCS saja; tidak masuk Kotak Masuk Orthanc |
| `false` | `false` | Ditolak saat startup karena tidak ada tujuan aktif |

`upload_original_dicoms` hanya mengatur salinan DICOM ke web app/Drive. Saat `upload_to_gcs=true`, GCS selalu menerima DICOM asli dan JPEG sesuai batas `max_dicom_instances_per_study`, `max_images_per_study`, dan `max_frames_per_instance`.

## 4. Uji Python satu kali

Gunakan studi fiktif yang masih berada dalam `lookback_days`:

```powershell
Set-Location -LiteralPath 'C:\BPJS-USG-OrthancBridge'
powershell -ExecutionPolicy Bypass -File .\run-once.ps1
Get-Content -LiteralPath '.\logs\orthanc-bridge.log' -Tail 100
```

Pastikan log menunjukkan jumlah JPEG/DICOM untuk Drive dan GCS secara terpisah. `state.json` sekarang mencatat penyelesaian kanal Drive dan GCS secara terpisah. Jangan menghapus `state.json` sebagai langkah pertama; objek memakai nama deterministik dan precondition agar retry tidak menimpa objek lama.

## 5. Perbarui Apps Script untuk PDF GCS

1. Sinkronkan seluruh `src`, termasuk `GcsService.gs` dan `appsscript.json` yang memuat library OAuth2 versi 43.
2. Jalankan `setupApplication()` sebagai `ADMIN_EMAIL`. Ini menambah kolom `gcs_pdf_*` serta setting `ENABLE_GCS_PDF_DELIVERY=false` tanpa menghapus data lama.
3. Di **Project Settings -> Script Properties**, tambahkan:

```text
GCS_BUCKET_NAME = purbalingga-usg-data
GCS_OBJECT_PREFIX = bpjs-usg
GCS_SERVICE_ACCOUNT_KEY = <seluruh JSON service account, hanya pada Script Properties>
```

4. Pastikan Cloud Storage API aktif pada project service account dan service account memiliki `roles/storage.objectUser` hanya pada bucket tersebut.
5. Jalankan `validateGcsConfiguration()` langsung dari editor sebagai `ADMIN_EMAIL`. Fungsi ini mengunggah dan menghapus probe nonklinis, lalu mengaktifkan `ENABLE_GCS_PDF_DELIVERY`.
6. Jalankan **Sistem -> Jalankan Diagnostik** dan pastikan **Google Cloud Storage PDF** bernilai `OK`.
7. Buat **New version**, perbarui deployment, lalu uji URL `/exec` yang baru.

Jangan menaruh JSON key pada file `.gs`, Git, `config.example.json`, dokumentasi, atau output log.

## 6. Uji alur klaim fiktif

1. Kirim studi DICOM fiktif dan jalankan `run-once.ps1`.
2. Pastikan DICOM dan JPEG anonim muncul di prefix `bpjs-usg/orthanc/studies/`.
3. Pastikan studi juga muncul di web app bila `upload_to_google_drive=true`.
4. Impor setelah identitas pasien dikonfirmasi petugas.
5. Klik **Buat PDF**.
6. Periksa sheet `CLAIMS`: status klaim `PDF_GENERATED` dan `gcs_pdf_status=WAITING_COMPLETION`; objek PDF belum boleh tersedia di GCS.
7. Pratinjau PDF, lalu klik **Selesaikan Klaim** jika hasil benar.
8. Pastikan UI menampilkan bahwa PDF tersimpan di GCS, objek `bpjs-usg/klaim/pdf/KLAIM_F1<KODE>_vNNN.pdf` tersedia, dan sheet mencatat status klaim `COMPLETED`, `gcs_pdf_status=READY`, bucket, object, generation, serta timestamp.
9. Uji kegagalan terkontrol pada data fiktif. PDF utama Drive harus tetap tersedia dan status klaim tetap `COMPLETED`, sementara UI menampilkan kegagalan GCS.

Jika pengiriman PDF gagal saat **Selesaikan Klaim**, perbaiki credential/IAM/koneksi lalu jalankan `retryFailedGcsPdfDeliveries()` sebagai `ADMIN_EMAIL`. Fungsi ini memproses paling banyak 100 klaim berstatus `COMPLETED` yang memiliki PDF tetapi status GCS belum `READY`; ulangi selama `hasMore=true`.

## 7. Menonaktifkan dan mengaktifkan kembali

- Kanal Python Drive: ubah `upload_to_google_drive` pada `config.json`, lalu restart Scheduled Task.
- Kanal Python GCS: ubah `upload_to_gcs`, lalu restart Scheduled Task.
- PDF GCS: ubah `ENABLE_GCS_PDF_DELIVERY` pada sheet `SETTINGS`. Untuk mengaktifkan kembali, lebih aman jalankan `validateGcsConfiguration()`.

Mengaktifkan GCS setelah studi lama selesai hanya memproses studi yang masih terjangkau `lookback_days`. Fitur ini tidak otomatis memindahkan seluruh arsip historis. Lakukan migrasi historis sebagai pekerjaan terpisah dengan daftar sumber, tujuan, verifikasi checksum, dan persetujuan retensi.

## 8. Sebelum produksi

- Gunakan data fiktif untuk seluruh uji instalasi.
- Terapkan Uniform bucket-level access, public access prevention, retention/lifecycle yang disetujui, logging, dan lokasi bucket yang sesuai kebijakan organisasi.
- Simpan salinan credential hanya pada PC Orthanc yang berwenang dan Script Properties. Karena kedua komponen memakai key yang sama, rotasi key harus dikoordinasikan pada keduanya.
- Verifikasi restart PC, Scheduled Task, retry setelah gangguan internet, tidak ada duplikasi, dan deployment `/exec` versi baru sebelum menyatakan sistem live.
