var WHATSAPP_BIGQUERY_SCOPE = 'https://www.googleapis.com/auth/bigquery https://www.googleapis.com/auth/devstorage.read_only';
var WHATSAPP_MAX_STUDIES = 25;
var WHATSAPP_MAX_IMAGES_PER_STUDY = 6;
var WHATSAPP_MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

function whatsappDeliveryEnabled_() {
  return getBooleanSetting_('ENABLE_WHATSAPP_DELIVERY', false);
}

function whatsappBigQueryConfig_() {
  var properties = getScriptProperties_();
  var key = gcsServiceAccountKey_();
  var projectId = normalizeString_(properties.getProperty(SCRIPT_PROPERTY_KEYS.BIGQUERY_PROJECT_ID)) ||
    normalizeString_(key.project_id);
  var dataset = normalizeString_(properties.getProperty(SCRIPT_PROPERTY_KEYS.BIGQUERY_DATASET)) || 'dicom_usg';
  var location = normalizeString_(properties.getProperty(SCRIPT_PROPERTY_KEYS.BIGQUERY_LOCATION)) || 'asia-southeast2';
  assert_(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId),
    'WHATSAPP_BIGQUERY_PROJECT_INVALID', 'BIGQUERY_PROJECT_ID tidak valid.');
  assert_(/^[A-Za-z_][A-Za-z0-9_]{0,1023}$/.test(dataset),
    'WHATSAPP_BIGQUERY_DATASET_INVALID', 'BIGQUERY_DATASET tidak valid.');
  assert_(/^[A-Za-z0-9-]{2,32}$/.test(location),
    'WHATSAPP_BIGQUERY_LOCATION_INVALID', 'BIGQUERY_LOCATION tidak valid.');
  return { projectId: projectId, dataset: dataset, location: location };
}

function whatsappWebhookConfig_() {
  var properties = getScriptProperties_();
  var url = normalizeString_(getRequiredProperty_(SCRIPT_PROPERTY_KEYS.WHATSAPP_WEBHOOK_URL));
  var apiKey = normalizeString_(getRequiredProperty_(SCRIPT_PROPERTY_KEYS.WHATSAPP_WEBHOOK_API_KEY));
  assert_(/^https:\/\/n8n\.id\.spheres\.oucru-id\.org\/webhook\/[A-Za-z0-9._~!$&'()*+,;=:@%\/-]+$/.test(url) &&
    url.indexOf('/webhook-test/') < 0,
    'WHATSAPP_WEBHOOK_URL_INVALID', 'WHATSAPP_WEBHOOK_URL harus memakai production webhook HTTPS n8n yang disetujui.');
  assert_(apiKey.length >= 16 && !/GANTI|CHANGE|PLACEHOLDER/i.test(apiKey),
    'WHATSAPP_WEBHOOK_KEY_INVALID', 'WHATSAPP_WEBHOOK_API_KEY belum diisi dengan nilai yang valid.');
  return { url: url, apiKey: apiKey };
}

function getWhatsAppOAuthService_() {
  var key = gcsServiceAccountKey_();
  return OAuth2.createService('BPJS_USG_WHATSAPP_SERVICE_ACCOUNT')
    .setTokenUrl('https://oauth2.googleapis.com/token')
    .setPrivateKey(key.private_key)
    .setIssuer(key.client_email)
    .setPropertyStore(getScriptProperties_())
    .setCache(CacheService.getScriptCache())
    .setLock(LockService.getScriptLock())
    .setScope(WHATSAPP_BIGQUERY_SCOPE);
}

function whatsappAccessToken_() {
  var service = getWhatsAppOAuthService_();
  assert_(service.hasAccess(), 'WHATSAPP_AUTH_FAILED',
    'Service account tidak dapat mengakses BigQuery/GCS. Periksa credential dan IAM.');
  return service.getAccessToken();
}

function whatsappApiError_(code, response, fallbackMessage) {
  var detail = '';
  try {
    var payload = JSON.parse(response.getContentText() || '{}');
    detail = sanitizePlainText_(payload && payload.error && payload.error.message, 180);
  } catch (ignored) {
    detail = '';
  }
  return appError_(code, fallbackMessage + (detail ? ': ' + detail : '.'));
}

function whatsappBigQueryParameter_(name, value, type) {
  return {
    name: name,
    parameterType: { type: type || 'STRING' },
    parameterValue: { value: value === null || value === undefined ? '' : String(value) }
  };
}

function whatsappBigQueryStringArrayParameter_(name, values) {
  return {
    name: name,
    parameterType: { type: 'ARRAY', arrayType: { type: 'STRING' } },
    parameterValue: {
      arrayValues: (values || []).map(function (value) { return { value: String(value) }; })
    }
  };
}

function whatsappBigQueryQuery_(sql, parameters) {
  var config = whatsappBigQueryConfig_();
  var baseUrl = 'https://bigquery.googleapis.com/bigquery/v2/projects/' + encodeURIComponent(config.projectId);
  var response = UrlFetchApp.fetch(baseUrl + '/queries', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + whatsappAccessToken_() },
    payload: JSON.stringify({
      query: sql,
      useLegacySql: false,
      parameterMode: 'NAMED',
      queryParameters: parameters || [],
      location: config.location,
      timeoutMs: 20000,
      maxResults: 1000
    }),
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) {
    throw whatsappApiError_('WHATSAPP_BIGQUERY_FAILED', response, 'BigQuery menolak permintaan WhatsApp');
  }
  var result = JSON.parse(response.getContentText() || '{}');
  if (result.errors && result.errors.length) {
    throw appError_('WHATSAPP_BIGQUERY_FAILED', 'Query data WhatsApp gagal dijalankan.');
  }
  var jobId = result.jobReference && result.jobReference.jobId;
  var attempts = 0;
  while (!result.jobComplete && jobId && attempts < 8) {
    Utilities.sleep(250);
    response = UrlFetchApp.fetch(baseUrl + '/queries/' + encodeURIComponent(jobId) +
      '?location=' + encodeURIComponent(config.location) + '&maxResults=1000', {
      method: 'get',
      headers: { Authorization: 'Bearer ' + whatsappAccessToken_() },
      muteHttpExceptions: true
    });
    if (response.getResponseCode() !== 200) {
      throw whatsappApiError_('WHATSAPP_BIGQUERY_FAILED', response, 'Hasil query WhatsApp tidak dapat dibaca');
    }
    result = JSON.parse(response.getContentText() || '{}');
    attempts += 1;
  }
  assert_(result.jobComplete !== false, 'WHATSAPP_BIGQUERY_TIMEOUT',
    'BigQuery belum menyelesaikan permintaan. Silakan coba lagi.');
  return result;
}

