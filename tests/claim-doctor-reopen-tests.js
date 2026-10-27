const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sourceRoot = path.join(__dirname, '..', 'src');
const configSource = fs.readFileSync(path.join(sourceRoot, 'Config.gs'), 'utf8');
const claimSource = fs.readFileSync(path.join(sourceRoot, 'ClaimService.gs'), 'utf8');
const pdfSource = fs.readFileSync(path.join(sourceRoot, 'PdfService.gs'), 'utf8');
const repositorySource = fs.readFileSync(path.join(sourceRoot, 'SheetRepository.gs'), 'utf8');

const validationSandbox = {
  Object,
  normalizeString_: (value) => String(value == null ? '' : value).trim(),
  sanitizePlainText_: (value, maximumLength) => String(value == null ? '' : value).trim().substring(0, maximumLength),
  assert_(condition, code, message) {
    if (!condition) {
      const error = new Error(message);
      error.code = code;
      throw error;
    }
  }
};
vm.createContext(validationSandbox);
vm.runInContext(claimSource, validationSandbox, { filename: 'ClaimService.gs' });

assert.strictEqual(validationSandbox.normalizeDoctorName_('  dr. Test  '), 'dr. Test');
assert.strictEqual(validationSandbox.normalizeDoctorName_('D'.repeat(140)).length, 120);
assert.throws(
  () => validationSandbox.normalizeDoctorName_(''),
  (error) => error.code === 'DOCTOR_NAME_REQUIRED'
);
assert.throws(
  () => validationSandbox.normalizeDoctorName_('D'),
  (error) => error.code === 'DOCTOR_NAME_REQUIRED'
);

const migrationSandbox = {
  Object,
  Date,
  Number,
  APP_CONFIG: { TIMEZONE: 'Asia/Makassar' },
  CLAIM_STATUSES: {
    DRAFT: 'DRAFT',
    COLLECTING_DOCUMENTS: 'COLLECTING_DOCUMENTS',
    COMPLETED: 'COMPLETED',
    ARCHIVED: 'ARCHIVED'
  },
  normalizeString_: (value) => String(value == null ? '' : value).trim(),
  normalizeEmail_: (value) => String(value == null ? '' : value).trim().toLowerCase(),
  validateEmail_: (value) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(value || '')),
  Utilities: { formatDate: (value) => new Date(value).toISOString().substring(0, 10) }
};
vm.createContext(migrationSandbox);
vm.runInContext(configSource, migrationSandbox, { filename: 'Config.gs' });
vm.runInContext(repositorySource, migrationSandbox, { filename: 'SheetRepository.gs' });

const corruptedClaim = {
  claim_id: 'CORRUPTED-CLAIM',
  patient_birth_date: 'tes',
  examination_date: new Date('2026-01-10T12:00:00Z'),
  status: new Date('2026-05-05T12:00:00Z'),
  selected_document_count: 5,
  final_pdf_file_id: 'PDF-FILE',
  completed_at: '',
  archived_at: '',
  updated_by: 'old@example.test',
  updated_at: 'staff@example.test',
  mobile_upload_token_hash: new Date('2026-10-16T03:00:00Z')
};
const repairedClaim = migrationSandbox.repairCorruptedClaimDoctorRecord_(corruptedClaim);
assert(repairedClaim);
assert.strictEqual(repairedClaim.doctor_name, 'tes');
assert.strictEqual(repairedClaim.patient_birth_date, corruptedClaim.examination_date);
assert.strictEqual(repairedClaim.examination_date, corruptedClaim.status);
assert.strictEqual(repairedClaim.status, 'COLLECTING_DOCUMENTS');
assert.strictEqual(repairedClaim.updated_by, 'staff@example.test');
assert.strictEqual(repairedClaim.updated_at, corruptedClaim.mobile_upload_token_hash);
assert.strictEqual(repairedClaim.mobile_upload_token_hash, '');
assert.strictEqual(migrationSandbox.repairCorruptedClaimDoctorRecord_({
  patient_birth_date: new Date('1990-01-01T12:00:00Z'),
  examination_date: new Date('2026-05-05T12:00:00Z'),
  status: 'COLLECTING_DOCUMENTS'
}), null);

