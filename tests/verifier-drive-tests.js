const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sourceRoot = path.join(__dirname, '..', 'src');
const updates = [];
const copies = [];
const verifierFolder = { id: 'VERIFIER-CLAIMS' };
const sandbox = {
  Object,
  Number,
  Math,
  SCRIPT_PROPERTY_KEYS: {
    VERIFIER_DRIVE_FOLDER_ID: 'VERIFIER_DRIVE_FOLDER_ID',
    ROOT_DRIVE_FOLDER_ID: 'ROOT_DRIVE_FOLDER_ID',
    BACKUP_DRIVE_FOLDER_ID: 'BACKUP_DRIVE_FOLDER_ID',
    ADMIN_EMAIL: 'ADMIN_EMAIL'
  },
  normalizeString_: (value) => String(value || '').trim(),
  normalizeEmail_: (value) => String(value || '').trim().toLowerCase(),
  assert_(condition, code, message) {
    if (!condition) {
      const error = new Error(message);
      error.code = code;
      throw error;
    }
  },
  getBooleanSetting_: (key) => key === 'ENABLE_VERIFIER_DRIVE_DELIVERY',
  claimPdfFilename_: (_claim, version) => `KLAIM_LOGIS_v${String(version).padStart(3, '0')}.pdf`,
  accessibleDriveFile_: () => null,
  withScriptLock_: (callback) => callback(),
  findRecord_: (sheet, key, value) => sheet === 'CLAIMS' && key === 'claim_id' && value === 'CLAIM-1'
    ? { _rowNumber: 7, claim_id: 'CLAIM-1' }
    : null,
  updateRecord_: (sheet, row, changes) => updates.push({ sheet, row, changes }),
  now_: () => '2026-10-16T21:30:00+08:00',
  trashDriveFile_: () => {},
  sanitizePlainText_: (value) => String(value || ''),
  getScriptProperties_: () => ({
    getProperty(key) {
      return {
        ROOT_DRIVE_FOLDER_ID: 'PRIMARY',
        BACKUP_DRIVE_FOLDER_ID: 'BACKUP'
      }[key] || '';
    }
  }),
  appError_: (code, message) => Object.assign(new Error(message), { code })
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(sourceRoot, 'VerifierDriveService.gs'), 'utf8'), sandbox, {
  filename: 'VerifierDriveService.gs'
});
sandbox.getVerifierDriveClaimsFolder_ = () => verifierFolder;

const sourceFile = {
  isTrashed: () => false,
  getSize: () => 12345,
  makeCopy(name, folder) {
    copies.push({ name, folder });
    return {
      getId: () => 'VERIFIER-PDF-1',
      getUrl: () => 'https://drive.example/verifier-pdf-1'
    };
  }
};
const result = sandbox.deliverClaimPdfToVerifierSafely_({
  claim_id: 'CLAIM-1',
  pdf_version: 4
}, sourceFile);

assert.strictEqual(result.status, 'READY');
assert.strictEqual(result.filename, 'KLAIM_LOGIS_v004.pdf');
assert.strictEqual(result.storageFilename, 'KLAIM_LOGIS_v004.pdf');
assert.deepStrictEqual(copies, [{ name: 'KLAIM_LOGIS_v004.pdf', folder: verifierFolder }]);
assert.strictEqual(updates.length, 1);
assert.strictEqual(updates[0].changes.verifier_pdf_file_id, 'VERIFIER-PDF-1');
assert.strictEqual(updates[0].changes.verifier_pdf_status, 'READY');
assert.strictEqual(updates[0].changes.verifier_pdf_filename, 'KLAIM_LOGIS_v004.pdf');
assert.ok(copies[0].name.includes('LOGIS'));

sandbox.getBooleanSetting_ = () => false;
assert.strictEqual(
  sandbox.deliverClaimPdfToVerifierSafely_({ claim_id: 'CLAIM-2', pdf_version: 1 }, sourceFile).status,
  'DISABLED'
);
assert.strictEqual(copies.length, 1);

let renamedTo = '';
sandbox.getBooleanSetting_ = () => true;
sandbox.Session = { getActiveUser: () => ({ getEmail: () => 'admin@example.test' }) };
sandbox.getRequiredProperty_ = () => 'admin@example.test';
sandbox.readAllRecords_ = () => [{
  _rowNumber: 8,
  claim_id: 'CLAIM-1',
  pdf_version: 4,
  verifier_pdf_file_id: 'VERIFIER-PDF-OLD'
}];
sandbox.accessibleDriveFile_ = () => ({
  getName: () => 'KLAIM_F1RAHASIA_v004.pdf',
  setName: (name) => { renamedTo = name; },
  getUrl: () => 'https://drive.example/verifier-pdf-old'
});
const renameResult = sandbox.renameExistingVerifierPdfFiles();
assert.strictEqual(renameResult.checked, 1);
assert.strictEqual(renameResult.renamed, 1);
assert.strictEqual(renameResult.ready, 1);
assert.strictEqual(renameResult.errors, 0);
assert.strictEqual(renamedTo, 'KLAIM_LOGIS_v004.pdf');
assert.strictEqual(updates[updates.length - 1].changes.verifier_pdf_storage_filename, 'KLAIM_LOGIS_v004.pdf');

assert.throws(
  () => sandbox.assertVerifierDriveIsDistinct_({ getId: () => 'BACKUP' }),
  /berbeda dari folder Drive cadangan/
);

console.log('Verifier Drive delivery checks passed.');