function whatsappBigQueryJsonRows_(sql, parameters) {
  var result = whatsappBigQueryQuery_(sql, parameters);
  return (result.rows || []).map(function (row) {
    var raw = row && row.f && row.f[0] ? row.f[0].v : '{}';
    return JSON.parse(raw || '{}');
  });
}

function whatsappStudyKey_(value) {
  var studyKey = normalizeString_(value);
  assert_(/^[A-Za-z0-9._-]{3,128}$/.test(studyKey),
    'WHATSAPP_STUDY_INVALID', 'Referensi pemeriksaan WhatsApp tidak valid.');
  return studyKey;
}

function whatsappSha256Hex_(value) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    String(value), Utilities.Charset.UTF_8);
  return bytes.map(function (value) {
    return ('0' + ((value + 256) % 256).toString(16)).slice(-2);
  }).join('');
}

function whatsappDeliveryReferenceId_(studyKey) {
  return 'WA_' + whatsappSha256Hex_(whatsappStudyKey_(studyKey)).substring(0, 40);
}

function whatsappSelectedDeliveryReferenceId_(studyKey, objectKeys) {
  var normalized = (objectKeys || []).map(whatsappImageObjectKey_).sort();
  assert_(normalized.length > 0 && normalized.length <= WHATSAPP_MAX_IMAGES_PER_STUDY,
    'WHATSAPP_IMAGE_SELECTION_REQUIRED', 'Pilih sedikitnya satu foto USG yang akan dikirim.');
  return 'WA_' + whatsappSha256Hex_(whatsappStudyKey_(studyKey) + '|' + normalized.join('|')).substring(0, 40);
}

function whatsappImageObjectKey_(value) {
  var objectKey = normalizeString_(value);
  // Bridge terbaru memakai SHA-256 (64 hex), sedangkan data registry lama/dummy
  // dapat memakai identifier stabil yang lebih pendek. Object key bukan path GCS;
  // path tetap divalidasi terpisah oleh whatsappGcsObjectName_.
  assert_(/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(objectKey),
    'WHATSAPP_IMAGE_INVALID', 'Referensi gambar USG tidak valid.');
  return /^[a-f0-9]{64}$/i.test(objectKey) ? objectKey.toLowerCase() : objectKey;
}

function whatsappImageCacheKey_(studyKey, objectKey) {
  var reference = whatsappStudyKey_(studyKey) + '.' + whatsappImageObjectKey_(objectKey);
  return 'WA_IMG_' + whatsappSha256Hex_(reference).substring(0, 40);
}

