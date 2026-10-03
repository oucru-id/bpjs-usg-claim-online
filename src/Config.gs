var APP_CONFIG = Object.freeze({
  APP_NAME: 'Sistem Klaim USG BPJS',
  APP_DESCRIPTION: 'Pengelolaan klaim USG, dokumen pendukung, dan data DICOM Orthanc secara terintegrasi.',
  APP_VERSION: '6.7.0-supporting-pdf-files',
  AUTH_MODE: 'USERNAME_PASSWORD',
  TIMEZONE: 'Asia/Makassar',
  DATABASE_NAME: 'BPJS_USG_APP_DATABASE',
  ROOT_FOLDER_NAME: 'BPJS_USG_APP',
  CLAIMS_FOLDER_NAME: 'CLAIMS',
  SYSTEM_FOLDER_NAME: 'SYSTEM',
  DEFAULT_FACILITY_ID: 'FACILITY_DEFAULT',
  DEFAULT_FACILITY_NAME: 'Fasilitas Utama'
});

var SCRIPT_PROPERTY_KEYS = Object.freeze({
  DATABASE_SPREADSHEET_ID: 'DATABASE_SPREADSHEET_ID',
  ROOT_DRIVE_FOLDER_ID: 'ROOT_DRIVE_FOLDER_ID',
  CLAIMS_FOLDER_ID: 'CLAIMS_FOLDER_ID',
  SYSTEM_FOLDER_ID: 'SYSTEM_FOLDER_ID',
  ORTHANC_INBOX_FOLDER_ID: 'ORTHANC_INBOX_FOLDER_ID',
  ORTHANC_BRIDGE_ID: 'ORTHANC_BRIDGE_ID',
  ORTHANC_BRIDGE_SECRET_HASH: 'ORTHANC_BRIDGE_SECRET_HASH',
  BACKUP_DRIVE_FOLDER_ID: 'BACKUP_DRIVE_FOLDER_ID',
  ADMIN_EMAIL: 'ADMIN_EMAIL',
  WORKSPACE_DOMAIN: 'WORKSPACE_DOMAIN',
  APP_NAME: 'APP_NAME',
  APP_VERSION: 'APP_VERSION',
  AUTH_MODE: 'AUTH_MODE',
  MAX_IMAGE_DIMENSION: 'MAX_IMAGE_DIMENSION',
  JPEG_QUALITY: 'JPEG_QUALITY',
  MOBILE_TOKEN_LIFETIME_MINUTES: 'MOBILE_TOKEN_LIFETIME_MINUTES',
  MAX_DOCUMENTS_PER_CLAIM: 'MAX_DOCUMENTS_PER_CLAIM',
  MAX_PDF_SIZE_MB: 'MAX_PDF_SIZE_MB',
  TIMEZONE: 'TIMEZONE',
  APP_SESSION_HOURS: 'APP_SESSION_HOURS',
  PASSWORD_PEPPER: 'PASSWORD_PEPPER',
  FILENAME_CODE_SECRET: 'FILENAME_CODE_SECRET',
  PASSWORD_HASH_ITERATIONS: 'PASSWORD_HASH_ITERATIONS',
  LOGIN_MAX_ATTEMPTS: 'LOGIN_MAX_ATTEMPTS',
  LOGIN_LOCK_MINUTES: 'LOGIN_LOCK_MINUTES'
});

