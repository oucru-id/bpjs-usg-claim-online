const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sourceRoot = path.join(__dirname, '..', 'src');
const sandbox = {
  Object,
  Number,
  Math,
  SCRIPT_PROPERTY_KEYS: { FILENAME_CODE_SECRET: 'FILENAME_CODE_SECRET' },
  Utilities: {
    Charset: { UTF_8: 'UTF_8' },
    computeHmacSha256Signature: () => Array(32).fill(7),
    base64EncodeWebSafe: () => 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc='
  },
  getRequiredProperty_: () => 'filename-test-secret',
  normalizeString_: (value) => String(value || '').trim(),
  normalizePatientPhone_(value) {
    const digits = String(value || '').replace(/\D/g, '');
    if (!/^08\d{8,11}$/.test(digits)) throw new Error('No. HP tidak valid.');
    return digits;
  },
  claimDateKey_: (value) => String(value || ''),
  assert_(condition, code, message) {
    if (!condition) {
      const error = new Error(message);
      error.code = code;
      throw error;
    }
  },
  findRecord_(sheet, key, value) {
    if (sheet === 'FACILITIES' && key === 'facility_id' && value === 'FAC-1') {
      return { facility_name: 'Puskesmas Kassi-Kassi' };
    }
    return null;
  }
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(sourceRoot, 'BackupService.gs'), 'utf8'), sandbox, {
  filename: 'BackupService.gs'
});

const claim = {
  claim_id: 'CLAIM-UUID-1',
  facility_id: 'FAC-1',
  examination_date: '2026-10-02',
  patient_nik: '7371012345678901',
  patient_phone: '081234567890',
  doctor_name: 'dr. Rahasia'
};

assert.strictEqual(
  sandbox.claimPdfBackupFilename_(claim),
  'KLAIM_Puskesmas_Kassi_Kassi_20261002_7371012345678901_081234567890.pdf'
);
assert.strictEqual(
  sandbox.claimPdfFilename_(claim, 3),
  'KLAIM_Puskesmas_Kassi_Kassi_20261002_7371012345678901_081234567890_v003.pdf'
);
assert.strictEqual(
  sandbox.claimDicomFilename_(claim, 1, 1),
  'DICOM_Puskesmas_Kassi_Kassi_20261002_7371012345678901_081234567890.dcm'
);
assert.strictEqual(
  sandbox.claimDicomFilename_(claim, 2, 3),
  'DICOM_Puskesmas_Kassi_Kassi_20261002_7371012345678901_081234567890_002.dcm'
);
const dicom = { dicom_id: 'DICOM-UUID-1', inbox_id: 'INBOX-1' };
const pdfStorage = sandbox.claimPdfStorageFilename_(claim, 3);
const pdfBackupStorage = sandbox.claimPdfBackupStorageFilename_(claim);
const dicomStorage = sandbox.claimDicomStorageFilename_(dicom, 1, 1);
const rawStorage = sandbox.rawDicomBackupFilename_(dicom);
assert.match(pdfStorage, /^KLAIM_F1[A-Za-z0-9_-]{22}_v003\.pdf$/);
assert.match(pdfBackupStorage, /^KLAIM_F1[A-Za-z0-9_-]{22}\.pdf$/);
assert.match(dicomStorage, /^DICOM_F1[A-Za-z0-9_-]{22}\.dcm$/);
assert.match(rawStorage, /^DICOM_RAW_F1[A-Za-z0-9_-]{22}\.dcm$/);
[pdfStorage, pdfBackupStorage, dicomStorage, rawStorage].forEach((filename) => {
  assert.ok(!filename.includes(claim.patient_nik));
  assert.ok(!filename.includes(claim.patient_phone));
  assert.ok(!filename.includes(claim.doctor_name));
  assert.ok(!filename.includes('Puskesmas'));
});
assert.strictEqual(sandbox.BACKUP_FOLDER_NAMES.RAW_DICOM, 'DICOM RAW');
assert.throws(
  () => sandbox.claimPdfBackupFilename_({ ...claim, patient_nik: '123' }),
  /NIK/
);
assert.throws(
  () => sandbox.claimPdfBackupFilename_({ ...claim, patient_phone: '' }),
  /No. HP/
);

