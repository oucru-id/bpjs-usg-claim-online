const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sourceRoot = path.join(__dirname, '..', 'src');
const sandbox = {
  Object,
  Number,
  normalizeString_: (value) => String(value || '').trim(),
  maskPatientName: () => 'TES S*****',
  toIsoString_: (value) => String(value || '')
};
vm.createContext(sandbox);
for (const filename of ['Config.gs', 'ClaimService.gs', 'OrthancBridgeService.gs']) {
  vm.runInContext(fs.readFileSync(path.join(sourceRoot, filename), 'utf8'), sandbox, { filename });
}

const claim = sandbox.claimListItem_({
  claim_id: 'CLAIM-ID',
  claim_code: 'CLAIM-20261003-ABC123',
  patient_name: 'TES SULAWESI',
  patient_nik: '7371012345673456',
  patient_phone: '081234567890',
  doctor_name: 'dr. Test',
  examination_date: '2026-10-03',
  status: 'DRAFT',
  facility_id: 'FAC-1',
  updated_at: '2026-10-03T01:00:00Z'
}, { 'FAC-1': 'Puskesmas Test' });
assert.strictEqual(claim.patient_name, 'TES SULAWESI');
assert.strictEqual(claim.patient_nik, '7371012345673456');
assert.strictEqual(claim.patient_phone, '081234567890');
assert.strictEqual(claim.doctor_name, 'dr. Test');
assert.strictEqual(Object.prototype.hasOwnProperty.call(claim, 'patient_name_masked'), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(claim, 'patient_nik_masked'), false);

const inbox = sandbox.orthancInboxListItem_({
  inbox_id: 'INBOX-ID',
  patient_name: 'TES SULAWESI',
  patient_id: 'MR-00005678',
  patient_comments: '7371012345673456',
  patient_nik_candidate: '7371012345673456',
  doctor_name_candidate: 'DR TEST',
  status: 'READY',
  study_date: '2026-10-03',
  updated_at: '2026-10-03T01:00:00Z'
});
assert.strictEqual(inbox.patient_name, 'TES SULAWESI');
assert.strictEqual(inbox.patient_id, 'MR-00005678');
assert.strictEqual(inbox.patient_comments, '7371012345673456');
assert.strictEqual(inbox.patient_nik_candidate, '7371012345673456');
assert.strictEqual(inbox.doctor_name_candidate, 'DR TEST');
assert.strictEqual(Object.prototype.hasOwnProperty.call(inbox, 'patient_name_masked'), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(inbox, 'patient_id_masked'), false);

console.log('Authorized full patient name, NIK, No. HP, doctor name, and Orthanc PatientID display checks passed.');
