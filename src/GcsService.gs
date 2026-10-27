var GCS_OAUTH_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_write';

function gcsPdfDeliveryEnabled_() {
  return getBooleanSetting_('ENABLE_GCS_PDF_DELIVERY', false);
}

function gcsBucketName_() {
  var bucket = normalizeString_(getRequiredProperty_(SCRIPT_PROPERTY_KEYS.GCS_BUCKET_NAME));
  assert_(/^(?=.{3,222}$)[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(bucket),
    'GCS_BUCKET_INVALID', 'Nama bucket GCS tidak valid. Gunakan nama tanpa gs://.');
  return bucket;
}

function gcsObjectPrefix_() {
  var prefix = normalizeString_(getScriptProperties_().getProperty(SCRIPT_PROPERTY_KEYS.GCS_OBJECT_PREFIX)) || 'bpjs-usg';
  prefix = prefix.replace(/^\/+|\/+$/g, '');
  assert_(prefix && prefix.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(prefix),
    'GCS_PREFIX_INVALID', 'Prefix objek GCS tidak valid.');
  assert_(!prefix.split('/').some(function (segment) { return !segment || segment === '.' || segment === '..'; }),
    'GCS_PREFIX_INVALID', 'Prefix objek GCS mengandung segmen path yang tidak valid.');
  return prefix;
}

function gcsServiceAccountKey_() {
  var raw = getRequiredProperty_(SCRIPT_PROPERTY_KEYS.GCS_SERVICE_ACCOUNT_KEY);
  var key;
  try {
    key = JSON.parse(raw);
  } catch (error) {
    throw appError_('GCS_CREDENTIAL_INVALID', 'JSON service account GCS pada Script Properties tidak valid.');
  }
  assert_(key && key.type === 'service_account' && validateEmail_(key.client_email) &&
    /^-----BEGIN PRIVATE KEY-----/.test(normalizeString_(key.private_key)),
    'GCS_CREDENTIAL_INVALID', 'Service account GCS tidak lengkap atau tidak valid.');
  return key;
}

function getGcsOAuthService_() {
  var key = gcsServiceAccountKey_();
  return OAuth2.createService('BPJS_USG_GCS_SERVICE_ACCOUNT')
    .setTokenUrl('https://oauth2.googleapis.com/token')
    .setPrivateKey(key.private_key)
    .setIssuer(key.client_email)
    .setPropertyStore(getScriptProperties_())
    .setCache(CacheService.getScriptCache())
    .setLock(LockService.getScriptLock())
    .setScope(GCS_OAUTH_SCOPE);
}

function gcsAccessToken_() {
  var service = getGcsOAuthService_();
  assert_(service.hasAccess(), 'GCS_AUTH_FAILED',
    'Service account GCS tidak dapat memperoleh token akses. Periksa credential dan IAM bucket.');
  return service.getAccessToken();
}

function gcsApiError_(code, response) {
  var detail = '';
  try {
    var payload = JSON.parse(response.getContentText() || '{}');
    detail = sanitizePlainText_(payload && payload.error && payload.error.message, 180);
  } catch (ignored) {
    detail = '';
  }
  return appError_('GCS_REQUEST_FAILED', 'Google Cloud Storage menolak permintaan (HTTP ' + code + ')' +
    (detail ? ': ' + detail : '.') );
}

function gcsObjectMetadata_(bucket, objectName, accessToken) {
  var url = 'https://storage.googleapis.com/storage/v1/b/' + encodeURIComponent(bucket) + '/o/' +
    encodeURIComponent(objectName) + '?fields=bucket,name,generation,size,md5Hash';
  var response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + accessToken },
    muteHttpExceptions: true
  });
  var code = response.getResponseCode();
  if (code !== 200) throw gcsApiError_(code, response);
  return JSON.parse(response.getContentText() || '{}');
}

