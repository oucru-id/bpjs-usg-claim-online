# Panduan OrthancBridge

OrthancBridge adalah program pendamping pada PC Puskesmas. Program ini hanya membuat koneksi keluar dari PC ke deployment HTTPS Apps Script. Jangan membuka port Orthanc `8042` ke internet.

## Alur kerja

1. Alat USG mengirim DICOM ke Orthanc.
2. OrthancBridge mencari studi terbaru yang sudah stabil.
3. Metadata pasien dibaca dari tag DICOM, preview gambar dikonversi menjadi JPEG, dan setiap instance DICOM asli diunggah secara resumable ke Drive privat.
4. Data masuk ke **Kotak Masuk Orthanc** pada web app; setiap DICOM asli langsung disalin ke subfolder `DICOM RAW` pada Drive cadangan tanpa menunggu klaim dikonfirmasi.
5. Petugas meninjau nama, NIK, mengisi No. HP, lalu memeriksa tanggal lahir, tanggal pemeriksaan, dan gambar.
6. Setelah konfirmasi, aplikasi membuat klaim dengan status **Mengumpulkan berkas**, menyalin gambar USG, dan memindahkan salinan DICOM asli ke subfolder privat `DICOM` milik klaim.
7. Jika backup Drive kedua diaktifkan, salinan terkait klaim disimpan terpisah di `DICOM`, dan PDF klaim disimpan di `KLAIM`.

Bridge tidak langsung membuat klaim. Konfirmasi petugas wajib karena `PatientID` dapat berisi nomor rekam medis dan bukan NIK.

## 1. Perbarui Apps Script

1. Salin seluruh berkas dalam folder `src` ke proyek Apps Script, termasuk `OrthancBridgeService.gs`.
2. Jalankan `setupApplication()` sebagai administrator pemasang.
3. Pastikan hasil setup memuat sheet `ORTHANC_INBOX` dan `ORTHANC_IMAGES`.
4. Buat deployment web app versi baru.
5. Muat ulang URL `/exec` dan pastikan versi `6.5.0-anonymous-filenames` tampil.

Setup menambah kolom `patient_phone` pada `CLAIMS`, kolom referensi Orthanc pada `DOCUMENTS`, sheet `ORTHANC_INBOX`, `ORTHANC_IMAGES`, dan `ORTHANC_DICOMS`, serta folder privat `SYSTEM/ORTHANC_INBOX`. Setup tidak menghapus klaim atau dokumen lama. Karena versi aplikasi berubah, sesi lama dicabut satu kali dan pengguna perlu masuk kembali.

## 2. Buat kunci koneksi

1. Masuk sebagai administrator.
2. Buka **Sistem**.
3. Pada bagian **OrthancBridge**, klik **Buat Kunci Koneksi**.
4. Klik **Salin Konfigurasi**.
5. Simpan konfigurasi langsung pada PC Orthanc. Kunci hanya ditampilkan satu kali.

Mengganti kunci akan segera membatalkan kunci lama. Jangan mengirim kunci melalui surel atau aplikasi pesan.

## 3. Persiapkan program pada PC Orthanc

Buka PowerShell pada folder `orthanc-bridge`, lalu jalankan:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

Perintah tersebut membuat `.venv`, memasang dependensi, dan membuat `config.json` jika belum tersedia. Buka `config.json`, kemudian masukkan konfigurasi yang disalin dari menu Sistem.

Isi akun Orthanc:

```json
{
  "orthanc_url": "http://127.0.0.1:8042",
  "orthanc_username": "orthanc_bridge",
  "orthanc_password": "KATA_SANDI_ORTHANC"
}
```

Akun Orthanc bawaan umumnya memperoleh akses REST yang luas. Batasi akses port 8042 hanya untuk localhost atau komputer tepercaya. Jika tersedia, gunakan reverse proxy/filter Orthanc yang membatasi akun bridge hanya untuk membaca `/system`, `/studies`, `/series`, `/instances`, serta melakukan pencarian `/tools/find`.

Konfigurasi `http://` hanya diterima untuk `127.0.0.1`, `localhost`, atau `::1`. Jika Orthanc berada pada komputer lain, gunakan endpoint `https://` dengan sertifikat TLS yang valid agar kredensial dan data pasien tidak dikirim tanpa enkripsi.

## 4. Uji satu kali

Gunakan pasien dan DICOM uji terlebih dahulu:

```powershell
powershell -ExecutionPolicy Bypass -File .\run-once.ps1
```

Hasil yang diharapkan:

- log menampilkan koneksi ke Orthanc dan Apps Script berhasil;
- pemeriksaan muncul pada menu **Orthanc**;
- nama, PatientID, tanggal lahir, dan tanggal pemeriksaan dapat ditinjau;
- thumbnail tampil;
- tidak ada klaim yang dibuat sebelum petugas mengonfirmasi.

Log disimpan pada `orthanc-bridge/logs/orthanc-bridge.log`. Log tidak memuat nama pasien, NIK, atau gambar.