function whatsappDeliveryState_(status, sentAt) {
  var normalized = normalizeString_(status).toUpperCase();
  if (sentAt || ['SENT', 'DELIVERED', 'READ'].indexOf(normalized) >= 0) return 'SENT';
  if (['FAILED', 'REJECTED', 'CANCELLED'].indexOf(normalized) >= 0) return 'FAILED';
  if (!normalized) return 'NOT_SENT';
  return 'PENDING';
}

function whatsappStudyDeliveryState_(row) {
  var sentCount = (row.sent_object_keys || []).length;
  var activePendingCount = Number(row.active_pending_count || 0);
  if (activePendingCount > 0) return 'PENDING';
  if (row.image_count > 0 && sentCount >= row.image_count) return 'SENT';
  if (whatsappDeliveryState_(row.delivery_status, row.sent_at) === 'FAILED') return 'FAILED';
  if (sentCount > 0) return 'PARTIAL';
  return 'NOT_SENT';
}

function whatsappStudiesSql_() {
  var config = whatsappBigQueryConfig_();
  var prefix = '`' + config.projectId + '.' + config.dataset + '.';
  return [
    'WITH files AS (',
    '  SELECT study_key, COUNT(*) AS image_count,',
    '    ARRAY_AGG(STRUCT(object_key, object_name, sequence_number, frame_index)',
    '      ORDER BY sequence_number, frame_index LIMIT ' + WHATSAPP_MAX_IMAGES_PER_STUDY + ') AS images',
    '  FROM ' + prefix + 'study_files`',
    "  WHERE UPPER(file_type) = 'JPEG' AND content_type = 'image/jpeg'",
    '  GROUP BY study_key',
    '), deliveries AS (',
    '  SELECT * FROM ' + prefix + 'whatsapp_deliveries`',
    '), latest_delivery AS (',
    '  SELECT * FROM deliveries',
    '  QUALIFY ROW_NUMBER() OVER (PARTITION BY study_key',
    '    ORDER BY COALESCE(updated_at, requested_at) DESC, requested_at DESC, delivery_reference_id DESC) = 1',
    '), delivery_keys AS (',
    '  SELECT d.study_key, d.status, d.sent_at, d.updated_at, object_key',
    '  FROM deliveries d',
    '  LEFT JOIN UNNEST(IFNULL(d.selected_object_keys, ARRAY<STRING>[])) object_key ON TRUE',
    '), delivery_rollup AS (',
    '  SELECT base.study_key,',
    '    ARRAY(SELECT DISTINCT object_key FROM delivery_keys k',
    '      WHERE k.study_key=base.study_key AND object_key IS NOT NULL',
    "        AND (k.sent_at IS NOT NULL OR UPPER(COALESCE(k.status, '')) IN ('SENT','DELIVERED','READ'))) AS sent_object_keys,",
    '    ARRAY(SELECT DISTINCT object_key FROM delivery_keys k',
    '      WHERE k.study_key=base.study_key AND object_key IS NOT NULL',
    "        AND UPPER(COALESCE(k.status, '')) IN ('REQUESTED','QUEUED','PROCESSING')",
    '        AND k.updated_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 15 MINUTE)) AS pending_object_keys,',
    '    (SELECT COUNT(*) FROM deliveries p WHERE p.study_key=base.study_key',
    "      AND UPPER(COALESCE(p.status, '')) IN ('REQUESTED','QUEUED','PROCESSING')",
    '      AND p.updated_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 15 MINUTE)) AS active_pending_count',
    '  FROM (SELECT DISTINCT study_key FROM deliveries) base',
    '), source AS (',
    '  SELECT s.study_key, s.patient_name, s.patient_nik, s.patient_phone, s.patient_phone_e164,',
    '    s.doctor_name, s.study_date, s.study_datetime_local, s.whatsapp_ready,',
    '    s.whatsapp_block_reasons, s.jpeg_count, f.image_count, f.images,',
    '    d.delivery_reference_id, d.status AS delivery_status, d.requested_at, d.updated_at AS delivery_updated_at,',
    '    d.sent_at, d.delivered_at, d.last_error, d.attempt_count, d.request_token,',
    '    IFNULL(r.sent_object_keys, ARRAY<STRING>[]) AS sent_object_keys,',
    '    IFNULL(r.pending_object_keys, ARRAY<STRING>[]) AS pending_object_keys,',
    '    COALESCE(r.active_pending_count, 0) AS active_pending_count,',
    "    CASE WHEN COALESCE(r.active_pending_count, 0) > 0 THEN 'PENDING'",
    '      WHEN COALESCE(f.image_count, 0) > 0',
    '        AND ARRAY_LENGTH(IFNULL(r.sent_object_keys, ARRAY<STRING>[])) >= f.image_count THEN \'SENT\'',
    "      WHEN UPPER(COALESCE(d.status, '')) IN ('FAILED','REJECTED','CANCELLED') THEN 'FAILED'",
    "      WHEN ARRAY_LENGTH(IFNULL(r.sent_object_keys, ARRAY<STRING>[])) > 0 THEN 'PARTIAL'",
    "      ELSE 'NOT_SENT' END AS delivery_state",
    '  FROM ' + prefix + 'studies` s',
    '  LEFT JOIN files f USING (study_key)',
    '  LEFT JOIN latest_delivery d USING (study_key)',
    '  LEFT JOIN delivery_rollup r USING (study_key)',
    '  WHERE s.bridge_id = @bridge_id',
    '    AND (@study_key = \'\' OR s.study_key = @study_key)',
    '    AND (@search = \'\' OR CONTAINS_SUBSTR(LOWER(COALESCE(s.patient_name, \'\')), LOWER(@search))',
    '      OR CONTAINS_SUBSTR(COALESCE(s.patient_nik, \'\'), @search)',
    '      OR CONTAINS_SUBSTR(COALESCE(s.patient_phone, \'\'), @search)',
    '      OR CONTAINS_SUBSTR(LOWER(COALESCE(s.doctor_name, \'\')), LOWER(@search)))',
    ')',
    'SELECT TO_JSON_STRING(source) AS payload',
    'FROM source',
    'WHERE (@status = \'\' OR delivery_state = @status)',
    'ORDER BY study_date DESC, study_datetime_local DESC, study_key DESC',
    'LIMIT ' + WHATSAPP_MAX_STUDIES
  ].join('\n');
}