function uploadBlobToGcs_(objectName, blob) {
  var bucket = gcsBucketName_();
  var accessToken = gcsAccessToken_();
  var bytes = blob.getBytes();
  var md5Hash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes));
  var url = 'https://storage.googleapis.com/upload/storage/v1/b/' + encodeURIComponent(bucket) +
    '/o?uploadType=media&ifGenerationMatch=0&name=' + encodeURIComponent(objectName);
  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: blob.getContentType() || 'application/octet-stream',
    headers: { Authorization: 'Bearer ' + accessToken },
    payload: bytes,
    muteHttpExceptions: true
  });
  var code = response.getResponseCode();
  var metadata;
  var duplicate = false;
  if (code === 200 || code === 201) {
    metadata = JSON.parse(response.getContentText() || '{}');
  } else if (code === 412) {
    metadata = gcsObjectMetadata_(bucket, objectName, accessToken);
    duplicate = true;
  } else {
    throw gcsApiError_(code, response);
  }
  assert_(metadata.bucket === bucket && metadata.name === objectName,
    'GCS_RESPONSE_INVALID', 'GCS mengembalikan identitas objek yang tidak sesuai.');
  assert_(Number(metadata.size) === bytes.length && normalizeString_(metadata.md5Hash) === md5Hash,
    'GCS_OBJECT_COLLISION', 'Objek GCS sudah ada tetapi isi atau ukurannya berbeda.');
  return {
    bucket: bucket,
    objectName: objectName,
    generation: normalizeString_(metadata.generation),
    duplicate: duplicate,
    size: bytes.length
  };
}

function deleteGcsObject_(bucket, objectName, generation) {
  var url = 'https://storage.googleapis.com/storage/v1/b/' + encodeURIComponent(bucket) + '/o/' +
    encodeURIComponent(objectName) + '?generation=' + encodeURIComponent(generation);
  var response = UrlFetchApp.fetch(url, {
    method: 'delete',
    headers: { Authorization: 'Bearer ' + gcsAccessToken_() },
    muteHttpExceptions: true
  });
  var code = response.getResponseCode();
  if (code !== 204) throw gcsApiError_(code, response);
}

function gcsClaimPdfObjectName_(claim) {
  var filename = normalizeString_(claim.final_pdf_storage_filename);
  assert_(/^KLAIM_F1[A-Za-z0-9_-]{22}_v\d{3}\.pdf$/.test(filename), 'GCS_PDF_FILENAME_INVALID',
    'Nama penyimpanan PDF anonim tidak valid.');
  return gcsObjectPrefix_() + '/klaim/pdf/' + filename;
}

function gcsDeliveryErrorMessage_(error) {
  return sanitizePlainText_(error && error.message ? error.message :
    'Pengiriman PDF ke GCS gagal tanpa pesan.', 300);
}

function recordGcsDeliveryErrorSafely_(claimId, message) {
  try {
    withScriptLock_(function () {
      var current = findRecord_('CLAIMS', 'claim_id', claimId);
      if (current) updateRecord_('CLAIMS', current._rowNumber, {
        gcs_pdf_status: 'ERROR', gcs_pdf_error: message
      });
    });
  } catch (ignored) {
    // GCS is an independent delivery target; metadata failure must not remove the primary PDF.
  }
}