const claimHeaders = Array.from(migrationSandbox.SHEET_SCHEMAS.CLAIMS);
const corruptedRow = claimHeaders.map(() => '');
const setCorruptedValue = (header, value) => { corruptedRow[claimHeaders.indexOf(header)] = value; };
setCorruptedValue('claim_id', 'CORRUPTED-CLAIM');
setCorruptedValue('patient_birth_date', 'tes');
setCorruptedValue('examination_date', new Date('2026-01-10T12:00:00Z'));
setCorruptedValue('status', new Date('2026-05-05T12:00:00Z'));
setCorruptedValue('selected_document_count', 5);
setCorruptedValue('final_pdf_file_id', 'PDF-FILE');
setCorruptedValue('updated_at', 'staff@example.test');
setCorruptedValue('mobile_upload_token_hash', new Date('2026-10-16T03:00:00Z'));
let writtenHeaders = null;
let writtenRows = null;
const fakeSheet = {
  getLastColumn: () => claimHeaders.length,
  getLastRow: () => 2,
  getMaxColumns: () => claimHeaders.length,
  insertColumnsAfter: () => { throw new Error('No column insertion expected for current schema.'); },
  setFrozenRows: () => {},
  getRange(row, column, rowCount) {
    return {
      getDisplayValues: () => [claimHeaders.slice()],
      getValues: () => [corruptedRow.slice()],
      clearContent: () => {},
      setValues(values) {
        if (row === 1) writtenHeaders = values[0];
        else writtenRows = values;
        return this;
      },
      setFontWeight() { return this; }
    };
  }
};
const migrationResult = migrationSandbox.repairClaimDoctorSchemaMigration_({
  getSheetByName: (name) => name === 'CLAIMS' ? fakeSheet : null
});
assert.strictEqual(migrationResult.repairedRows, 1);
assert.deepStrictEqual(Array.from(writtenHeaders), claimHeaders);
assert.strictEqual(writtenRows[0][claimHeaders.indexOf('doctor_name')], 'tes');
assert.strictEqual(writtenRows[0][claimHeaders.indexOf('patient_birth_date')], corruptedRow[claimHeaders.indexOf('examination_date')]);
assert.strictEqual(writtenRows[0][claimHeaders.indexOf('examination_date')], corruptedRow[claimHeaders.indexOf('status')]);
assert.strictEqual(writtenRows[0][claimHeaders.indexOf('status')], 'COLLECTING_DOCUMENTS');

const completedClaimForEdit = {
  _rowNumber: 8,
  claim_id: '22222222-2222-4222-8222-222222222222',
  claim_code: 'CLAIM-20261016-EDIT01',
  facility_id: 'FAC-1',
  status: 'COMPLETED',
  completed_at: '2026-10-16T01:00:00Z',
  doctor_name: ''
};
let editChanges = null;
const editAuditActions = [];
const updateSandbox = {
  Object,
  Date,
  APP_CONFIG: { TIMEZONE: 'Asia/Makassar' },
  ROLES: { ADMIN: 'ADMIN', STAFF: 'STAFF' },
  CLAIM_STATUSES: {
    DRAFT: 'DRAFT',
    COLLECTING_DOCUMENTS: 'COLLECTING_DOCUMENTS',
    READY: 'READY',
    PDF_GENERATED: 'PDF_GENERATED',
    COMPLETED: 'COMPLETED'
  },
  normalizeString_: (value) => String(value == null ? '' : value).trim(),
  normalizeBoolean_: (value) => Boolean(value),
  sanitizePlainText_: (value, maximumLength) => String(value == null ? '' : value).trim().substring(0, maximumLength),
  Utilities: {
    formatDate: (value) => new Date(value).toISOString().substring(0, 10)
  },
  findRecord_: (sheetName, key, value) => {
    if (sheetName === 'CLAIMS') {
      assert.strictEqual(key, 'claim_id');
      assert.strictEqual(value, completedClaimForEdit.claim_id);
      return completedClaimForEdit;
    }
    assert.strictEqual(sheetName, 'FACILITIES');
    assert.strictEqual(key, 'facility_id');
    assert.strictEqual(value, 'FAC-1');
    return { facility_id: 'FAC-1', active: true };
  },
  canAccessClaim: () => true,
  maskNik: (value) => String(value || ''),
  toIsoString_: (value) => value ? new Date(value).toISOString() : '',
  normalizeEmail_: (value) => String(value || '').trim().toLowerCase(),
  requireAuthenticatedUser: () => ({ role: 'STAFF', facility_id: 'FAC-1', google_email: 'staff@example.test' }),
  withScriptLock_: (callback) => callback(),
  requireAccessibleClaim_: () => completedClaimForEdit,
  assert_(condition, code, message) {
    if (!condition) {
      const error = new Error(message);
      error.code = code;
      throw error;
    }
  },
  now_: () => new Date('2026-10-16T03:00:00Z'),
  updateRecord_: (sheet, rowNumber, changes) => {
    assert.strictEqual(sheet, 'CLAIMS');
    assert.strictEqual(rowNumber, 8);
    editChanges = changes;
  },
  writeAudit_: (user, action, claimId, documentId, details) => {
    editAuditActions.push({ action, details });
  },
  claimDetailForClient_: (record) => record,
  success_: (data) => ({ success: true, data }),
  publicError_: (error) => ({ success: false, code: error.code, message: error.message })
};
vm.createContext(updateSandbox);
vm.runInContext(claimSource, updateSandbox, { filename: 'ClaimService.gs' });

