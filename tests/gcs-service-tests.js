'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'GcsService.gs'), 'utf8');
const properties = {
  GCS_BUCKET_NAME: 'purbalingga-usg-data',
  GCS_OBJECT_PREFIX: 'bpjs-usg',
  GCS_SERVICE_ACCOUNT_KEY: JSON.stringify({
    type: 'service_account',
    client_email: 'uploader@example.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n'
  })
};
const updates = [];
const requests = [];
const pdfBytes = Buffer.from('%PDF-test');
const md5Hash = crypto.createHash('md5').update(pdfBytes).digest('base64');
const objectName = 'bpjs-usg/klaim/pdf/KLAIM_F1AbCdEfGhIjKlMnOpQrSt-__v001.pdf';

function response(code, payload) {
  return {
    getResponseCode: () => code,
    getContentText: () => JSON.stringify(payload || {})
  };
}

const sandbox = {
  console,
  SCRIPT_PROPERTY_KEYS: {
    GCS_BUCKET_NAME: 'GCS_BUCKET_NAME',
    GCS_OBJECT_PREFIX: 'GCS_OBJECT_PREFIX',
    GCS_SERVICE_ACCOUNT_KEY: 'GCS_SERVICE_ACCOUNT_KEY',
    ADMIN_EMAIL: 'ADMIN_EMAIL'
  },
  MimeType: { PDF: 'application/pdf' },
  CacheService: { getScriptCache: () => ({}) },
  LockService: { getScriptLock: () => ({}) },
  OAuth2: {
    createService: () => {
      const service = {
        setTokenUrl: () => service,
        setPrivateKey: () => service,
        setIssuer: () => service,
        setPropertyStore: () => service,
        setCache: () => service,
        setLock: () => service,
        setScope: () => service,
        hasAccess: () => true,
        getAccessToken: () => 'test-token'
      };
      return service;
    }
  },
  UrlFetchApp: {
    fetch: (url, options) => {
      requests.push({ url, options });
      return response(200, {
        bucket: 'purbalingga-usg-data',
        name: objectName,
        generation: '123',
        size: String(pdfBytes.length),
        md5Hash
      });
    }
  },
  Utilities: {
    DigestAlgorithm: { MD5: 'MD5' },
    computeDigest: (_algorithm, bytes) => Array.from(crypto.createHash('md5').update(Buffer.from(bytes)).digest()),
    base64Encode: (bytes) => Buffer.from(bytes).toString('base64'),
    getUuid: () => 'uuid-test',
    newBlob: (content, contentType, name) => ({
      getBytes: () => Array.from(Buffer.from(content)),
      getContentType: () => contentType,
      getName: () => name
    })
  },
  PropertiesService: { getScriptProperties: () => ({}) },
  Session: { getActiveUser: () => ({ getEmail: () => 'admin@example.test' }) },
  normalizeString_: (value) => String(value || '').trim(),
  normalizeEmail_: (value) => String(value || '').trim().toLowerCase(),
  validateEmail_: (value) => /@/.test(String(value || '')),
  sanitizePlainText_: (value, maximum) => String(value || '').slice(0, maximum),
  getBooleanSetting_: () => true,
  getScriptProperties_: () => ({ getProperty: (key) => properties[key] || '' }),
  getRequiredProperty_: (key) => {
    const value = properties[key];
    if (!value) throw new Error(`missing ${key}`);
    return value;
  },
  assert_: (condition, code, message) => {
    if (!condition) {
      const error = new Error(message);
      error.code = code;
      throw error;
    }
  },
  appError_: (code, message) => {
    const error = new Error(message);
    error.code = code;
    return error;
  },
  withScriptLock_: (callback) => callback(),
  findRecord_: () => ({ _rowNumber: 7 }),
  updateRecord_: (_sheet, row, changes) => updates.push({ row, changes }),
  now_: () => '2026-10-20T00:00:00.000Z'
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'GcsService.gs' });

const claim = {
  claim_id: 'CLAIM-1',
  final_pdf_filename: 'KLAIM_PUSKESMAS_20261020_v001.pdf',
  final_pdf_storage_filename: 'KLAIM_F1AbCdEfGhIjKlMnOpQrSt-__v001.pdf'
};
const sourceFile = {
  isTrashed: () => false,
  getBlob: () => ({
    getBytes: () => Array.from(pdfBytes),
    getContentType: () => 'application/pdf',
    setContentType() { return this; }
  })
};

assert.strictEqual(sandbox.gcsClaimPdfObjectName_(claim), objectName);
assert.ok(!objectName.includes('PUSKESMAS'));
const result = sandbox.deliverClaimPdfToGcsSafely_(claim, sourceFile);
assert.strictEqual(result.status, 'READY');
assert.strictEqual(requests.length, 1);
assert.match(requests[0].url, /ifGenerationMatch=0/);
assert.strictEqual(requests[0].options.headers.Authorization, 'Bearer test-token');
assert.strictEqual(updates.length, 1);
assert.strictEqual(updates[0].changes.gcs_pdf_bucket, 'purbalingga-usg-data');
assert.strictEqual(updates[0].changes.gcs_pdf_object, objectName);
assert.strictEqual(updates[0].changes.gcs_pdf_status, 'READY');

const pdfServiceSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'PdfService.gs'), 'utf8');
const generateStart = pdfServiceSource.indexOf('function generateClaimPdf');
const completeStart = pdfServiceSource.indexOf('function completeClaim');
const reopenStart = pdfServiceSource.indexOf('function reopenClaim');
const gcsDeliveryCall = pdfServiceSource.indexOf('gcsResult = deliverClaimPdfToGcsSafely_', completeStart);
assert.ok(generateStart >= 0, 'generateClaimPdf must exist');
assert.ok(completeStart > generateStart && gcsDeliveryCall > completeStart && gcsDeliveryCall < reopenStart,
  'GCS PDF delivery must run during completeClaim, not during Buat PDF');
assert.strictEqual(pdfServiceSource.slice(generateStart, completeStart).includes('deliverClaimPdfToGcsSafely_'), false,
  'Buat PDF must not upload to GCS before the claim is completed');
assert.ok(pdfServiceSource.indexOf("gcs_pdf_status: gcsPdfDeliveryEnabled_() ? 'WAITING_COMPLETION' : 'DISABLED'", generateStart) < completeStart,
  'each new PDF version must wait for claim completion before GCS delivery');

console.log('GCS PDF completion delivery and anonymous object naming checks passed.');
