const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sourceRoot = path.join(__dirname, '..', 'src');
const sandbox = {
  console,
  parseClaimDate_(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) throw new Error('invalid date');
    const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    if (parsed.getUTCFullYear() !== Number(match[1]) || parsed.getUTCMonth() !== Number(match[2]) - 1 || parsed.getUTCDate() !== Number(match[3])) {
      throw new Error('invalid date');
    }
  }
};
vm.createContext(sandbox);
for (const filename of ['Utils.gs', 'Config.gs', 'OrthancBridgeService.gs']) {
  vm.runInContext(fs.readFileSync(path.join(sourceRoot, filename), 'utf8'), sandbox, { filename });
}

const normalized = sandbox.normalizeOrthancStudyPayload_('ORTHANC_TEST', {
  orthanc_study_id: 'abc-123',
  study_instance_uid: '1.2.840.123',
  patient_name: 'SARI^BINTI^AMIN',
  patient_id: '7371-0123-4567-8901',
  patient_birth_date: '19900102',
  study_date: '20260913',
  accession_number: 'ACC-001',
  study_description: 'USG obstetri'
});

assert.strictEqual(normalized.source_key, 'ORTHANC_TEST|1.2.840.123');
assert.strictEqual(normalized.patient_name, 'SARI BINTI AMIN');
assert.strictEqual(normalized.patient_nik_candidate, '7371012345678901');
assert.strictEqual(normalized.patient_birth_date, '1990-01-02');
assert.strictEqual(normalized.study_date, '2026-09-13');

const invalidNik = sandbox.normalizeOrthancStudyPayload_('ORTHANC_TEST', {
  orthanc_study_id: 'abc-456', patient_id: 'RM-12345'
});
assert.strictEqual(invalidNik.patient_nik_candidate, '');
assert.throws(
  () => sandbox.sanitizeOrthancIdentifier_('../etc/passwd', 120, 'ID'),
  /tidak valid/
);

console.log('Orthanc Apps Script normalization and identifier checks passed.');