function listWhatsAppStudies_(filters) {
  filters = filters || {};
  var search = sanitizePlainText_(filters.search, 80);
  var status = normalizeString_(filters.status).toUpperCase();
  var studyKey = filters.study_key ? whatsappStudyKey_(filters.study_key) : '';
  assert_(['', 'NOT_SENT', 'PENDING', 'PARTIAL', 'SENT', 'FAILED'].indexOf(status) >= 0,
    'WHATSAPP_FILTER_INVALID', 'Filter status WhatsApp tidak valid.');
  var bridgeId = getRequiredProperty_(SCRIPT_PROPERTY_KEYS.ORTHANC_BRIDGE_ID);
  var rows = whatsappBigQueryJsonRows_(whatsappStudiesSql_(), [
    whatsappBigQueryParameter_('bridge_id', bridgeId),
    whatsappBigQueryParameter_('study_key', studyKey),
    whatsappBigQueryParameter_('search', search),
    whatsappBigQueryParameter_('status', status)
  ]);
  return rows.map(function (row) {
    row.images = Array.isArray(row.images) ? row.images : [];
    row.sent_object_keys = Array.isArray(row.sent_object_keys) ? row.sent_object_keys : [];
    row.pending_object_keys = Array.isArray(row.pending_object_keys) ? row.pending_object_keys : [];
    row.whatsapp_block_reasons = Array.isArray(row.whatsapp_block_reasons) ? row.whatsapp_block_reasons : [];
    row.image_count = Number(row.image_count || row.jpeg_count || 0);
    row.attempt_count = Number(row.attempt_count || 0);
    row.active_pending_count = Number(row.active_pending_count || 0);
    row.delivery_state = whatsappStudyDeliveryState_(row);
    return row;
  });
}

function listWhatsAppPatients(sessionToken, filters) {
  try {
    requirePermission('can_send_whatsapp', sessionToken);
    assert_(whatsappDeliveryEnabled_(), 'WHATSAPP_DISABLED', 'Fitur pengiriman WhatsApp belum diaktifkan.');
    var rows = listWhatsAppStudies_(filters || {});
    return success_({
      items: rows.map(whatsappStudyForClient_),
      summary: {
        total: rows.length,
        sent: rows.filter(function (row) { return row.delivery_state === 'SENT'; }).length,
        partial: rows.filter(function (row) { return row.delivery_state === 'PARTIAL'; }).length,
        pending: rows.filter(function (row) { return row.delivery_state === 'PENDING'; }).length,
        not_sent: rows.filter(function (row) { return row.delivery_state === 'NOT_SENT'; }).length,
        failed: rows.filter(function (row) { return row.delivery_state === 'FAILED'; }).length
      }
    });
  } catch (error) {
    return publicError_(error);
  }
}