## 5. Jalankan otomatis

Setelah uji satu kali berhasil, jalankan terus-menerus:

```powershell
powershell -ExecutionPolicy Bypass -File .\run-continuous.ps1
```

Untuk menjalankan otomatis saat pengguna Windows masuk:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-startup-task.ps1
```

Task dapat dilepas tanpa menghapus konfigurasi atau log:

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall-startup-task.ps1
```

PC Orthanc dan akun Windows yang menjalankan task harus tetap menyala serta memiliki koneksi internet.

Konfigurasi baru berikut bersifat opsional karena mempunyai nilai bawaan. Tambahkan secara eksplisit bila ingin mengubah batasnya:

```json
{
  "poll_seconds": 600,
  "upload_original_dicoms": true,
  "max_dicom_instances_per_study": 100
}
```

Nilai `poll_seconds: 600` berarti OrthancBridge memeriksa studi baru setiap 10 menit.

Bridge mengambil `/instances/{id}/file` dari Orthanc dan mengirim byte DICOM asli langsung ke sesi unggah Google Drive. DICOM tidak dimasukkan ke log dan tidak dikonversi sebelum disimpan. Jangan mematikan `upload_original_dicoms` kecuali untuk pemulihan masalah sementara.

## Pemetaan metadata

| Tag DICOM | Isian web app | Aturan |
|---|---|---|
| `PatientName` | Nama pasien | Tanda `^` diubah menjadi spasi; petugas wajib memeriksa |
| `PatientID` | Calon NIK | Diisi otomatis hanya jika menghasilkan tepat 16 angka |
| Tidak tersedia | No. HP | Wajib diisi dan diperiksa manual oleh petugas |
| `PatientBirthDate` | Tanggal lahir | Jika kosong/tidak valid harus diisi petugas |
| `StudyDate` | Tanggal pemeriksaan USG | Jika kosong/tidak valid harus diisi petugas |
| `StudyInstanceUID` | Identitas pemeriksaan | Digunakan untuk mencegah studi yang sama diimpor dua kali |
| `SOPInstanceUID` | Identitas gambar | Disimpan untuk ketertelusuran |

## Gambar dan cine

Secara default `max_frames_per_instance` adalah `1`. Artinya satu preview diambil dari setiap instance DICOM. Ini cocok apabila alat USG menyimpan gambar diam sebagai instance terpisah.

Jika alat menghasilkan cine multi-frame, menaikkan nilai tersebut dapat menghasilkan banyak gambar yang hampir sama. Uji menggunakan data fiktif dan tetap pilih gambar yang benar pada dialog impor. Jumlah akhir dibatasi oleh `max_images_per_study` dan batas dokumen klaim.

Satu instance multi-frame tetap disimpan sebagai satu DICOM asli. Nama fisik di Drive menggunakan kode anonim stabil. Bila studi berisi beberapa instance, nama akhirnya menggunakan nomor urut agar tidak bertabrakan:

```text
DICOM_F1<KODE>_001.dcm
DICOM_F1<KODE>_002.dcm
```

Untuk satu instance, nomor urut tidak ditambahkan. Nama logis lama yang memuat Puskesmas, tanggal pemeriksaan, NIK, dan No. HP tidak dipakai sebagai nama fisik Drive; nama itu direkonstruksi dari kolom privat `claim_filename`/`backup_filename`. URL dan nama penyimpanan anonim dicatat pada baris `ORTHANC_DICOMS`.

## Pemulihan masalah

- `ORTHANC_BRIDGE_DISABLED`: aktifkan bridge pada menu Sistem.
- `ORTHANC_BRIDGE_UNAUTHORIZED`: ID atau kunci pada `config.json` tidak sesuai; buat kunci baru bila perlu.
- `ORTHANC_STUDY_NOT_FOUND`: jalankan bridge kembali; metadata studi harus dikirim sebelum gambar.
- pemeriksaan tidak muncul: pastikan studi berada dalam `lookback_days`, berstatus stabil, dan mempunyai gambar yang dapat dipreview Orthanc.
- data lama tidak dikirim ulang setelah database web app dibuat ulang: hentikan bridge, cadangkan lalu hapus `state.json`, dan jalankan `run-once.ps1`.
- gambar dilewati: periksa dukungan codec DICOM pada Orthanc dan log bridge.
- `DICOM_UPLOAD_SESSION_FAILED`: deployment belum menerima scope `script.external_request`, Drive penuh, atau deployment lama masih aktif; buat versi deployment baru dan otorisasi ulang.
- DICOM asli terus dicoba ulang: periksa koneksi internet, akses Drive deployment, dan kolom `raw_backup_status`/`raw_backup_error` tanpa menyalin data pasien ke chat.

Jangan pernah menghapus atau mengubah baris pada `ORTHANC_INBOX`, `ORTHANC_IMAGES`, atau `DOCUMENTS` secara manual saat bridge sedang berjalan.
