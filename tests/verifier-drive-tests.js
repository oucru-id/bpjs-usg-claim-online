const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sourceRoot = path.join(__dirname, '..', 'src');
const updates = [];
const copies = [];
const trashed = [];
const monthFolder = {
  id: 'VERIFIER-OCTOBER-2026',
  getId: () => 'VERIFIER-OCTOBER-2026'
};
const claim = {
  claim_id: 'CLAIM-1',
  facility_id: 'FAC-1',
  examination_date: '2026-10-03',
  patient_name: 'Tes Nama',
  patient_nik: '1234567890123456',
  doctor_name: 'dr. Tes Dua',
  pdf_version: 4,
  verifier_pdf_file_id: 'VERIFIER-PDF-PREVIOUS'
};
const expectedFilename = 'KLAIM_USG_PKM_MENINTING_20261003_TES_NAMA_1234567890123456_DR_TES_DUA.pdf';
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
  backupFilenameSegment_: (value, fallback) => String(value || fallback || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, ''),
  claimDateKey_: (value) => String(value || '').slice(0, 10),
  assert_(condition, code, message) {
    if (!condition) {
      const error = new Error(message);
      error.code = code;
      throw error;
    }
  },
  getBooleanSetting_: (key) => key === 'ENABLE_VERIFIER_DRIVE_DELIVERY',
  accessibleDriveFile_: (fileId) => fileId ? {
    getId: () => fileId
  } : null,
  withScriptLock_: (callback) => callback(),
  findRecord_: (sheet, key, value) => {
    if (sheet === 'FACILITIES' && key === 'facility_id' && value === 'FAC-1') {
      return { facility_id: 'FAC-1', facility_name: 'Puskesmas Meninting' };
    }
    if (sheet === 'CLAIMS' && key === 'claim_id' && value === 'CLAIM-1') {
      return { _rowNumber: 7, claim_id: 'CLAIM-1' };
    }
    return null;
  },
  updateRecord_: (sheet, row, changes) => updates.push({ sheet, row, changes }),
  now_: () => '2026-10-17T10:00:00+08:00',
  trashDriveFile_: (file) => { if (file) trashed.push(file.getId()); },
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

let createdMonthFolderName = '';
sandbox.getVerifierDriveRoot_ = () => ({
  getId: () => 'VERIFIER-ROOT',
  getFoldersByName: () => ({ hasNext: () => false }),
  createFolder: (name) => {
    createdMonthFolderName = name;
    return monthFolder;
  }
});
assert.strictEqual(sandbox.getVerifierDriveMonthFolder_(claim), monthFolder);
assert.strictEqual(createdMonthFolderName, 'OKTOBER 2026');

sandbox.getVerifierDriveMonthFolder_ = () => monthFolder;

assert.strictEqual(sandbox.verifierClaimPdfFilename_(claim), expectedFilename);
assert.strictEqual(sandbox.verifierMonthFolderName_(claim), 'OKTOBER 2026');
assert.strictEqual(
  sandbox.verifierMonthFolderName_({ examination_date: '2026-11-01' }),
  'NOVEMBER 2026'
);

const sourceFile = {
  isTrashed: () => false,
  getId: () => 'PRIMARY-PDF-1',
  makeCopy(name, folder) {
    copies.push({ name, folder });
    return {
      getId: () => 'VERIFIER-PDF-1',
      getUrl: () => 'https://drive.example/verifier-pdf-1'
    };
  }
};
const result = sandbox.deliverClaimPdfToVerifierSafely_(claim, sourceFile);

assert.strictEqual(result.status, 'READY');
assert.strictEqual(result.filename, expectedFilename);
assert.strictEqual(result.storageFilename, expectedFilename);
assert.deepStrictEqual(copies, [{ name: expectedFilename, folder: monthFolder }]);
assert.strictEqual(updates.length, 1);
assert.strictEqual(updates[0].changes.verifier_pdf_file_id, 'VERIFIER-PDF-1');
assert.strictEqual(updates[0].changes.verifier_pdf_status, 'READY');
assert.strictEqual(updates[0].changes.verifier_pdf_filename, expectedFilename);
assert.deepStrictEqual(trashed, ['VERIFIER-PDF-PREVIOUS']);

sandbox.getBooleanSetting_ = () => false;
assert.strictEqual(
  sandbox.deliverClaimPdfToVerifierSafely_({ claim_id: 'CLAIM-2', pdf_version: 1 }, sourceFile).status,
  'DISABLED'
);
assert.strictEqual(copies.length, 1);

let renamedTo = '';
let movedTo = null;
sandbox.getBooleanSetting_ = () => true;
sandbox.Session = { getActiveUser: () => ({ getEmail: () => 'admin@example.test' }) };
sandbox.getRequiredProperty_ = () => 'admin@example.test';
sandbox.readAllRecords_ = () => [{
  ...claim,
  _rowNumber: 8,
  verifier_pdf_file_id: 'VERIFIER-PDF-OLD',
  verifier_pdf_storage_filename: 'KLAIM_F1RAHASIA_v004.pdf'
}];
sandbox.accessibleDriveFile_ = () => ({
  getId: () => 'VERIFIER-PDF-OLD',
  getName: () => 'KLAIM_F1RAHASIA_v004.pdf',
  setName: (name) => { renamedTo = name; },
  moveTo: (folder) => { movedTo = folder; },
  getUrl: () => 'https://drive.example/verifier-pdf-old'
});
const organizeResult = sandbox.organizeExistingVerifierPdfFiles();
assert.strictEqual(organizeResult.checked, 1);
assert.strictEqual(organizeResult.renamed, 1);
assert.strictEqual(organizeResult.organized, 1);
assert.strictEqual(organizeResult.ready, 1);
assert.strictEqual(organizeResult.errors, 0);
assert.strictEqual(organizeResult.hasMore, false);
assert.strictEqual(renamedTo, expectedFilename);
assert.strictEqual(movedTo, monthFolder);
assert.strictEqual(updates[updates.length - 1].changes.verifier_pdf_storage_filename, expectedFilename);

renamedTo = '';
movedTo = null;
sandbox.readAllRecords_ = () => [{
  ...claim,
  _rowNumber: 9,
  verifier_pdf_file_id: 'VERIFIER-PDF-NESTED',
  verifier_pdf_storage_filename: expectedFilename
}];
sandbox.accessibleDriveFile_ = () => ({
  getId: () => 'VERIFIER-PDF-NESTED',
  getName: () => expectedFilename,
  setName: (name) => { renamedTo = name; },
  getParents: () => {
    let available = true;
    return {
      hasNext: () => available,
      next: () => {
        if (!available) throw new Error('Parent iterator exhausted');
        available = false;
        return { getId: () => 'OLD-KLAIM-MONTH-FOLDER' };
      }
    };
  },
  moveTo: (folder) => { movedTo = folder; },
  getUrl: () => 'https://drive.example/verifier-pdf-nested'
});
const flattenResult = sandbox.organizeExistingVerifierPdfFiles();
assert.strictEqual(flattenResult.checked, 1);
assert.strictEqual(flattenResult.renamed, 0);
assert.strictEqual(flattenResult.organized, 1);
assert.strictEqual(renamedTo, '');
assert.strictEqual(movedTo, monthFolder);

assert.throws(
  () => sandbox.assertVerifierDriveIsDistinct_({ getId: () => 'BACKUP' }),
  /berbeda dari folder Drive cadangan/
);

console.log('Verifier Drive delivery checks passed.');
