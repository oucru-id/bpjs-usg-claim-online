# Registri Metadata DICOM di BigQuery

Registri ini menyimpan metadata studi USG dan referensi objek privat GCS untuk pencarian operasional serta persiapan pengiriman foto melalui WhatsApp. Registri **bukan** tempat membuat objek GCS menjadi publik dan bukan pengganti konfirmasi identitas pasien oleh petugas.

## Model data

Gunakan dataset `dicom_usg` dengan tiga tabel dan satu view:

- `studies`: satu baris per studi DICOM;
- `study_files`: satu baris per objek DICOM atau JPEG;
- `whatsapp_deliveries`: satu baris outbox/status per pilihan foto (`delivery_reference_id`).
- `v_whatsapp_delivery_reference`: kandidat privat WhatsApp yang menggabungkan identitas studi dan JPEG terurut.

Jangan menyimpan banyak URL dalam satu `STRING` dan jangan membuat kolom `url_1`, `url_2`, dan seterusnya. Satu baris per file mempertahankan jumlah file yang tidak terbatas, mudah diurutkan, dan dapat ditambah tanpa migrasi kolom.

`studies` memuat nama pasien, hasil interpretasi NIK/telepon/dokter, nilai mentah DICOM, sumber setiap hasil, status konflik, tanggal pemeriksaan, waktu lokal pemeriksaan, waktu selesai GCS, waktu sinkronisasi BigQuery, jumlah file, serta status `whatsapp_ready`.

`study_files` memuat tipe file, urutan, frame JPEG, referensi Study/Series/Instance, ukuran, SHA-256, nama objek, dan URI privat `gs://bucket/object`. URI `gs://` stabil dan tidak memberikan akses publik.

`whatsapp_deliveries` memakai `delivery_reference_id` stabil yang diturunkan dari `study_key` dan kumpulan foto terpilih untuk mencegah kirim ganda. Kolom `selected_object_keys` menyimpan foto yang dipilih, sedangkan kolom lain menyimpan status permintaan/provider, jumlah percobaan, tujuan yang dimasker, ID pesan provider, waktu kirim/diterima, dan error terakhir. `REQUESTED`/`QUEUED`/`PROCESSING` belum boleh ditampilkan sebagai terkirim; hanya `SENT`/`DELIVERED`/`READ` atau `sent_at` yang terisi merupakan bukti pengiriman.

## Interpretasi metadata campuran

`PatientName` selalu diperlakukan sebagai nama pasien. Posisi `PatientID`, `AccessionNumber`, dan `PatientComments` tidak menentukan artinya; bridge mengekstrak kandidat berdasarkan bentuk isinya. Satu field dapat menghasilkan lebih dari satu jenis data, misalnya `dr ica; 08113908011` menghasilkan dokter dan nomor HP.

Bridge memeriksa sumber berikut:

- NIK: rangkaian tepat 16 digit pada `PatientID`, `AccessionNumber`, atau `PatientComments`;
- telepon: nomor seluler berawalan `08...` atau `628...` yang setelah dinormalisasi ke bentuk lokal berjumlah 10-13 digit;
- telepon standar, jika tersedia: `PatientTelephoneNumbers`;
- dokter standar, jika tersedia: `PerformingPhysicianName`, `OperatorsName`, atau `ReferringPhysicianName`;
- dokter pada field campuran: teks yang diawali `dr`, `dr.`, atau `dokter` tanpa membedakan huruf besar/kecil. Nomor di field yang sama dikeluarkan sebelum nama dokter dibersihkan.

NIK hanya dipilih otomatis jika tepat satu nilai 16 digit yang unik ditemukan. Nomor telepon dinormalisasi ke bentuk `08...` dan `+628...` hanya jika tepat satu nomor valid ditemukan. Nama dokter hanya dipilih jika tepat satu kandidat unik ditemukan. Kandidat yang sama dari dua field digabung sambil mempertahankan daftar sumbernya. Kandidat berbeda menghasilkan status konflik dan tidak dipilih diam-diam. Semua nilai mentah tetap disimpan pada kolom `*_raw`.

