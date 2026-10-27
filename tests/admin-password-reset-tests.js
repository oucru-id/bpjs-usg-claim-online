'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'PasswordAuthService.gs'), 'utf8');
const preparedCalls = [];
const appliedCalls = [];
const auditCalls = [];
let activeEmail = 'owner@example.test';
let existingCredential = null;

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'PasswordAuthService.gs' });

Object.assign(sandbox, {
  Session: { getActiveUser: () => ({ getEmail: () => activeEmail }) },
  SCRIPT_PROPERTY_KEYS: { ADMIN_EMAIL: 'ADMIN_EMAIL' },
  PASSWORD_POLICY: { DEFAULT_INITIAL_PASSWORD: 'admin123' },
  ROLES: { ADMIN: 'ADMIN' },
  normalizeString_: (value) => String(value || '').trim(),
  normalizeEmail_: (value) => String(value || '').trim().toLowerCase(),
  normalizeUsername_: (value) => String(value || '').trim().toLowerCase(),
  isValidUsername_: (value) => /^[a-z0-9._-]{4,64}$/.test(value),
  getRequiredProperty_: () => 'owner@example.test',
  assert_: (condition, code, message) => {
    if (!condition) {
      const error = new Error(message);
      error.code = code;
      throw error;
    }
  },
  withScriptLock_: (callback) => callback(),
  findUserByEmail_: () => ({
    user_id: 'USER-ADMIN', google_email: 'owner@example.test', facility_id: 'FAC-1',
    role: 'ADMIN', active: true
  }),
  normalizeUserRecord_: (record) => ({ ...record }),
  findRecord_: (sheetName) => sheetName === 'AUTH_CREDENTIALS'
    ? existingCredential
    : null,
  findCredentialByUsername_: () => null,
  appError_: (code, message) => {
    const error = new Error(message);
    error.code = code;
    return error;
  },
  prepareCredentialUpdate_: (userId, username, password) => {
    preparedCalls.push({ userId, username, password });
    return { existing: existingCredential, changes: { must_change_password: true } };
  },
  applyCredentialUpdate_: (userId, prepared) => appliedCalls.push({ userId, prepared }),
  writeAudit_: (...args) => auditCalls.push(args)
});

const result = sandbox.resetAdminPassword();
assert.strictEqual(result.success, true);
assert.strictEqual(result.username, 'admin');
assert.strictEqual(result.credentialCreated, true);
assert.strictEqual(result.mustChangePassword, true);
assert.deepStrictEqual(preparedCalls, [{
  userId: 'USER-ADMIN', username: 'admin', password: 'admin123'
}]);
assert.strictEqual(appliedCalls.length, 1, 'reset must apply the temporary credential and revoke sessions');
assert.strictEqual(auditCalls.length, 1, 'reset must be audited');
assert.strictEqual(auditCalls[0][1], 'ADMIN_PASSWORD_RESET');
assert.strictEqual(auditCalls[0][4].credential_created, true);
assert.strictEqual(auditCalls[0][4].forced_password_change, true);

existingCredential = { _rowNumber: 7, user_id: 'USER-ADMIN', username: 'admin.bpjs' };
const existingResult = sandbox.resetAdminPassword();
assert.strictEqual(existingResult.username, 'admin.bpjs');
assert.strictEqual(existingResult.credentialCreated, false);
assert.deepStrictEqual(preparedCalls[1], {
  userId: 'USER-ADMIN', username: 'admin.bpjs', password: 'admin123'
});
assert.strictEqual(auditCalls[1][4].credential_created, false);

sandbox.findCredentialByUsername_ = (username) => username === 'admin' ? { user_id: 'OTHER-USER' } : null;
assert.strictEqual(
  sandbox.availableAdminRecoveryUsername_('owner@example.test', 'USER-ADMIN'),
  'admin.owner',
  'recovery must choose a unique fallback when username admin is already used'
);

activeEmail = 'other@example.test';
assert.throws(
  () => sandbox.resetAdminPassword(),
  (error) => error.code === 'ADMIN_PASSWORD_RESET_DENIED'
);
assert.strictEqual(preparedCalls.length, 2, 'unauthorized caller must not prepare another reset');

assert(source.includes('applyCredentialUpdate_(adminUser.user_id, prepared)'),
  'recovery must use the normal credential update path so existing sessions are revoked');
assert(!source.includes('password_hash: PASSWORD_POLICY.DEFAULT_INITIAL_PASSWORD'),
  'temporary password must never be stored as plaintext');

console.log('Installer-admin password recovery checks passed.');