function whatsappStudyForClient_(row) {
  var item = {};
  Object.keys(row || {}).forEach(function (key) {
    if (['request_token', 'delivery_reference_id', 'images'].indexOf(key) < 0) item[key] = row[key];
  });
  var cache = CacheService.getScriptCache();
  item.images = (row.images || []).map(function (image) {
    var objectKey = whatsappImageObjectKey_(image.object_key);
    cache.put(whatsappImageCacheKey_(row.study_key, objectKey), JSON.stringify({
      study_key: row.study_key,
      object_name: image.object_name
    }), 600);
    return {
      object_key: objectKey,
      sequence_number: image.sequence_number,
      frame_index: image.frame_index
    };
  });
  return item;
}

function whatsappImageReference_(studyKey, objectKey) {
  studyKey = whatsappStudyKey_(studyKey);
  objectKey = whatsappImageObjectKey_(objectKey);
  var cache = CacheService.getScriptCache();
  var cacheKey = whatsappImageCacheKey_(studyKey, objectKey);
  var cached = cache.get(cacheKey);
  if (cached) {
    try {
      var cachedReference = JSON.parse(cached);
      if (cachedReference.study_key === studyKey) return cachedReference;
    } catch (ignored) {
      // Fall back to the authorized BigQuery lookup below.
    }
  }
  var config = whatsappBigQueryConfig_();
  var prefix = '`' + config.projectId + '.' + config.dataset + '.';
  var sql = [
    'SELECT TO_JSON_STRING(STRUCT(f.object_name)) AS payload',
    'FROM ' + prefix + 'study_files` f',
    'JOIN ' + prefix + 'studies` s USING (study_key)',
    'WHERE s.bridge_id=@bridge_id AND f.study_key=@study_key AND f.object_key=@object_key',
    "  AND UPPER(f.file_type)='JPEG' AND f.content_type='image/jpeg'",
    'LIMIT 1'
  ].join('\n');
  var rows = whatsappBigQueryJsonRows_(sql, [
    whatsappBigQueryParameter_('bridge_id', getRequiredProperty_(SCRIPT_PROPERTY_KEYS.ORTHANC_BRIDGE_ID)),
    whatsappBigQueryParameter_('study_key', studyKey),
    whatsappBigQueryParameter_('object_key', objectKey)
  ]);
  assert_(rows.length === 1, 'WHATSAPP_IMAGE_NOT_FOUND', 'Foto USG tidak ditemukan untuk instalasi ini.');
  var reference = { study_key: studyKey, object_name: rows[0].object_name };
  cache.put(cacheKey, JSON.stringify(reference), 600);
  return reference;
}

function whatsappGcsObjectName_(studyKey, objectName) {
  var value = normalizeString_(objectName);
  whatsappStudyKey_(studyKey);
  var expectedPrefix = gcsObjectPrefix_() + '/orthanc/studies/';
  assert_(value.indexOf(expectedPrefix) === 0 && value.length <= 1024 &&
    /^[A-Za-z0-9._\/-]+\/jpg\/[A-Za-z0-9._-]+\.jpg$/i.test(value) && value.indexOf('..') < 0,
    'WHATSAPP_IMAGE_INVALID', 'Referensi gambar USG tidak valid.');
  return value;
}

function getWhatsAppImagePreview(sessionToken, studyKey, objectKey) {
  try {
    requirePermission('can_send_whatsapp', sessionToken);
    assert_(whatsappDeliveryEnabled_(), 'WHATSAPP_DISABLED', 'Fitur pengiriman WhatsApp belum diaktifkan.');
    var bucket = gcsBucketName_();
    var reference = whatsappImageReference_(studyKey, objectKey);
    var safeObjectName = whatsappGcsObjectName_(studyKey, reference.object_name);
    var url = 'https://storage.googleapis.com/storage/v1/b/' + encodeURIComponent(bucket) + '/o/' +
      encodeURIComponent(safeObjectName) + '?alt=media';
    var response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + whatsappAccessToken_() },
      muteHttpExceptions: true
    });
    if (response.getResponseCode() !== 200) {
      throw whatsappApiError_('WHATSAPP_IMAGE_READ_FAILED', response, 'Gambar USG privat tidak dapat dibaca');
    }
    var bytes = response.getBlob().getBytes();
    assert_(bytes.length > 0 && bytes.length <= WHATSAPP_MAX_PREVIEW_BYTES,
      'WHATSAPP_IMAGE_SIZE_INVALID', 'Ukuran gambar USG tidak valid untuk pratinjau.');
    return success_({ mime_type: 'image/jpeg', base64: Utilities.base64Encode(bytes) });
  } catch (error) {
    return publicError_(error);
  }
}

