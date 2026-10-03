const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'ClaimService.gs'), 'utf8');
const sandbox = {
  Object,
  normalizeString_: (value) => String(value == null ? '' : value).trim(),
  assert_(condition, code, message) {
    if (!condition) {
      const error = new Error(message);
      error.code = code;
      throw error;
    }
  }
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'ClaimService.gs' });

assert.strictEqual(sandbox.normalizePatientPhone_('0812 3456 7890'), '081234567890');
assert.strictEqual(sandbox.normalizePatientPhone_('+62 812-3456-7890'), '081234567890');
assert.strictEqual(sandbox.normalizePatientPhone_('6281234567890'), '081234567890');
assert.strictEqual(sandbox.normalizePatientPhone_('81234567890'), '081234567890');

assert.throws(() => sandbox.normalizePatientPhone_(''), (error) => error.code === 'PATIENT_PHONE_REQUIRED');
assert.throws(() => sandbox.normalizePatientPhone_('0215551234'), (error) => error.code === 'INVALID_PATIENT_PHONE');
assert.throws(() => sandbox.normalizePatientPhone_('08123ABC456'), (error) => error.code === 'INVALID_PATIENT_PHONE');
assert.throws(() => sandbox.normalizePatientPhone_('081234567'), (error) => error.code === 'INVALID_PATIENT_PHONE');
assert.throws(() => sandbox.normalizePatientPhone_('08123456789012'), (error) => error.code === 'INVALID_PATIENT_PHONE');

console.log('Patient phone normalization and validation checks passed.');