const editResult = updateSandbox.updateClaim('staff-session', {
  claim_id: completedClaimForEdit.claim_id,
  patient_name: 'Pasien Test',
  patient_nik: '1234567890123456',
  patient_phone: '081234567890',
  doctor_name: 'dr. Test',
  patient_birth_date: '1990-01-01',
  examination_date: '2026-10-03',
  facility_id: 'FAC-1'
});
assert.strictEqual(editResult.success, false, JSON.stringify(editResult));
assert.strictEqual(editResult.code, 'CLAIM_REOPEN_REQUIRED');
assert.match(editResult.message, /Buka kembali klaim/);
assert.strictEqual(editChanges, null);
assert.deepStrictEqual(editAuditActions, []);

completedClaimForEdit.status = 'COLLECTING_DOCUMENTS';
completedClaimForEdit.completed_at = '';
const editAfterReopenResult = updateSandbox.updateClaim('staff-session', {
  claim_id: completedClaimForEdit.claim_id,
  patient_name: 'Pasien Test',
  patient_nik: '1234567890123456',
  patient_phone: '081234567890',
  doctor_name: 'dr. Test',
  patient_birth_date: '1990-01-01',
  examination_date: '2026-10-03',
  facility_id: 'FAC-1'
});
assert.strictEqual(editAfterReopenResult.success, true, JSON.stringify(editAfterReopenResult));
assert.strictEqual(editAfterReopenResult.data.status, 'COLLECTING_DOCUMENTS');
assert.strictEqual(editAfterReopenResult.data.doctor_name, 'dr. Test');
assert.strictEqual(Object.prototype.hasOwnProperty.call(editChanges, 'status'), false);
assert.deepStrictEqual(editAuditActions.map((entry) => entry.action), ['CLAIM_UPDATED']);

const claim = {
  _rowNumber: 7,
  claim_id: '11111111-1111-4111-8111-111111111111',
  claim_code: 'CLAIM-20261016-ABC123',
  facility_id: 'FAC-1',
  status: 'COMPLETED',
  pdf_version: 2,
  completed_at: '2026-10-16T01:00:00Z'
};
let updatedChanges = null;
let auditAction = '';
const reopenSandbox = {
  Object,
  Number,
  PDF_LAYOUT: undefined,
  DocumentApp: {},
  MimeType: {},
  DriveApp: {},
  CLAIM_STATUSES: { COMPLETED: 'COMPLETED', COLLECTING_DOCUMENTS: 'COLLECTING_DOCUMENTS' },
  normalizeString_: (value) => String(value == null ? '' : value).trim(),
  normalizeBoolean_: (value) => Boolean(value),
  activeDocumentsForClaim_: () => [{ document_type: 'USG', selected_for_pdf: true }],
  getBooleanSetting_: (key, fallback) => key === 'REQUIRE_USG' ? true : Boolean(fallback),
  requireAuthenticatedUser: (token) => {
    assert.strictEqual(token, 'staff-session');
    return { role: 'STAFF', facility_id: 'FAC-1', google_email: 'staff@example.test' };
  },
  requireRole: () => { throw new Error('Administrator role must not be required.'); },
  withScriptLock_: (callback) => callback(),
  requireAccessibleClaim_: (user, claimId) => {
    assert.strictEqual(user.role, 'STAFF');
    assert.strictEqual(claimId, claim.claim_id);
    return claim;
  },
  assert_(condition, code, message) {
    if (!condition) {
      const error = new Error(message);
      error.code = code;
      throw error;
    }
  },
  now_: () => new Date('2026-10-16T02:00:00Z'),
  updateRecord_: (sheet, rowNumber, changes) => {
    assert.strictEqual(sheet, 'CLAIMS');
    assert.strictEqual(rowNumber, 7);
    updatedChanges = changes;
  },
  writeAudit_: (user, action) => { auditAction = action; },
  claimDetailForClient_: (record) => record,
  success_: (data) => ({ success: true, data }),
  publicError_: (error) => ({ success: false, code: error.code, message: error.message })
};
vm.createContext(reopenSandbox);
vm.runInContext(pdfSource, reopenSandbox, { filename: 'PdfService.gs' });

const missingDoctorPreparation = reopenSandbox.buildPdfPreparation_({ claim_id: claim.claim_id, doctor_name: '' });
assert(missingDoctorPreparation.issues.includes('Lengkapi Nama Dokter pada data klaim.'));
const completePreparation = reopenSandbox.buildPdfPreparation_({ claim_id: claim.claim_id, doctor_name: 'dr. Test' });
assert.strictEqual(completePreparation.issues.length, 0);

const result = reopenSandbox.reopenClaim('staff-session', claim.claim_id);
assert.strictEqual(result.success, true);
assert.strictEqual(result.data.status, 'COLLECTING_DOCUMENTS');
assert.strictEqual(result.data.completed_at, '');
assert.strictEqual(updatedChanges.status, 'COLLECTING_DOCUMENTS');
assert.strictEqual(updatedChanges.updated_by, 'staff@example.test');
assert.strictEqual(auditAction, 'CLAIM_REOPENED');

console.log('Completed-claim lock, explicit reopening, and doctor validation checks passed.');