const fileNames = {
  PDF_PRIMARY: pdfStorage,
  PDF_BACKUP: pdfBackupStorage,
  DICOM_PRIMARY: dicomStorage,
  DICOM_BACKUP: dicomStorage
};
sandbox.accessibleDriveFile_ = (fileId) => fileNames[fileId]
  ? { getName: () => fileNames[fileId], getUrl: () => `${fileId}-url` }
  : null;
assert.strictEqual(sandbox.claimPdfFilesNeedRefresh_({
  ...claim,
  final_pdf_file_id: 'PDF_PRIMARY',
  backup_pdf_file_id: 'PDF_BACKUP',
  backup_pdf_status: 'READY',
  final_pdf_filename: sandbox.claimPdfFilename_(claim, 3),
  final_pdf_storage_filename: pdfStorage,
  final_pdf_url: 'PDF_PRIMARY-url',
  backup_pdf_filename: sandbox.claimPdfBackupFilename_(claim),
  backup_pdf_storage_filename: pdfBackupStorage,
  backup_pdf_url: 'PDF_BACKUP-url',
  pdf_version: 3
}), false);
fileNames.PDF_PRIMARY = 'BPJS_USG_CLAIM-OLD_v003.pdf';
assert.strictEqual(sandbox.claimPdfFilesNeedRefresh_({
  ...claim,
  final_pdf_file_id: 'PDF_PRIMARY',
  backup_pdf_file_id: 'PDF_BACKUP',
  backup_pdf_status: 'READY',
  pdf_version: 3
}), true);
assert.strictEqual(sandbox.claimDicomFilesNeedRefresh_({
  ...dicom,
  claim_drive_file_id: 'DICOM_PRIMARY',
  backup_drive_file_id: 'DICOM_BACKUP',
  backup_status: 'READY',
  claim_filename: sandbox.claimDicomFilename_(claim, 1, 1),
  claim_stored_filename: dicomStorage,
  claim_drive_url: 'DICOM_PRIMARY-url',
  backup_filename: sandbox.claimDicomFilename_(claim, 1, 1),
  backup_stored_filename: dicomStorage,
  backup_drive_url: 'DICOM_BACKUP-url'
}, claim, 1, 1), false);
fileNames.DICOM_BACKUP = 'DICOM_Puskesmas_Kassi_Kassi_20261002_7371012345678901.dcm';
assert.strictEqual(sandbox.claimDicomFilesNeedRefresh_({
  ...dicom,
  claim_drive_file_id: 'DICOM_PRIMARY',
  backup_drive_file_id: 'DICOM_BACKUP',
  backup_status: 'READY',
  claim_filename: sandbox.claimDicomFilename_(claim, 1, 1),
  claim_stored_filename: dicomStorage,
  claim_drive_url: 'DICOM_PRIMARY-url',
  backup_filename: sandbox.claimDicomFilename_(claim, 1, 1),
  backup_stored_filename: dicomStorage,
  backup_drive_url: 'DICOM_BACKUP-url'
}, claim, 1, 1), true);

sandbox.readAllRecords_ = (sheet) => {
  if (sheet === 'CLAIMS') return [{
    claim_id: claim.claim_id,
    final_pdf_storage_filename: pdfStorage,
    final_pdf_url: 'primary-pdf-url',
    final_pdf_filename: sandbox.claimPdfFilename_(claim, 3),
    verifier_pdf_storage_filename: pdfStorage,
    verifier_pdf_url: 'verifier-pdf-url',
    verifier_pdf_filename: sandbox.claimPdfFilename_(claim, 3)
  }];
  if (sheet === 'ORTHANC_DICOMS') return [{
    ...dicom,
    claim_id: claim.claim_id,
    claim_stored_filename: dicomStorage,
    claim_drive_url: 'primary-dicom-url',
    claim_filename: sandbox.claimDicomFilename_(claim, 1, 1)
  }];
  return [];
};
assert.strictEqual(
  sandbox.reconstructFilenameFromDatabase_(pdfStorage).original_filename,
  sandbox.claimPdfFilename_(claim, 3)
);
assert.strictEqual(
  sandbox.reconstructFilenameFromDatabase_('verifier-pdf-url').location,
  'VERIFIER_PDF'
);
assert.strictEqual(
  sandbox.reconstructFilenameFromDatabase_('primary-dicom-url').original_filename,
  sandbox.claimDicomFilename_(claim, 1, 1)
);

console.log('Anonymous Drive filename and database reconstruction checks passed.');