var SHEET_SCHEMAS = Object.freeze({
  USERS: [
    'user_id', 'google_email', 'full_name', 'role', 'facility_id', 'active',
    'can_create_claim', 'can_view_all_claims', 'can_generate_pdf',
    'can_download_pdf', 'can_manage_users', 'created_at', 'created_by',
    'updated_at', 'updated_by'
  ],
  FACILITIES: ['facility_id', 'facility_name', 'active', 'created_at'],
  CLAIMS: [
    'claim_id', 'claim_code', 'facility_id', 'patient_name', 'patient_nik',
    'patient_phone', 'patient_birth_date', 'examination_date', 'status', 'created_by',
    'created_at', 'updated_by', 'updated_at', 'mobile_upload_token_hash',
    'mobile_upload_token_expires_at', 'mobile_upload_token_revoked_at',
    'drive_claim_folder_id', 'selected_document_count', 'pdf_version',
    'final_pdf_file_id', 'final_pdf_filename', 'final_pdf_storage_filename',
    'final_pdf_url', 'final_pdf_generated_at',
    'final_pdf_generated_by', 'backup_pdf_file_id', 'backup_pdf_filename',
    'backup_pdf_storage_filename', 'backup_pdf_url',
    'backup_pdf_at', 'backup_pdf_status', 'backup_pdf_error',
    'completed_at', 'archived_at'
  ],
  DOCUMENTS: [
    'document_id', 'claim_id', 'document_type', 'source_type',
    'original_filename', 'stored_filename', 'drive_file_id',
    'thumbnail_file_id', 'mime_type', 'file_size_bytes', 'image_width',
    'image_height', 'sha256_hash', 'display_order', 'rotation_degrees',
    'selected_for_pdf', 'uploaded_by', 'uploaded_at', 'updated_by',
    'updated_at', 'deleted_flag', 'deleted_by', 'deleted_at',
    'orthanc_study_id', 'orthanc_series_id', 'orthanc_instance_id',
    'orthanc_frame_index'
  ],
  AUDIT_LOG: [
    'audit_id', 'timestamp', 'user_id', 'user_email', 'facility_id',
    'claim_id', 'document_id', 'action', 'details_json'
  ],
  AUTH_CREDENTIALS: [
    'credential_id', 'user_id', 'username', 'password_salt', 'password_hash',
    'hash_algorithm', 'hash_iterations', 'failed_attempts', 'locked_until',
    'password_changed_at', 'created_at', 'updated_at', 'must_change_password'
  ],
  AUTH_SESSIONS: [
    'session_id', 'token_hash', 'user_id', 'created_at', 'expires_at',
    'revoked_at'
  ],
  ORTHANC_INBOX: [
    'inbox_id', 'bridge_id', 'source_key', 'orthanc_study_id',
    'study_instance_uid', 'patient_name', 'patient_id',
    'patient_nik_candidate', 'patient_birth_date', 'study_date',
    'accession_number', 'study_description', 'status', 'expected_images',
    'received_images', 'skipped_images', 'expected_dicoms', 'received_dicoms',
    'skipped_dicoms', 'bridge_message', 'claim_id',
    'received_at', 'updated_at', 'imported_at', 'imported_by',
    'rejected_at', 'rejected_by'
  ],
  ORTHANC_IMAGES: [
    'image_id', 'inbox_id', 'source_key', 'orthanc_instance_id',
    'orthanc_series_id', 'sop_instance_uid', 'frame_index',
    'original_filename', 'stored_filename', 'drive_file_id',
    'thumbnail_file_id', 'mime_type', 'file_size_bytes', 'image_width',
    'image_height', 'sha256_hash', 'received_at', 'imported_document_id'
  ],
  ORTHANC_DICOMS: [
    'dicom_id', 'inbox_id', 'source_key', 'orthanc_instance_id',
    'orthanc_series_id', 'sop_instance_uid', 'sequence_number', 'status', 'original_filename',
    'stored_filename', 'staging_drive_file_id', 'staging_drive_url', 'file_size_bytes',
    'sha256_hash', 'received_at', 'claim_id', 'claim_filename',
    'claim_stored_filename', 'claim_drive_file_id', 'claim_drive_url',
    'attached_at', 'backup_drive_file_id', 'backup_filename',
    'backup_stored_filename', 'backup_drive_url', 'backup_at',
    'backup_status', 'backup_error', 'raw_backup_drive_file_id',
    'raw_backup_filename', 'raw_backup_drive_url', 'raw_backup_at',
    'raw_backup_status', 'raw_backup_error'
  ],
  SETTINGS: ['setting_key', 'setting_value', 'description', 'updated_at', 'updated_by']
});