function whatsappSelectedImages_(study, selectedObjectKeys) {
  assert_(Array.isArray(selectedObjectKeys), 'WHATSAPP_IMAGE_SELECTION_REQUIRED',
    'Pilih sedikitnya satu foto USG yang akan dikirim.');
  assert_(selectedObjectKeys.length > 0 && selectedObjectKeys.length <= WHATSAPP_MAX_IMAGES_PER_STUDY,
    'WHATSAPP_IMAGE_SELECTION_REQUIRED', 'Pilih sedikitnya satu foto USG yang akan dikirim.');
  assert_(study.delivery_state !== 'PENDING', 'WHATSAPP_ALREADY_PENDING',
    'Pengiriman WhatsApp untuk pasien ini sedang diproses.');
  var available = Object.create(null);
  (study.images || []).forEach(function (image) {
    available[whatsappImageObjectKey_(image.object_key)] = image;
  });
  var sent = Object.create(null);
  (study.sent_object_keys || []).forEach(function (key) { sent[whatsappImageObjectKey_(key)] = true; });
  var pending = Object.create(null);
  (study.pending_object_keys || []).forEach(function (key) { pending[whatsappImageObjectKey_(key)] = true; });
  var requested = Object.create(null);
  selectedObjectKeys.forEach(function (value) {
    var key = whatsappImageObjectKey_(value);
    assert_(!requested[key], 'WHATSAPP_IMAGE_SELECTION_DUPLICATE', 'Pilihan foto USG berisi duplikasi.');
    assert_(Object.prototype.hasOwnProperty.call(available, key), 'WHATSAPP_IMAGE_NOT_FOUND',
      'Salah satu foto yang dipilih tidak ditemukan untuk pemeriksaan ini.');
    assert_(!sent[key], 'WHATSAPP_IMAGE_ALREADY_SENT', 'Salah satu foto yang dipilih sudah pernah dikirim.');
    assert_(!pending[key], 'WHATSAPP_ALREADY_PENDING', 'Salah satu foto yang dipilih sedang diproses.');
    requested[key] = true;
  });
  return (study.images || []).filter(function (image) {
    return requested[whatsappImageObjectKey_(image.object_key)];
  });
}

function whatsappDeliveryRow_(deliveryReferenceId) {
  var config = whatsappBigQueryConfig_();
  var table = '`' + config.projectId + '.' + config.dataset + '.whatsapp_deliveries`';
  var rows = whatsappBigQueryJsonRows_([
    'SELECT TO_JSON_STRING(STRUCT(delivery_reference_id, study_key, status, sent_at, request_token)) AS payload',
    'FROM ' + table,
    'WHERE delivery_reference_id=@delivery_reference_id',
    'ORDER BY updated_at DESC LIMIT 1'
  ].join('\n'), [whatsappBigQueryParameter_('delivery_reference_id', deliveryReferenceId)]);
  return rows[0] || null;
}