Status hasil:

- `READY`: nama pasien, satu NIK, satu telepon, dan satu dokter tersedia;
- `PARTIAL`: tidak ada konflik, tetapi satu atau lebih nilai wajib belum tersedia;
- `AMBIGUOUS`: ditemukan lebih dari satu kandidat berbeda; sistem tidak memilih secara diam-diam.

`whatsapp_ready=true` hanya jika status `READY` dan sedikitnya satu JPEG tersedia. Status ini adalah kesiapan data, bukan bukti persetujuan pasien atau bukti pesan sudah dikirim.

## Lokasi dan akses

Gunakan lokasi dataset `asia-southeast2` (Jakarta), sama dengan bucket Purbalingga. Dataset berisi nama, NIK, dan nomor telepon sehingga harus diperlakukan sebagai data terbatas:

- jangan memberi akses `allUsers` atau `allAuthenticatedUsers`;
- berikan service account bridge hanya BigQuery Job User pada proyek dan Data Editor pada dataset;
- batasi pembaca dataset pada petugas/sistem yang memang menjalankan alur pengiriman;
- jangan menaruh JSON service account di Git, chat, log, atau dokumentasi;
- pertahankan audit log dan kebijakan retensi sesuai tata kelola organisasi.

## Konfigurasi bridge

Sebelum provisioning, buat dataset `dicom_usg`, ketiga tabel, dan view melalui BigQuery Console dengan menjalankan [`orthanc-bridge/bigquery_schema.sql`](../orthanc-bridge/bigquery_schema.sql). Lokasinya harus **Jakarta (`asia-southeast2`)**. Pada dataset tersebut, tambahkan principal `client_email` dari `gcs-service-account.json` sebagai **BigQuery Data Editor**. Pada IAM proyek, berikan principal yang sama **BigQuery Job User**. Cara ini lebih sempit daripada memberikan izin membuat dataset kepada bridge.

Jika organisasi memang mengizinkan bridge membuat dataset, izin tambahan `bigquery.datasets.create` dibutuhkan pada proyek. Izin tersebut tidak diperlukan untuk operasi harian setelah dataset tersedia.

Tambahkan nilai berikut ke `config.json` privat:

```json
{
  "upload_metadata_to_bigquery": true,
  "bigquery_credentials_file": "gcs-service-account.json",
  "bigquery_project": "",
  "bigquery_dataset": "dicom_usg",
  "bigquery_location": "asia-southeast2",
  "bigquery_studies_table": "studies",
  "bigquery_files_table": "study_files",
  "bigquery_deliveries_table": "whatsapp_deliveries",
  "bigquery_whatsapp_view": "v_whatsapp_delivery_reference",
  "study_timezone": "Asia/Makassar",
  "trigger_whatsapp_webhook": false,
  "whatsapp_webhook_url": "https://n8n.id.spheres.oucru-id.org/webhook/GANTI_PATH_PRODUCTION",
  "whatsapp_webhook_api_key": "GANTI_NILAI_X_API_KEY",
  "whatsapp_webhook_timeout_seconds": 30,
  "whatsapp_trigger_not_before": "2026-10-24T00:00:00+08:00"
}
```

`bigquery_project` boleh dikosongkan; bridge akan memakai `project_id` dari service account. BigQuery hanya dapat diaktifkan jika `upload_to_gcs=true`, karena baris file mengacu pada objek GCS.

Pasang dependensi dan buat skema satu kali:

```powershell
Set-Location -LiteralPath 'C:\BPJS-USG-OrthancBridge'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\setup.ps1'
.\.venv\Scripts\python.exe .\bridge.py --config .\config.json --provision-bigquery
```

