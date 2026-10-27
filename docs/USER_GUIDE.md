# Panduan pengguna — masuk

1. Buka alamat operasional pribadi berakhiran `/exec` yang diberikan administrator.
2. Masukkan nama pengguna dan kata sandi aplikasi.
3. Klik **Masuk**.
4. Saat pertama kali masuk, masukkan dan ulangi kata sandi baru yang terdiri dari minimal 6 karakter. Kata sandi tidak boleh tetap `admin123`.
5. Klik **Keluar** setelah pekerjaan selesai, terutama saat memakai perangkat bersama.

Kata sandi awal adalah `admin123`, kecuali administrator memberikan kata sandi sementara lain. Kata sandi ini hanya untuk Sistem Klaim USG BPJS. Jangan gunakan kembali kata sandi Google, surel, perbankan, atau akun pribadi. Setelah lima kali salah memasukkan kata sandi, akun akan dikunci sementara. Hubungi administrator untuk mengatur ulang kata sandi.

## Membuat klaim

1. Buka menu **Klaim**.
2. Klik **+ Buat Klaim Baru**.
3. Isi nama pasien, NIK 16 angka, No. HP, **Nama Dokter**, tanggal lahir, tanggal pemeriksaan USG, dan fasilitas. No. HP dapat ditulis sebagai `08...` atau `+628...`.
4. Periksa kembali data lalu klik **Simpan Klaim**.
5. Sistem membuat kode klaim otomatis dan membuka halaman detail.

Gunakan data pasien asli hanya setelah pengujian dengan data fiktif selesai dan akses fasilitas sudah diverifikasi.

## Membuat klaim dari Orthanc

Jika menu **Orthanc** tersedia:

1. Pastikan pemeriksaan dari alat USG sudah selesai dikirim ke Orthanc.
2. Buka menu **Orthanc**, kemudian klik **Perbarui Daftar**.
3. Pada pemeriksaan berstatus **Siap ditinjau**, klik **Tinjau**.
4. Periksa dan koreksi nama pasien, NIK, No. HP, **Nama Dokter**, tanggal lahir, serta tanggal pemeriksaan. No. HP wajib diisi manual karena tidak berasal dari DICOM.
5. Aplikasi mencari satu NIK 16 digit dan nama dokter pada `PatientID` maupun `PatientComments`, sehingga keduanya boleh tertukar. Jika NIK tidak ditemukan atau terdapat dua nilai berbeda, NIK wajib dipilih dan dimasukkan petugas secara manual.
6. Periksa juga ID dan Comment yang ditampilkan sebagai metadata sumber. Jika hanya satu kandidat nama dokter terdeteksi, aplikasi mengisikan **Nama Dokter** secara otomatis; petugas tetap wajib memeriksa dan dapat mengoreksinya.
7. Klik thumbnail untuk membuka gambar lebih besar. Ini dapat membantu membaca nama atau NIK yang tercetak pada gambar bila metadata kosong. Membuka pratinjau tidak mengubah centang pilihan gambar.
8. Cocokkan teks pada gambar dengan sumber identitas pasien, lalu pilih hanya gambar USG yang benar. Jangan menjadikan teks gambar sebagai satu-satunya dasar identifikasi.
9. Centang konfirmasi pasien, lalu klik **Buat Klaim dari Orthanc**.
10. Klaim akan terbuka dengan status **Mengumpulkan berkas**. Lanjutkan unggah KTP, Buku KIA, SPP/FKPP BPJS, dan berkas lainnya seperti biasa.

Gunakan **Abaikan Pemeriksaan** hanya untuk data uji, duplikat, atau pemeriksaan yang tidak digunakan. Pemeriksaan yang sudah diabaikan dapat dilihat dengan mencentang **Tampilkan pemeriksaan yang sudah diimpor atau diabaikan**.

## Mencari dan membuka klaim

- Gunakan kotak pencarian untuk kode klaim, nama pasien, NIK, No. HP, atau nama dokter.
- Gunakan filter status dan tanggal pemeriksaan bila diperlukan.
- Daftar klaim menampilkan nama pasien, NIK, No. HP, dan nama dokter lengkap kepada pengguna yang berwenang.
- Klik **Buka** untuk melihat detail klaim yang diizinkan. Halaman detail menampilkan NIK, No. HP, dan nama dokter lengkap, jadi jangan biarkan halaman terbuka pada perangkat bersama.

## Mengubah klaim

Klik **Edit Data Klaim** pada klaim aktif untuk memperbaiki data atau melengkapi **Nama Dokter**. Jika klaim berstatus **Siap** atau **PDF dibuat**, aplikasi meminta konfirmasi dan mengembalikannya ke **Mengumpulkan berkas** agar PDF dibuat ulang. Klaim berstatus **Selesai** terkunci dan tidak menampilkan tombol edit. Klik **Buka Kembali Klaim** terlebih dahulu; setelah status berubah menjadi **Mengumpulkan berkas**, data baru dapat diedit. Klaim yang sudah diarsipkan tidak dapat diedit.

## Mengunggah gambar USG dari komputer

1. Buka detail klaim yang benar.
2. Pada bagian **Gambar USG dari Komputer**, klik **Pilih Gambar USG**.
3. Pilih satu atau beberapa gambar JPEG/PNG hasil ekspor USG.
4. Periksa nama dan jumlah berkas yang dipilih, lalu klik **Unggah Gambar**.
5. Tunggu sampai semua gambar selesai diproses. Jangan menutup tab saat unggahan berjalan.
6. Pastikan thumbnail muncul pada bagian **Berkas Klaim**.