function whatsappAcquireOutbox_(study, selectedImages, user) {
  var config = whatsappBigQueryConfig_();
  var table = '`' + config.projectId + '.' + config.dataset + '.whatsapp_deliveries`';
  var selectedObjectKeys = selectedImages.map(function (image) {
    return whatsappImageObjectKey_(image.object_key);
  });
  var referenceId = whatsappSelectedDeliveryReferenceId_(study.study_key, selectedObjectKeys);
  var requestToken = Utilities.getUuid();
  var sql = [
    'MERGE ' + table + ' target',
    'USING (SELECT @delivery_reference_id AS delivery_reference_id, @study_key AS study_key) source',
    'ON target.delivery_reference_id = source.delivery_reference_id',
    "WHEN MATCHED AND target.study_key=source.study_key AND target.sent_at IS NULL AND (UPPER(target.status) IN ('FAILED','REJECTED','CANCELLED')",
    "  OR (UPPER(target.status) IN ('REQUESTED','QUEUED') AND target.updated_at < TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 15 MINUTE))) THEN",
    "  UPDATE SET status='REQUESTED', request_source='WEB_APP_MANUAL', requested_by=@requested_by,",
    '    requested_at=CURRENT_TIMESTAMP(), updated_at=CURRENT_TIMESTAMP(), last_attempt_at=CURRENT_TIMESTAMP(),',
    '    last_error=NULL, attempt_count=COALESCE(target.attempt_count, 0)+1, request_token=@request_token,',
    '    image_count=@image_count, selected_object_keys=@selected_object_keys',
    'WHEN NOT MATCHED THEN INSERT (delivery_reference_id, study_key, request_source, requested_by, requested_at,',
    '  status, attempt_count, image_count, selected_object_keys, destination_masked, last_attempt_at, updated_at, request_token)',
    "VALUES (@delivery_reference_id, @study_key, 'WEB_APP_MANUAL', @requested_by, CURRENT_TIMESTAMP(),",
    "  'REQUESTED', 1, @image_count, @selected_object_keys, @destination_masked, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP(), @request_token)"
  ].join('\n');
  whatsappBigQueryQuery_(sql, [
    whatsappBigQueryParameter_('delivery_reference_id', referenceId),
    whatsappBigQueryParameter_('study_key', study.study_key),
    whatsappBigQueryParameter_('requested_by', user.google_email),
    whatsappBigQueryParameter_('image_count', selectedImages.length, 'INT64'),
    whatsappBigQueryStringArrayParameter_('selected_object_keys', selectedObjectKeys),
    whatsappBigQueryParameter_('destination_masked', maskWhatsappPhone_(study.patient_phone_e164 || study.patient_phone)),
    whatsappBigQueryParameter_('request_token', requestToken)
  ]);
  var current = whatsappDeliveryRow_(referenceId);
  assert_(current && normalizeString_(current.request_token || '') === requestToken,
    current && whatsappDeliveryState_(current.status, current.sent_at) === 'SENT'
      ? 'WHATSAPP_IMAGE_ALREADY_SENT' : 'WHATSAPP_ALREADY_PENDING',
    current && whatsappDeliveryState_(current.status, current.sent_at) === 'SENT'
      ? 'Foto USG yang dipilih sudah pernah dikirim.'
      : 'Pengiriman foto yang dipilih sedang diproses.');
  return { deliveryReferenceId: referenceId, requestToken: requestToken, objectKeys: selectedObjectKeys };
}

function maskWhatsappPhone_(value) {
  var digits = normalizeString_(value).replace(/\D/g, '');
  if (!digits) return '';
  return digits.substring(0, Math.min(4, digits.length)) +
    new Array(Math.max(digits.length - 7, 1) + 1).join('*') + digits.slice(-3);
}

function whatsappUpdateOutbox_(deliveryReferenceId, requestToken, status, errorMessage) {
  var config = whatsappBigQueryConfig_();
  var table = '`' + config.projectId + '.' + config.dataset + '.whatsapp_deliveries`';
  var sql = [
    'UPDATE ' + table,
    'SET status=@status, updated_at=CURRENT_TIMESTAMP(), last_error=@last_error',
    "WHERE delivery_reference_id=@delivery_reference_id AND request_token=@request_token AND status='REQUESTED'"
  ].join('\n');
  whatsappBigQueryQuery_(sql, [
    whatsappBigQueryParameter_('status', status),
    whatsappBigQueryParameter_('last_error', sanitizePlainText_(errorMessage, 180)),
    whatsappBigQueryParameter_('delivery_reference_id', deliveryReferenceId),
    whatsappBigQueryParameter_('request_token', requestToken)
  ]);
}

function whatsappTriggerWebhook_(studyKey, deliveryReferenceId, selectedImages, user) {
  var config = whatsappWebhookConfig_();
  var response = UrlFetchApp.fetch(config.url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-API-Key': config.apiKey, Accept: 'application/json' },
    payload: JSON.stringify({
      study_key: studyKey,
      delivery_reference_id: deliveryReferenceId,
      request_source: 'WEB_APP_MANUAL',
      requested_by: user.google_email,
      selected_object_keys: selectedImages.map(function (image) { return image.object_key; }),
      selected_images: selectedImages.map(function (image) {
        return {
          object_key: image.object_key,
          sequence_number: image.sequence_number,
          frame_index: image.frame_index
        };
      })
    }),
    followRedirects: false,
    muteHttpExceptions: true
  });
  var code = response.getResponseCode();
  assert_(code >= 200 && code < 300, 'WHATSAPP_WEBHOOK_FAILED',
    'Layanan pengiriman WhatsApp menolak permintaan (HTTP ' + code + ').');
  var body = {};
  try {
    body = JSON.parse(response.getContentText() || '{}');
  } catch (error) {
    throw appError_('WHATSAPP_WEBHOOK_INVALID', 'Layanan WhatsApp mengembalikan respons yang tidak valid.');
  }
  assert_(body && typeof body === 'object' && !Array.isArray(body),
    'WHATSAPP_WEBHOOK_INVALID', 'Layanan WhatsApp mengembalikan respons yang tidak valid.');
  return body;
}