Perintah provisioning aman untuk diulang. Jika dataset/tabel sudah ada, skemanya divalidasi dan view kandidat dibuat ulang hanya ketika perintah provisioning dijalankan. Bridge normal tidak membuat atau mengubah skema secara otomatis.

Setelah provisioning, jalankan uji satu kali dan periksa jumlah/status tanpa menyalin PII ke chat:

```powershell
.\run-once.ps1
```

`state.json` mencatat `completed_bigquery` secara terpisah. Kegagalan BigQuery tidak membatalkan Drive atau GCS. Studi akan dicoba ulang sampai upsert berhasil.

## Penggunaan untuk WhatsApp

Jika `trigger_whatsapp_webhook=true`, bridge melakukan `POST` ke production webhook n8n hanya setelah GCS dan BigQuery selesai. Bridge membaca identitas dan foto dari `v_whatsapp_delivery_reference`, bukan mem-parsing DICOM lagi saat trigger. Hanya foto pertama—urutan `sequence_number`, `frame_index`, lalu `object_key`—yang dipilih otomatis. Foto berikutnya tetap tersedia untuk dikirim manual melalui web app.

Sebelum memanggil webhook, bridge memperoleh satu baris outbox dengan `request_source=ORTHANC_BRIDGE_AUTO`, `image_count=1`, dan satu `selected_object_keys`. Kontrak webhook memakai header `X-API-Key` serta payload `study_key`, `delivery_reference_id`, `request_source`, `selected_object_keys`, dan `selected_images`, sama seperti jalur manual kecuali sumber permintaannya. Simpan nilai API key hanya dalam `config.json` privat yang sudah dibatasi ACL; jangan memasukkannya ke source, Git, chat, atau log.

Isi `whatsapp_trigger_not_before` dengan waktu go-live dan zona waktu yang eksplisit. Bridge hanya memicu studi yang penyelesaian BigQuery-nya terjadi pada atau setelah waktu tersebut. Studi lama dicatat dalam `skipped_whatsapp_triggers`, sehingga mengaktifkan fitur tidak mengirim ulang pemeriksaan lama.

Respons HTTP 2xx JSON hanya menandakan n8n menerima trigger. Bridge mengubah outbox menjadi `QUEUED` dan mencatat `completed_whatsapp_triggers` agar siklus berikutnya tidak memicu studi yang sama lagi. Respons gagal mengubah permintaan yang diperoleh menjadi `FAILED`, tidak membatalkan GCS/BigQuery, dan dapat dicoba lagi. Karena timeout jaringan dapat terjadi setelah server menerima request, workflow n8n wajib melakukan deduplikasi berdasarkan `delivery_reference_id` dan memperbarui baris outbox yang sama.

Workflow pengiriman wajib mengambil tepat satu JPEG yang tercantum dalam `selected_object_keys`, memverifikasi bahwa object key tersebut milik `study_key`, lalu meminta akses GCS hanya saat akan mengirim. Jangan menyimpan signed URL permanen di BigQuery. Signed URL dapat digunakan oleh siapa pun yang memilikinya selama masih berlaku; bila diperlukan, buat URL V4 berumur sangat pendek atau unduh objek melalui backend privat lalu kirim medianya.

### Menu web app dan kirim manual

Jalankan `setupApplication()` setelah source versi 7.2 disinkronkan. Migrasi aplikasi menambahkan izin `can_send_whatsapp` pada sheet `USERS` dan setting `ENABLE_WHATSAPP_DELIVERY=false`; migrasi BigQuery pada `bigquery_schema.sql` menambahkan `selected_object_keys`. Administrator selalu memiliki izin, sedangkan izin staf dapat diberikan melalui menu **Pengguna**.

Isi Script Properties berikut tanpa memasukkan nilainya ke source atau chat:

- `GCS_SERVICE_ACCOUNT_KEY`: JSON service account yang sama dengan registry/GCS;
- `GCS_BUCKET_NAME`: bucket privat tempat JPEG bridge berada;
- `GCS_OBJECT_PREFIX`: sama dengan `gcs_prefix` bridge;
- `BIGQUERY_PROJECT_ID`: project registry, atau kosongkan agar memakai `project_id` credential;
- `BIGQUERY_DATASET`: `dicom_usg`;
- `BIGQUERY_LOCATION`: `asia-southeast2`;
- `WHATSAPP_WEBHOOK_URL`: production URL `https://n8n.id.spheres.oucru-id.org/webhook/...`;
- `WHATSAPP_WEBHOOK_API_KEY`: secret `X-API-Key` khusus production webhook.

Jalankan `validateWhatsAppConfiguration()` dari editor Apps Script sebagai administrator pemasang. Setelah validasi lulus dan workflow n8n sudah menulis status provider ke `whatsapp_deliveries`, deploy **New version**, masuk sebagai administrator, lalu aktifkan kartu **Pengiriman WhatsApp** pada menu **Sistem**. Berikan izin staf melalui menu **Pengguna**. Daftar web app selalu difilter dengan `ORTHANC_BRIDGE_ID` instalasi saat ini. Browser tidak menerima credential, nama bucket, URI `gs://`, atau URL publik; backend mengambil byte JPEG privat setelah sesi dan izin diperiksa.

Kirim manual membuat/memperbarui satu baris outbox per pilihan foto, lalu mengirim payload `study_key`, `delivery_reference_id`, `request_source=WEB_APP_MANUAL`, akun peminta, `selected_object_keys`, dan `selected_images` ke n8n. Workflow n8n wajib memakai `delivery_reference_id` sebagai kunci idempotensi dan hanya mengambil JPEG dengan `object_key` yang terdapat dalam `selected_object_keys`, tetap diurutkan dengan `sequence_number` dan `frame_index`. Jangan memakai query semua JPEG berdasarkan `study_key` saja karena itu akan mengabaikan pilihan pengguna.

Workflow memperbarui baris status menggunakan `delivery_reference_id`, bukan hanya `study_key`, lalu mengisi `status`, `provider`, `provider_message_ids`, `last_attempt_at`, `sent_at`, `delivered_at`, `updated_at`, dan `last_error`. Jangan menandai pesan terkirim hanya karena webhook diterima atau URL berhasil dibuat. Permintaan manual maupun otomatis wajib membawa `selected_object_keys`; workflow tidak boleh kembali mengambil semua JPEG dalam studi.

Contoh payload manual:

```json
{
  "study_key": "dummy_whatsapp_20261023_001",
  "delivery_reference_id": "WA_...",
  "request_source": "WEB_APP_MANUAL",
  "selected_object_keys": ["dummy-whatsapp-jpeg-001"],
  "selected_images": [
    { "object_key": "dummy-whatsapp-jpeg-001", "sequence_number": 1, "frame_index": 0 }
  ]
}
```

Node pertama setelah autentikasi webhook harus menghentikan permintaan `WEB_APP_MANUAL` maupun `ORTHANC_BRIDGE_AUTO` dengan HTTP 400 bila `selected_object_keys` hilang atau kosong. Untuk permintaan otomatis, panjang array harus tepat satu. Query BigQuery harus diparameterkan dengan pola berikut:

```sql
SELECT object_key, object_name, sequence_number, frame_index
FROM `stellar-orb-451904-d9.dicom_usg.study_files`
WHERE study_key = @study_key
  AND UPPER(file_type) = 'JPEG'
  AND content_type = 'image/jpeg'
  AND object_key IN UNNEST(@selected_object_keys)
ORDER BY sequence_number, frame_index, object_key
```

Sebelum mengirim, workflow harus memastikan jumlah baris hasil sama dengan panjang `selected_object_keys`. Jika berbeda, hentikan proses dan tulis status `FAILED`; jangan beralih ke semua foto dalam studi.