Gambar diperkecil tanpa dipotong. Jika satu gambar gagal, gambar yang sudah berhasil sebelumnya tetap tersimpan. Gambar duplikat dalam klaim yang sama akan ditolak.

## Mengunggah berkas pendukung

1. Buka alamat `/exec` yang sama pada ponsel.
2. Masuk memakai nama pengguna dan kata sandi aplikasi.
3. Cari dan pilih klaim pada **Daftar Klaim USG**.
4. Periksa nama pasien, tanggal pemeriksaan, dan fasilitas sebelum memilih berkas.
5. Pada **Unggah Berkas Pendukung**, pilih KTP (Identitas), Buku KIA, Berkas SPP & FKPP BPJS, atau Berkas Lainnya.
6. Pilih satu PDF atau file foto JPEG/PNG dan tunggu pesan berhasil sebelum memilih berkas berikutnya. Pemilih berkas tidak langsung membuka kamera.
7. PDF diproses per halaman (maksimum 25 MB dan 20 halaman per unggahan) agar dapat dimasukkan ke PDF klaim bersama berkas lainnya.
8. Periksa thumbnail pada **Berkas Klaim**. Gunakan **Lihat** untuk memperbesar atau **Hapus** jika berkas salah.
9. Staf di komputer dapat menekan **Perbarui Daftar** untuk melihat berkas terbaru.

Jangan memilih atau mengunggah dokumen jika pasien atau fasilitas pada detail klaim tidak sesuai. Pengguna hanya dapat membuka klaim yang diizinkan oleh akun dan fasilitasnya.

Foto dan setiap halaman PDF berkas pendukung otomatis dioptimalkan tanpa dipotong. Berkas lanskap dibatasi dalam 1280 x 720 piksel dan berkas potret dalam 720 x 1280 piksel. Gambar yang proporsinya bukan 16:9 dapat memiliki salah satu sisi lebih kecil. Gambar USG yang diunggah dari komputer tidak memakai batas HD ini.

Alur QR tetap tersedia sebagai fitur opsional tetapi dinonaktifkan pada mode Puskesmas tunggal.

## Memeriksa dan mengatur berkas

1. Gunakan **Lihat** untuk memeriksa isi setiap gambar.
2. Klik **Putar 90°** sampai orientasi gambar benar.
3. Centang **Sertakan dalam PDF** hanya untuk berkas yang akan dikirim.
4. Geser kartu pada komputer untuk mengubah urutan PDF. Tombol **Lebih awal** dan **Lebih akhir** dapat digunakan sebagai alternatif.
5. Gunakan **Hapus** jika gambar salah. Data riwayat penghapusan tetap disimpan.

Rotasi, pilihan, dan urutan disimpan pada server sehingga tetap sama setelah halaman dimuat ulang.

## Membuat dan mengunduh PDF

1. Periksa bagian **Siapkan PDF Klaim**. Sedikitnya satu Gambar USG harus dipilih.
2. Klik **Buat PDF**.
3. Periksa kembali nama pasien, NIK lengkap, No. HP, Nama Dokter, tanggal USG, dan jumlah setiap jenis berkas.
4. Centang konfirmasi bahwa seluruh berkas berasal dari pasien yang sama.
5. Klik **Ya, Buat PDF** dan tunggu sampai proses selesai.
6. Jika Drive verifikator diaktifkan, pastikan muncul pesan **PDF berhasil dikirim ke Drive verifikator**. Sistem menaruh salinan terbaru langsung di folder bulan pemeriksaan, misalnya `OKTOBER 2026`, tanpa folder perantara `KLAIM`.
7. Gunakan **Pratinjau PDF** untuk memeriksa hasil.
8. Jika hasil sudah benar, klik **Unduh PDF**.
9. Klik **Selesaikan Klaim** untuk mengunci klaim. Jika GCS diaktifkan, pada tahap ini pastikan muncul pesan **PDF disimpan ke Google Cloud Storage**. Jika pengiriman GCS gagal, PDF utama tetap aman dan klaim tetap selesai; laporkan pesan tersebut kepada administrator.

Pembuatan ulang tidak menimpa PDF lama. Sistem membuat versi `v001`, `v002`, dan seterusnya. Jika klaim selesai perlu diperbaiki, pengguna yang memiliki akses ke klaim tersebut dapat memilih **Buka Kembali Klaim**; setelah data atau berkas berubah, buat versi PDF baru sebelum menyelesaikan klaim kembali.

## Administrator: mengarsipkan klaim

Administrator dapat memilih **Arsipkan Klaim**. Klaim tidak dihapus dan tetap dapat ditemukan dengan mencentang **Sertakan arsip** pada daftar klaim.

## Administrator: menghapus pengguna

1. Buka menu **Pengguna**.
2. Klik **Hapus** di samping akun yang sudah tidak digunakan.
3. Konfirmasi penghapusan permanen.

Aplikasi menghapus pengguna, kredensial nama pengguna/kata sandi, dan seluruh sesi masuknya. Akun administrator yang sedang digunakan tidak dapat dihapus. Jika akun sudah tercatat pada riwayat klaim atau dokumen, penghapusan akan ditolak; edit akun lalu nonaktifkan pilihan **Aktif** agar riwayat operasional tetap utuh.