function deliverClaimPdfToGcsSafely_(claim, sourceFile) {
  if (!gcsPdfDeliveryEnabled_()) return { status: 'DISABLED', filename: '' };
  var objectName = '';
  try {
    assert_(sourceFile && !sourceFile.isTrashed(), 'GCS_PDF_SOURCE_MISSING',
      'PDF utama tidak tersedia untuk dikirim ke GCS.');
    objectName = gcsClaimPdfObjectName_(claim);
    var uploaded = uploadBlobToGcs_(objectName, sourceFile.getBlob().setContentType(MimeType.PDF));
    withScriptLock_(function () {
      var current = findRecord_('CLAIMS', 'claim_id', claim.claim_id);
      assert_(current, 'CLAIM_NOT_FOUND', 'Klaim tidak ditemukan saat menyimpan status GCS.');
      updateRecord_('CLAIMS', current._rowNumber, {
        gcs_pdf_bucket: uploaded.bucket,
        gcs_pdf_object: uploaded.objectName,
        gcs_pdf_generation: uploaded.generation,
        gcs_pdf_at: now_(),
        gcs_pdf_status: 'READY',
        gcs_pdf_error: ''
      });
    });
    return { status: 'READY', filename: normalizeString_(claim.final_pdf_filename), duplicate: uploaded.duplicate };
  } catch (error) {
    var message = gcsDeliveryErrorMessage_(error);
    recordGcsDeliveryErrorSafely_(claim.claim_id, message);
    return { status: 'ERROR', filename: normalizeString_(claim.final_pdf_filename), message: message };
  }
}

function validateGcsConfiguration() {
  var activeUser = normalizeEmail_(Session.getActiveUser().getEmail());
  var adminEmail = normalizeEmail_(getRequiredProperty_(SCRIPT_PROPERTY_KEYS.ADMIN_EMAIL));
  assert_(activeUser && activeUser === adminEmail, 'GCS_CONFIGURATION_DENIED',
    'Konfigurasi GCS hanya boleh divalidasi oleh administrator pemasang.');
  var objectName = gcsObjectPrefix_() + '/.validation/' + Utilities.getUuid() + '.txt';
  var probe = uploadBlobToGcs_(objectName,
    Utilities.newBlob('Validasi akses tulis aplikasi BPJS USG.', 'text/plain', 'VALIDASI_AKSES.txt'));
  deleteGcsObject_(probe.bucket, probe.objectName, probe.generation);
  var setting = findRecord_('SETTINGS', 'setting_key', 'ENABLE_GCS_PDF_DELIVERY');
  assert_(setting, 'GCS_SETTING_MISSING', 'Jalankan setupApplication() terlebih dahulu.');
  updateRecord_('SETTINGS', setting._rowNumber, {
    setting_value: 'true', updated_at: now_(), updated_by: activeUser
  });
  return { success: true, bucket: probe.bucket, prefix: gcsObjectPrefix_(), enabled: true };
}

function retryFailedGcsPdfDeliveries() {
  var activeUser = normalizeEmail_(Session.getActiveUser().getEmail());
  var adminEmail = normalizeEmail_(getRequiredProperty_(SCRIPT_PROPERTY_KEYS.ADMIN_EMAIL));
  assert_(activeUser && activeUser === adminEmail, 'GCS_RETRY_DENIED',
    'Pengiriman ulang PDF GCS hanya boleh dijalankan oleh administrator pemasang.');
  assert_(gcsPdfDeliveryEnabled_(), 'GCS_DELIVERY_DISABLED', 'Pengiriman PDF GCS belum diaktifkan.');
  var result = { success: true, checked: 0, ready: 0, errors: 0, hasMore: false };
  var claims = readAllRecords_('CLAIMS').filter(function (claim) {
    return normalizeString_(claim.status).toUpperCase() === CLAIM_STATUSES.COMPLETED &&
      normalizeString_(claim.final_pdf_file_id) && normalizeString_(claim.gcs_pdf_status).toUpperCase() !== 'READY';
  });
  claims.slice(0, 100).forEach(function (claim) {
    result.checked += 1;
    try {
      var delivery = deliverClaimPdfToGcsSafely_(claim, finalPdfFile_(claim));
      if (delivery.status === 'READY') result.ready += 1;
      else result.errors += 1;
    } catch (error) {
      result.errors += 1;
      recordGcsDeliveryErrorSafely_(claim.claim_id, gcsDeliveryErrorMessage_(error));
    }
  });
  result.hasMore = claims.length > 100;
  return result;
}