var DEFAULT_SETTINGS = Object.freeze([
  ['CLINIC_NAME', 'Fasilitas Utama', 'Nama fasilitas yang tampil pada aplikasi'],
  ['MAX_DOCUMENTS_PER_CLAIM', '30', 'Batas jumlah dokumen per klaim'],
  ['PDF_USG_IMAGES_PER_PAGE', '1', 'Satu gambar USG per halaman PDF agar ukurannya maksimal'],
  ['PDF_INCLUDE_COVER', 'true', 'Sertakan halaman sampul PDF'],
  ['MOBILE_UPLOAD_TOKEN_MINUTES', '120', 'Masa berlaku token unggah ponsel'],
  ['ENABLE_MOBILE_QR_UPLOAD', 'false', 'Aktifkan alur unggah ponsel menggunakan QR dan token'],
  ['ENABLE_ORTHANC_BRIDGE', 'false', 'Aktifkan penerimaan pemeriksaan dari OrthancBridge lokal'],
  ['ENABLE_SECONDARY_DRIVE_BACKUP', 'false', 'Salin seluruh DICOM raw, DICOM terkait klaim, dan PDF klaim ke folder Drive cadangan'],
  ['REQUIRE_USG', 'true', 'Wajib sedikitnya satu gambar USG terpilih'],
  ['REQUIRE_KTP', 'false', 'Wajib KTP sebelum PDF'],
  ['REQUIRE_BUKU_KIA', 'false', 'Wajib Buku KIA sebelum PDF'],
  ['REQUIRE_SPP_FKPP_BPJS', 'false', 'Wajib berkas SPP dan FKPP BPJS sebelum PDF']
]);

var ROLES = Object.freeze({ ADMIN: 'ADMIN', STAFF: 'STAFF' });

var CLAIM_STATUSES = Object.freeze({
  DRAFT: 'DRAFT',
  COLLECTING_DOCUMENTS: 'COLLECTING_DOCUMENTS',
  READY: 'READY',
  PDF_GENERATED: 'PDF_GENERATED',
  COMPLETED: 'COMPLETED',
  ARCHIVED: 'ARCHIVED'
});

var DOCUMENT_TYPES = Object.freeze({
  USG: 'USG',
  KTP: 'KTP',
  BUKU_KIA: 'BUKU_KIA',
  SPP_FKPP_BPJS: 'SPP_FKPP_BPJS',
  OTHER: 'OTHER'
});

var DOCUMENT_TYPE_LABELS = Object.freeze({
  USG: 'Gambar USG',
  KTP: 'KTP (Identitas)',
  BUKU_KIA: 'Buku KIA',
  SPP_FKPP_BPJS: 'Berkas SPP & FKPP BPJS',
  OTHER: 'Berkas Lainnya',
  RUJUKAN: 'Berkas Lainnya (kategori lama)',
  BPJS: 'Berkas Lainnya (kategori lama)',
  LAB: 'Berkas Lainnya (kategori lama)'
});

var SOURCE_TYPES = Object.freeze({
  PC_UPLOAD: 'PC_UPLOAD',
  MOBILE_UPLOAD: 'MOBILE_UPLOAD',
  ORTHANC_IMPORT: 'ORTHANC_IMPORT'
});

var ORTHANC_INBOX_STATUSES = Object.freeze({
  RECEIVING: 'RECEIVING',
  READY: 'READY',
  IMPORTED: 'IMPORTED',
  REJECTED: 'REJECTED',
  ERROR: 'ERROR'
});

var UPLOAD_LIMITS = Object.freeze({
  MAX_IMAGE_BYTES: 6 * 1024 * 1024,
  MAX_THUMBNAIL_BYTES: 500 * 1024,
  MAX_IMAGE_DIMENSION: 3200,
  MAX_THUMBNAIL_DIMENSION: 500,
  MAX_ORIGINAL_FILENAME_LENGTH: 160,
  MAX_DICOM_BYTES: 2 * 1024 * 1024 * 1024
});

var PASSWORD_POLICY = Object.freeze({
  MIN_LENGTH: 6,
  MAX_LENGTH: 128,
  DEFAULT_INITIAL_PASSWORD: 'admin123'
});

var PERMISSIONS = Object.freeze([
  'can_create_claim', 'can_view_all_claims', 'can_generate_pdf',
  'can_download_pdf', 'can_manage_users'
]);

function getScriptProperties_() {
  return PropertiesService.getScriptProperties();
}

function getRequiredProperty_(key) {
  var value = normalizeString_(getScriptProperties_().getProperty(key));
  if (!value) {
    throw appError_('CONFIGURATION_MISSING', 'Konfigurasi aplikasi belum lengkap: ' + key + '.');
  }
  return value;
}

function getBooleanSetting_(settingKey, fallback) {
  var setting = findRecord_('SETTINGS', 'setting_key', settingKey);
  return setting ? normalizeBoolean_(setting.setting_value) : Boolean(fallback);
}
