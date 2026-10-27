const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'WhatsAppService.gs'), 'utf8');
const cacheValues = new Map();
const sandbox = {
  Object,
  Array,
  JSON,
  Math,
  String,
  normalizeString_: (value) => String(value == null ? '' : value).trim(),
  assert_(condition, code, message) {
    if (!condition) {
      const error = new Error(message);
      error.code = code;
      throw error;
    }
  },
  CacheService: {
    getScriptCache: () => ({
      put: (key, value) => cacheValues.set(key, value),
      get: (key) => cacheValues.get(key) || null
    })
  },
  Utilities: {
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    computeDigest(_algorithm, value) {
      return Array.from(crypto.createHash('sha256').update(value, 'utf8').digest(),
        (byte) => byte > 127 ? byte - 256 : byte);
    }
  },
  gcsObjectPrefix_: () => 'bpjs-usg'
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'WhatsAppService.gs' });

const studyKey = '0123456789abcdef0123456789abcdef';
const expectedReference = 'WA_' + crypto.createHash('sha256').update(studyKey, 'utf8').digest('hex').slice(0, 40);
assert.strictEqual(sandbox.whatsappDeliveryReferenceId_(studyKey), expectedReference);
assert.strictEqual(sandbox.whatsappImageObjectKey_('A'.repeat(64)), 'a'.repeat(64));
const legacyObjectKey = 'dummy-whatsapp-jpeg-001';
const secondObjectKey = 'dummy-whatsapp-jpeg-002';
assert.strictEqual(sandbox.whatsappImageObjectKey_(legacyObjectKey), legacyObjectKey);
assert.ok(sandbox.whatsappImageCacheKey_(studyKey, legacyObjectKey).startsWith('WA_IMG_'));
assert.throws(
  () => sandbox.whatsappImageObjectKey_('folder/image.jpg'),
  (error) => error.code === 'WHATSAPP_IMAGE_INVALID'
);
assert.throws(
  () => sandbox.whatsappImageObjectKey_('x'.repeat(257)),
  (error) => error.code === 'WHATSAPP_IMAGE_INVALID'
);
assert.strictEqual(sandbox.whatsappDeliveryState_('', ''), 'NOT_SENT');
assert.strictEqual(sandbox.whatsappDeliveryState_('QUEUED', ''), 'PENDING');
assert.strictEqual(sandbox.whatsappDeliveryState_('FAILED', ''), 'FAILED');
assert.strictEqual(sandbox.whatsappDeliveryState_('PROCESSING', '2026-10-24T00:00:00Z'), 'SENT');
assert.strictEqual(sandbox.whatsappStudyDeliveryState_({ image_count: 3, sent_object_keys: [legacyObjectKey] }), 'PARTIAL');
assert.strictEqual(sandbox.whatsappStudyDeliveryState_({ image_count: 1, sent_object_keys: [legacyObjectKey] }), 'SENT');
assert.strictEqual(sandbox.whatsappStudyDeliveryState_({ image_count: 3, sent_object_keys: [], active_pending_count: 1 }), 'PENDING');
assert.strictEqual(sandbox.maskWhatsappPhone_('6281219767438'), '6281******438');

const validObject = `bpjs-usg/orthanc/studies/${studyKey}/jpg/0001_000_deadbeef.jpg`;
assert.strictEqual(sandbox.whatsappGcsObjectName_(studyKey, validObject), validObject);
const mappedDummyObject = 'bpjs-usg/orthanc/studies/59d1782ecc3e01de5cc7a37545f473dc/jpg/0001.jpg';
assert.strictEqual(sandbox.whatsappGcsObjectName_(studyKey, mappedDummyObject), mappedDummyObject);
assert.throws(
  () => sandbox.whatsappGcsObjectName_(studyKey, `bpjs-usg/orthanc/studies/other/dicom/0001.jpg`),
  (error) => error.code === 'WHATSAPP_IMAGE_INVALID'
);

const selectionStudy = {
  study_key: studyKey,
  delivery_state: 'NOT_SENT',
  sent_object_keys: [],
  pending_object_keys: [],
  images: [
    { object_key: legacyObjectKey, sequence_number: 1, frame_index: 0 },
    { object_key: secondObjectKey, sequence_number: 2, frame_index: 0 }
  ]
};
const selectedImages = sandbox.whatsappSelectedImages_(selectionStudy, [secondObjectKey]);
assert.strictEqual(selectedImages.length, 1);
assert.strictEqual(selectedImages[0].object_key, secondObjectKey);
assert.strictEqual(
  sandbox.whatsappSelectedDeliveryReferenceId_(studyKey, [legacyObjectKey, secondObjectKey]),
  sandbox.whatsappSelectedDeliveryReferenceId_(studyKey, [secondObjectKey, legacyObjectKey]),
  'selection reference must not depend on checkbox order'
);
assert.throws(
  () => sandbox.whatsappSelectedImages_(selectionStudy, []),
  (error) => error.code === 'WHATSAPP_IMAGE_SELECTION_REQUIRED'
);
assert.throws(
  () => sandbox.whatsappSelectedImages_(selectionStudy, [legacyObjectKey, legacyObjectKey]),
  (error) => error.code === 'WHATSAPP_IMAGE_SELECTION_DUPLICATE'
);
assert.throws(
  () => sandbox.whatsappSelectedImages_({ ...selectionStudy, sent_object_keys: [legacyObjectKey] }, [legacyObjectKey]),
  (error) => error.code === 'WHATSAPP_IMAGE_ALREADY_SENT'
);

const clientStudy = sandbox.whatsappStudyForClient_({
  study_key: studyKey,
  patient_name: 'Pasien Uji',
  request_token: 'internal-only',
  delivery_reference_id: expectedReference,
  images: [{ object_key: legacyObjectKey, object_name: validObject, sequence_number: 1, frame_index: 0 }]
});
assert.strictEqual(clientStudy.request_token, undefined);
assert.strictEqual(clientStudy.delivery_reference_id, undefined);
assert.strictEqual(clientStudy.images[0].object_name, undefined);
assert.strictEqual(clientStudy.images[0].object_key, legacyObjectKey);
assert.throws(
  () => sandbox.whatsappGcsObjectName_(studyKey, `bpjs-usg/orthanc/studies/${studyKey}/jpg/../secret.jpg`),
  (error) => error.code === 'WHATSAPP_IMAGE_INVALID'
);

sandbox.whatsappBigQueryConfig_ = () => ({ projectId: 'test-project', dataset: 'dicom_usg', location: 'asia-southeast2' });
const sql = sandbox.whatsappStudiesSql_();
assert.ok(sql.includes('s.bridge_id = @bridge_id'), 'list query must be restricted to the configured bridge');
assert.ok(sql.includes('whatsapp_deliveries'), 'list query must use delivery status, not infer it from source readiness');
assert.ok(sql.includes('selected_object_keys'), 'list query must aggregate per-image delivery status');
assert.ok(source.includes("requirePermission('can_send_whatsapp', sessionToken)"), 'server endpoints must enforce WhatsApp permission');
assert.ok(source.includes("request_source: 'WEB_APP_MANUAL'"), 'manual webhook request source is missing');
assert.ok(source.includes('selected_object_keys: selectedImages.map'), 'manual webhook must send only the selected image references');
assert.ok(source.includes('ON target.delivery_reference_id = source.delivery_reference_id'), 'outbox must be keyed per selected delivery batch');
assert.ok(!source.includes('setSharing('), 'WhatsApp service must not publish GCS images');

console.log('WhatsApp delivery reference, status, authorization, and private image boundary checks passed.');