function sendWhatsAppImages(sessionToken, studyKey, selectedObjectKeys) {
  var user;
  var study;
  var acquired;
  var selectedImages;
  try {
    user = requirePermission('can_send_whatsapp', sessionToken);
    assert_(whatsappDeliveryEnabled_(), 'WHATSAPP_DISABLED', 'Fitur pengiriman WhatsApp belum diaktifkan.');
    whatsappWebhookConfig_();
    studyKey = whatsappStudyKey_(studyKey);
    study = listWhatsAppStudies_({ study_key: studyKey })[0];
    assert_(study, 'WHATSAPP_STUDY_NOT_FOUND', 'Pemeriksaan USG tidak ditemukan untuk instalasi ini.');
    assert_(study.whatsapp_ready && study.image_count > 0,
      'WHATSAPP_STUDY_NOT_READY', 'Data pasien atau foto USG belum siap dikirim ke WhatsApp.');
    selectedImages = whatsappSelectedImages_(study, selectedObjectKeys);
    acquired = whatsappAcquireOutbox_(study, selectedImages, user);
    whatsappTriggerWebhook_(studyKey, acquired.deliveryReferenceId, selectedImages, user);
    whatsappUpdateOutbox_(acquired.deliveryReferenceId, acquired.requestToken, 'QUEUED', '');
    writeAudit_(user, 'WHATSAPP_MANUAL_REQUESTED', '', '', {
      study_key: studyKey,
      delivery_reference_id: acquired.deliveryReferenceId,
      image_count: selectedImages.length
    });
    return success_(whatsappStudyForClient_(listWhatsAppStudies_({ study_key: studyKey })[0]));
  } catch (error) {
    if (study && acquired) {
      try {
        whatsappUpdateOutbox_(acquired.deliveryReferenceId, acquired.requestToken, 'FAILED',
          error && error.message ? error.message : 'Pengiriman gagal.');
        writeAudit_(user, 'WHATSAPP_MANUAL_FAILED', '', '', {
          study_key: study.study_key,
          delivery_reference_id: acquired.deliveryReferenceId,
          error_code: error && error.code ? error.code : 'UNEXPECTED_ERROR'
        });
      } catch (ignored) {
        console.warn(JSON.stringify({ code: 'WHATSAPP_FAILURE_AUDIT_FAILED' }));
      }
    }
    return publicError_(error);
  }
}

function validateWhatsAppConfiguration() {
  var activeUser = normalizeEmail_(Session.getActiveUser().getEmail());
  var adminEmail = normalizeEmail_(getRequiredProperty_(SCRIPT_PROPERTY_KEYS.ADMIN_EMAIL));
  assert_(activeUser && activeUser === adminEmail, 'WHATSAPP_CONFIGURATION_DENIED',
    'Konfigurasi WhatsApp hanya boleh divalidasi oleh administrator pemasang.');
  whatsappBigQueryConfig_();
  whatsappWebhookConfig_();
  whatsappAccessToken_();
  whatsappBigQueryQuery_('SELECT 1 AS ready', []);
  return { success: true, message: 'Koneksi service account, BigQuery, dan webhook WhatsApp siap digunakan.' };
}

function getWhatsAppDeliveryStatus(sessionToken) {
  try {
    requireRole(ROLES.ADMIN, sessionToken);
    var configured = true;
    try {
      whatsappBigQueryConfig_();
      whatsappWebhookConfig_();
      gcsBucketName_();
      gcsObjectPrefix_();
    } catch (ignored) {
      configured = false;
    }
    return success_({ enabled: whatsappDeliveryEnabled_(), configured: configured });
  } catch (error) {
    return publicError_(error);
  }
}

function setWhatsAppDeliveryEnabled(sessionToken, enabled) {
  try {
    var user = requireRole(ROLES.ADMIN, sessionToken);
    enabled = normalizeBoolean_(enabled);
    if (enabled) {
      whatsappWebhookConfig_();
      gcsBucketName_();
      gcsObjectPrefix_();
      listWhatsAppStudies_({});
    }
    withScriptLock_(function () {
      var setting = findRecord_('SETTINGS', 'setting_key', 'ENABLE_WHATSAPP_DELIVERY');
      assert_(setting, 'WHATSAPP_SETTING_MISSING', 'Jalankan setupApplication() terlebih dahulu.');
      updateRecord_('SETTINGS', setting._rowNumber, {
        setting_value: enabled ? 'true' : 'false',
        updated_at: now_(),
        updated_by: user.google_email
      });
    });
    writeAudit_(user, enabled ? 'WHATSAPP_DELIVERY_ENABLED' : 'WHATSAPP_DELIVERY_DISABLED', '', '', {});
    return success_({ enabled: enabled, configured: true });
  } catch (error) {
    return publicError_(error);
  }
}
