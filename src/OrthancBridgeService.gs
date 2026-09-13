function receiveOrthancBridgeRequest_(payload) {
  var bridge = authenticateOrthancBridge_(payload || {});
  var action = normalizeString_(payload && payload.action).toLowerCase();
  if (action === 'ping') {
    return success_({ bridge_id: bridge.bridgeId, app_version: APP_CONFIG.APP_VERSION, server_time: now_().toISOString() });
  }
  if (action === 'upsert_study') return success_(upsertOrthancStudy_(bridge, payload.study || {}));
  if (action === 'upload_image') return success_(receiveOrthancImage_(bridge, payload.image || {}));
  if (action === 'finalize_study') return success_(finalizeOrthancStudy_(bridge, payload.study || {}));
  throw appError_('BRIDGE_ACTION_INVALID', 'Tindakan OrthancBridge tidak dikenal.');
}

function authenticateOrthancBridge_(payload) {
  assert_(getBooleanSetting_('ENABLE_ORTHANC_BRIDGE', false),
    'ORTHANC_BRIDGE_DISABLED', 'Penerimaan OrthancBridge belum diaktifkan oleh administrator.');
  var properties = getScriptProperties_();
  var configuredId = normalizeString_(properties.getProperty(SCRIPT_PROPERTY_KEYS.ORTHANC_BRIDGE_ID));
  var suppliedId = sanitizeOrthancIdentifier_(payload.bridge_id, 80, 'Identitas bridge');
  var storedHash = normalizeString_(properties.getProperty(SCRIPT_PROPERTY_KEYS.ORTHANC_BRIDGE_SECRET_HASH));
  var suppliedKey = normalizeString_(payload.bridge_key);
  assert_(configuredId && suppliedId === configuredId && storedHash && suppliedKey,
    'ORTHANC_BRIDGE_UNAUTHORIZED', 'Identitas atau kunci OrthancBridge tidak valid.');
  assert_(constantTimeEquals_(storedHash, hashToken_(suppliedKey)),
    'ORTHANC_BRIDGE_UNAUTHORIZED', 'Identitas atau kunci OrthancBridge tidak valid.');
  return { bridgeId: configuredId };
}

function createOrthancBridgeId_() {
  return 'ORTHANC_' + Utilities.getUuid().replace(/-/g, '').substring(0, 20).toUpperCase();
}

function getOrthancBridgeStatus(sessionToken) {
  try {
    requireRole(ROLES.ADMIN, sessionToken);
    var properties = getScriptProperties_();
    var inbox = readAllRecords_('ORTHANC_INBOX');
    var counts = {};
    Object.keys(ORTHANC_INBOX_STATUSES).forEach(function (key) { counts[ORTHANC_INBOX_STATUSES[key]] = 0; });
    var lastReceivedAt = '';
    inbox.forEach(function (item) {
      var status = normalizeString_(item.status).toUpperCase();
      if (Object.prototype.hasOwnProperty.call(counts, status)) counts[status] += 1;
      var timestamp = toIsoString_(item.updated_at || item.received_at);
      if (timestamp && (!lastReceivedAt || timestamp > lastReceivedAt)) lastReceivedAt = timestamp;
    });
    return success_({
      enabled: getBooleanSetting_('ENABLE_ORTHANC_BRIDGE', false),
      key_configured: Boolean(normalizeString_(properties.getProperty(SCRIPT_PROPERTY_KEYS.ORTHANC_BRIDGE_SECRET_HASH))),
      bridge_id: normalizeString_(properties.getProperty(SCRIPT_PROPERTY_KEYS.ORTHANC_BRIDGE_ID)),
      endpoint_url: normalizeString_(ScriptApp.getService().getUrl()),
      last_received_at: lastReceivedAt,
      counts: counts
    });
  } catch (error) {
    return publicError_(error);
  }
}

function rotateOrthancBridgeKey(sessionToken) {
  try {
    var user = requireRole(ROLES.ADMIN, sessionToken);
    var properties = getScriptProperties_();
    var bridgeId = normalizeString_(properties.getProperty(SCRIPT_PROPERTY_KEYS.ORTHANC_BRIDGE_ID)) || createOrthancBridgeId_();
    var bridgeKey = createSecureToken_();
    properties.setProperty(SCRIPT_PROPERTY_KEYS.ORTHANC_BRIDGE_ID, bridgeId);
    properties.setProperty(SCRIPT_PROPERTY_KEYS.ORTHANC_BRIDGE_SECRET_HASH, hashToken_(bridgeKey));
    setOrthancBridgeEnabled_(true, user.google_email);
    writeAudit_(user, 'ORTHANC_BRIDGE_KEY_ROTATED', '', '', { bridge_id: bridgeId });
    return success_({
      bridge_id: bridgeId,
      bridge_key: bridgeKey,
      endpoint_url: normalizeString_(ScriptApp.getService().getUrl()),
      warning: 'Simpan kunci ini sekarang. Kunci tidak dapat ditampilkan kembali.'
    });
  } catch (error) {
    return publicError_(error);
  }
}

function setOrthancBridgeEnabled(sessionToken, enabled) {
  try {
    var user = requireRole(ROLES.ADMIN, sessionToken);
    var value = normalizeBoolean_(enabled);
    if (value) {
      assert_(normalizeString_(getScriptProperties_().getProperty(SCRIPT_PROPERTY_KEYS.ORTHANC_BRIDGE_SECRET_HASH)),
        'ORTHANC_BRIDGE_KEY_MISSING', 'Buat kunci koneksi OrthancBridge terlebih dahulu.');
    }
    setOrthancBridgeEnabled_(value, user.google_email);
    writeAudit_(user, value ? 'ORTHANC_BRIDGE_ENABLED' : 'ORTHANC_BRIDGE_DISABLED', '', '', {});
    return success_({ enabled: value });
  } catch (error) {
    return publicError_(error);
  }
}

function setOrthancBridgeEnabled_(enabled, updatedBy) {
  var setting = findRecord_('SETTINGS', 'setting_key', 'ENABLE_ORTHANC_BRIDGE');
  assert_(setting, 'ORTHANC_SETTING_MISSING', 'Pengaturan OrthancBridge belum tersedia. Jalankan setupApplication().');
  updateRecord_('SETTINGS', setting._rowNumber, {
    setting_value: enabled ? 'true' : 'false',
    updated_at: now_(),
    updated_by: updatedBy || 'SYSTEM'
  });
}

function upsertOrthancStudy_(bridge, studyPayload) {
  var identifiers = normalizeOrthancStudyPayload_(bridge.bridgeId, studyPayload);
  return withScriptLock_(function () {
    var existing = findRecord_('ORTHANC_INBOX', 'source_key', identifiers.source_key);
    if (existing && [ORTHANC_INBOX_STATUSES.READY, ORTHANC_INBOX_STATUSES.IMPORTED, ORTHANC_INBOX_STATUSES.REJECTED]
      .indexOf(normalizeString_(existing.status).toUpperCase()) >= 0) {
      return {
        inbox_id: normalizeString_(existing.inbox_id),
        status: normalizeString_(existing.status).toUpperCase(),
        should_upload: false
      };
    }
    var timestamp = now_();
    if (existing) {
      var changes = Object.assign({}, identifiers, {
        status: ORTHANC_INBOX_STATUSES.RECEIVING,
        expected_images: boundedInteger_(studyPayload.expected_images, 0, 100, 0),
        bridge_message: '',
        updated_at: timestamp
      });
      delete changes.source_key;
      updateRecord_('ORTHANC_INBOX', existing._rowNumber, changes);
      return { inbox_id: normalizeString_(existing.inbox_id), status: ORTHANC_INBOX_STATUSES.RECEIVING, should_upload: true };
    }
    var inboxId = Utilities.getUuid();
    appendRecord_('ORTHANC_INBOX', Object.assign({}, identifiers, {
      inbox_id: inboxId,
      status: ORTHANC_INBOX_STATUSES.RECEIVING,
      expected_images: boundedInteger_(studyPayload.expected_images, 0, 100, 0),
      received_images: 0,
      skipped_images: 0,
      received_at: timestamp,
      updated_at: timestamp
    }));
    return { inbox_id: inboxId, status: ORTHANC_INBOX_STATUSES.RECEIVING, should_upload: true };
  });
}

function receiveOrthancImage_(bridge, imagePayload) {
  var studySourceKey = orthancStudySourceKey_(bridge.bridgeId, imagePayload.study_instance_uid, imagePayload.orthanc_study_id);
  var inbox = findRecord_('ORTHANC_INBOX', 'source_key', studySourceKey);
  assert_(inbox, 'ORTHANC_STUDY_NOT_FOUND', 'Pemeriksaan Orthanc belum didaftarkan.');
  assert_([ORTHANC_INBOX_STATUSES.RECEIVING, ORTHANC_INBOX_STATUSES.ERROR]
    .indexOf(normalizeString_(inbox.status).toUpperCase()) >= 0,
    'ORTHANC_STUDY_LOCKED', 'Pemeriksaan Orthanc tidak menerima gambar tambahan.');
  var instanceId = sanitizeOrthancIdentifier_(imagePayload.orthanc_instance_id, 120, 'ID instance Orthanc');
  var seriesId = sanitizeOrthancIdentifier_(imagePayload.orthanc_series_id, 120, 'ID series Orthanc');
  var frameIndex = boundedInteger_(imagePayload.frame_index, 0, 100000, 0);
  var imageSourceKey = normalizeString_(inbox.inbox_id) + '|' + instanceId + '|' + frameIndex;
  var duplicate = findRecord_('ORTHANC_IMAGES', 'source_key', imageSourceKey);
  if (duplicate) return { image_id: normalizeString_(duplicate.image_id), duplicate: true };

  var image = decodeUploadedImage_(imagePayload.base64, imagePayload.mime_type,
    imagePayload.width, imagePayload.height, false);
  var thumbnail = decodeUploadedImage_(imagePayload.thumbnail_base64, 'image/jpeg',
    imagePayload.thumbnail_width, imagePayload.thumbnail_height, true);
  assert_(image.mimeType === 'image/jpeg', 'ORTHANC_IMAGE_TYPE_INVALID', 'Gambar hasil OrthancBridge harus berformat JPEG.');
  var hash = sha256Hex_(image.bytes);
  var imageId = Utilities.getUuid();
  var storedFilename = 'ORTHANC_' + imageId.replace(/-/g, '') + '.jpg';
  var thumbnailFilename = 'THUMB_' + imageId.replace(/-/g, '') + '.jpg';
  var files = null;
  try {
    var folders = getOrthancInboxFolders_(inbox.inbox_id);
    files = {
      imageFile: folders.images.createFile(Utilities.newBlob(image.bytes, 'image/jpeg', storedFilename)),
      thumbnailFile: folders.thumbnails.createFile(Utilities.newBlob(thumbnail.bytes, 'image/jpeg', thumbnailFilename))
    };
    var concurrent = withScriptLock_(function () {
      var concurrentDuplicate = findRecord_('ORTHANC_IMAGES', 'source_key', imageSourceKey);
      if (concurrentDuplicate) return concurrentDuplicate;
      appendRecord_('ORTHANC_IMAGES', {
        image_id: imageId,
        inbox_id: inbox.inbox_id,
        source_key: imageSourceKey,
        orthanc_instance_id: instanceId,
        orthanc_series_id: seriesId,
        sop_instance_uid: sanitizeOrthancIdentifier_(imagePayload.sop_instance_uid, 160, 'SOP Instance UID', true),
        frame_index: frameIndex,
        original_filename: sanitizeFilename_(imagePayload.original_filename || 'orthanc.jpg'),
        stored_filename: storedFilename,
        drive_file_id: files.imageFile.getId(),
        thumbnail_file_id: files.thumbnailFile.getId(),
        mime_type: 'image/jpeg',
        file_size_bytes: image.bytes.length,
        image_width: image.width,
        image_height: image.height,
        sha256_hash: hash,
        received_at: now_()
      });
      var currentInbox = findRecord_('ORTHANC_INBOX', 'inbox_id', inbox.inbox_id);
      updateRecord_('ORTHANC_INBOX', currentInbox._rowNumber, {
        received_images: orthancImagesForInbox_(inbox.inbox_id).length,
        updated_at: now_()
      });
      return null;
    });
    if (concurrent) {
      trashDriveFile_(files.imageFile);
      trashDriveFile_(files.thumbnailFile);
      return { image_id: normalizeString_(concurrent.image_id), duplicate: true };
    }
  } catch (error) {
    if (files) {
      trashDriveFile_(files.imageFile);
      trashDriveFile_(files.thumbnailFile);
    }
    throw error;
  }
  return { image_id: imageId, duplicate: false };
}

function finalizeOrthancStudy_(bridge, studyPayload) {
  var sourceKey = orthancStudySourceKey_(bridge.bridgeId, studyPayload.study_instance_uid, studyPayload.orthanc_study_id);
  var result = withScriptLock_(function () {
    var inbox = findRecord_('ORTHANC_INBOX', 'source_key', sourceKey);
    assert_(inbox, 'ORTHANC_STUDY_NOT_FOUND', 'Pemeriksaan Orthanc belum didaftarkan.');
    var currentStatus = normalizeString_(inbox.status).toUpperCase();
    if ([ORTHANC_INBOX_STATUSES.READY, ORTHANC_INBOX_STATUSES.IMPORTED, ORTHANC_INBOX_STATUSES.REJECTED].indexOf(currentStatus) >= 0) {
      return {
        inbox: inbox,
        status: currentStatus,
        received: Number(inbox.received_images) || orthancImagesForInbox_(inbox.inbox_id).length,
        skipped: Number(inbox.skipped_images) || 0,
        unchanged: true
      };
    }
    assert_([ORTHANC_INBOX_STATUSES.RECEIVING, ORTHANC_INBOX_STATUSES.ERROR].indexOf(currentStatus) >= 0,
      'ORTHANC_STUDY_LOCKED', 'Status pemeriksaan Orthanc tidak dapat diubah oleh bridge.');
    var received = orthancImagesForInbox_(inbox.inbox_id).length;
    var skipped = boundedInteger_(studyPayload.skipped_images, 0, 1000, 0);
    var expected = boundedInteger_(studyPayload.expected_images, 0, 1000, received + skipped);
    var status = received > 0 ? ORTHANC_INBOX_STATUSES.READY : ORTHANC_INBOX_STATUSES.ERROR;
    var message = sanitizePlainText_(studyPayload.message, 300);
    updateRecord_('ORTHANC_INBOX', inbox._rowNumber, {
      status: status,
      expected_images: expected,
      received_images: received,
      skipped_images: skipped,
      bridge_message: message,
      updated_at: now_()
    });
    return { inbox: inbox, status: status, received: received, skipped: skipped };
  });
  if (!result.unchanged) {
    writeAudit_(null, 'ORTHANC_STUDY_RECEIVED', '', '', {
      bridge_id: bridge.bridgeId,
      inbox_id: result.inbox.inbox_id,
      received_images: result.received,
      skipped_images: result.skipped,
      status: result.status
    });
  }
  return { inbox_id: normalizeString_(result.inbox.inbox_id), status: result.status, received_images: result.received };
}

function listOrthancInbox(sessionToken, includeProcessed) {
  try {
    requirePermission('can_create_claim', sessionToken);
    var processed = normalizeBoolean_(includeProcessed);
    var rows = readAllRecords_('ORTHANC_INBOX').filter(function (item) {
      var status = normalizeString_(item.status).toUpperCase();
      return processed || [ORTHANC_INBOX_STATUSES.IMPORTED, ORTHANC_INBOX_STATUSES.REJECTED].indexOf(status) < 0;
    }).sort(function (left, right) {
      return claimTimestamp_(right.updated_at || right.received_at) - claimTimestamp_(left.updated_at || left.received_at);
    });
    return success_(rows.slice(0, 100).map(orthancInboxListItem_));
  } catch (error) {
    return publicError_(error);
  }
}

function getOrthancInboxDetail(sessionToken, inboxId) {
  try {
    requirePermission('can_create_claim', sessionToken);
    var inbox = requireOrthancInbox_(inboxId);
    var detail = orthancInboxForClient_(inbox);
    detail.images = orthancImagesForInbox_(inbox.inbox_id).map(orthancImageForClient_);
    return success_(detail);
  } catch (error) {
    return publicError_(error);
  }
}

function getOrthancInboxThumbnail(sessionToken, imageId) {
  try {
    requirePermission('can_create_claim', sessionToken);
    var image = requireOrthancImage_(imageId);
    var blob = getPrivateFileBlob_(image.thumbnail_file_id);
    var bytes = blob.getBytes();
    assert_(bytes.length <= UPLOAD_LIMITS.MAX_THUMBNAIL_BYTES,
      'ORTHANC_THUMBNAIL_TOO_LARGE', 'Pratinjau Orthanc terlalu besar.');
    return success_({ mime_type: 'image/jpeg', base64: Utilities.base64Encode(bytes) });
  } catch (error) {
    return publicError_(error);
  }
}

function rejectOrthancInbox(sessionToken, inboxId) {
  try {
    var user = requirePermission('can_create_claim', sessionToken);
    var result = withScriptLock_(function () {
      var current = requireOrthancInbox_(inboxId);
      assert_(!normalizeString_(current.claim_id), 'ORTHANC_ALREADY_IMPORTED', 'Pemeriksaan sudah menjadi klaim.');
      assert_(normalizeString_(current.status).toUpperCase() !== ORTHANC_INBOX_STATUSES.REJECTED,
        'ORTHANC_ALREADY_REJECTED', 'Pemeriksaan sudah diabaikan.');
      updateRecord_('ORTHANC_INBOX', current._rowNumber, {
        status: ORTHANC_INBOX_STATUSES.REJECTED,
        rejected_at: now_(),
        rejected_by: user.google_email,
        updated_at: now_()
      });
      return { inbox: current, images: orthancImagesForInbox_(current.inbox_id) };
    });
    result.images.forEach(function (image) {
      trashDriveFileById_(image.drive_file_id);
      trashDriveFileById_(image.thumbnail_file_id);
    });
    writeAudit_(user, 'ORTHANC_STUDY_REJECTED', '', '', { inbox_id: result.inbox.inbox_id });
    return success_({ inbox_id: result.inbox.inbox_id });
  } catch (error) {
    return publicError_(error);
  }
}

function createClaimFromOrthanc(sessionToken, payload) {
  var folder = null;
  var copiedFiles = [];
  var createdDocumentIds = [];
  var createdClaimId = '';
  try {
    var user = requirePermission('can_create_claim', sessionToken);
    assert_(normalizeBoolean_(payload && payload.confirmed_patient),
      'ORTHANC_PATIENT_CONFIRMATION_REQUIRED', 'Konfirmasi data pasien wajib dicentang.');
    var created = withScriptLock_(function () {
      var inbox = requireOrthancInbox_(payload && payload.inbox_id);
      assert_(normalizeString_(inbox.status).toUpperCase() === ORTHANC_INBOX_STATUSES.READY,
        'ORTHANC_STUDY_NOT_READY', 'Pemeriksaan Orthanc belum siap diimpor.');
      assert_(!normalizeString_(inbox.claim_id), 'ORTHANC_ALREADY_IMPORTED', 'Pemeriksaan Orthanc sudah menjadi klaim.');
      var values = validateClaimPayload_(user, payload || {}, null);
      var requestedIds = Array.isArray(payload.image_ids) ? payload.image_ids.map(normalizeString_) : [];
      assert_(requestedIds.length > 0 && requestedIds.length <= maxDocumentsPerClaim_(),
        'ORTHANC_IMAGE_SELECTION_REQUIRED', 'Pilih sedikitnya satu gambar USG dari Orthanc.');
      var available = {};
      var stagingImages = orthancImagesForInbox_(inbox.inbox_id);
      stagingImages.forEach(function (image) { available[normalizeString_(image.image_id)] = image; });
      var seen = {};
      var selected = requestedIds.map(function (imageId) {
        assert_(available[imageId] && !seen[imageId] && !normalizeString_(available[imageId].imported_document_id),
          'ORTHANC_IMAGE_SELECTION_INVALID', 'Pilihan gambar Orthanc tidak valid atau berulang.');
        seen[imageId] = true;
        return available[imageId];
      });
      var claimId = Utilities.getUuid();
      createdClaimId = claimId;
      var claimCode = generateClaimCode_();
      folder = createClaimFolder_(claimCode);
      var timestamp = now_();
      var documents = selected.map(function (image, index) {
        var documentId = Utilities.getUuid();
        createdDocumentIds.push(documentId);
        var storedFilename = 'USG_' + documentId.replace(/-/g, '') + '.jpg';
        var thumbnailFilename = 'THUMB_' + documentId.replace(/-/g, '') + '.jpg';
        var imageCopy = DriveApp.getFileById(normalizeString_(image.drive_file_id))
          .makeCopy(storedFilename, getClaimSubfolder_({ drive_claim_folder_id: folder.getId() }, DOCUMENT_TYPES.USG));
        var thumbnailCopy = DriveApp.getFileById(normalizeString_(image.thumbnail_file_id))
          .makeCopy(thumbnailFilename, getClaimSubfolder_({ drive_claim_folder_id: folder.getId() }, 'THUMBNAILS'));
        copiedFiles.push(imageCopy, thumbnailCopy);
        return {
          document_id: documentId,
          claim_id: claimId,
          document_type: DOCUMENT_TYPES.USG,
          source_type: SOURCE_TYPES.ORTHANC_IMPORT,
          original_filename: normalizeString_(image.original_filename),
          stored_filename: storedFilename,
          drive_file_id: imageCopy.getId(),
          thumbnail_file_id: thumbnailCopy.getId(),
          mime_type: 'image/jpeg',
          file_size_bytes: Number(image.file_size_bytes) || 0,
          image_width: Number(image.image_width) || 0,
          image_height: Number(image.image_height) || 0,
          sha256_hash: normalizeString_(image.sha256_hash),
          display_order: index + 1,
          rotation_degrees: 0,
          selected_for_pdf: true,
          uploaded_by: user.google_email,
          uploaded_at: timestamp,
          updated_by: user.google_email,
          updated_at: timestamp,
          deleted_flag: false,
          orthanc_study_id: normalizeString_(inbox.orthanc_study_id),
          orthanc_series_id: normalizeString_(image.orthanc_series_id),
          orthanc_instance_id: normalizeString_(image.orthanc_instance_id),
          orthanc_frame_index: Number(image.frame_index) || 0
        };
      });
      var claim = {
        claim_id: claimId,
        claim_code: claimCode,
        facility_id: values.facility_id,
        patient_name: values.patient_name,
        patient_nik: values.patient_nik,
        patient_birth_date: values.patient_birth_date,
        examination_date: values.examination_date,
        status: CLAIM_STATUSES.COLLECTING_DOCUMENTS,
        created_by: user.google_email,
        created_at: timestamp,
        updated_by: user.google_email,
        updated_at: timestamp,
        drive_claim_folder_id: folder.getId(),
        selected_document_count: documents.length,
        pdf_version: 0
      };
      appendRecord_('CLAIMS', claim);
      documents.forEach(function (document) { appendRecord_('DOCUMENTS', document); });
      selected.forEach(function (image, index) {
        updateRecord_('ORTHANC_IMAGES', image._rowNumber, { imported_document_id: documents[index].document_id });
      });
      updateRecord_('ORTHANC_INBOX', inbox._rowNumber, {
        status: ORTHANC_INBOX_STATUSES.IMPORTED,
        claim_id: claimId,
        imported_at: timestamp,
        imported_by: user.google_email,
        updated_at: timestamp
      });
      return { claim: claim, inbox: inbox, stagingImages: stagingImages, documentCount: documents.length };
    });
    created.stagingImages.forEach(function (image) {
      trashDriveFileById_(image.drive_file_id);
      trashDriveFileById_(image.thumbnail_file_id);
    });
    writeAudit_(user, 'ORTHANC_CLAIM_IMPORTED', created.claim.claim_id, '', {
      inbox_id: created.inbox.inbox_id,
      orthanc_study_id: created.inbox.orthanc_study_id,
      document_count: created.documentCount
    });
    return success_(claimDetailForClient_(created.claim));
  } catch (error) {
    copiedFiles.forEach(trashDriveFile_);
    if (folder) trashEmptyClaimFolder_(folder);
    if (createdClaimId) rollbackFailedOrthancClaim_(createdClaimId, createdDocumentIds);
    return publicError_(error);
  }
}

function rollbackFailedOrthancClaim_(claimId, documentIds) {
  try {
    var timestamp = now_();
    var claim = findRecord_('CLAIMS', 'claim_id', claimId);
    if (claim) updateRecord_('CLAIMS', claim._rowNumber, { status: CLAIM_STATUSES.ARCHIVED, archived_at: timestamp, updated_at: timestamp });
    (documentIds || []).forEach(function (documentId) {
      var document = findRecord_('DOCUMENTS', 'document_id', documentId);
      if (document) updateRecord_('DOCUMENTS', document._rowNumber, { deleted_flag: true, deleted_at: timestamp, deleted_by: 'SYSTEM_ROLLBACK' });
    });
  } catch (rollbackError) {
    console.error(JSON.stringify({ code: 'ORTHANC_IMPORT_ROLLBACK_FAILED', message: rollbackError.message }));
  }
}

function normalizeOrthancStudyPayload_(bridgeId, payload) {
  var studyId = sanitizeOrthancIdentifier_(payload.orthanc_study_id, 120, 'ID studi Orthanc');
  var studyUid = sanitizeOrthancIdentifier_(payload.study_instance_uid, 160, 'Study Instance UID', true);
  var patientId = sanitizePlainText_(payload.patient_id, 80);
  var digits = patientId.replace(/\D/g, '');
  return {
    bridge_id: bridgeId,
    source_key: orthancStudySourceKey_(bridgeId, studyUid, studyId),
    orthanc_study_id: studyId,
    study_instance_uid: studyUid,
    patient_name: sanitizePlainText_(normalizeString_(payload.patient_name).replace(/\^+/g, ' '), 120),
    patient_id: patientId,
    patient_nik_candidate: /^\d{16}$/.test(digits) ? digits : '',
    patient_birth_date: orthancDateKey_(payload.patient_birth_date),
    study_date: orthancDateKey_(payload.study_date),
    accession_number: sanitizePlainText_(payload.accession_number, 80),
    study_description: sanitizePlainText_(payload.study_description, 160)
  };
}

function orthancStudySourceKey_(bridgeId, studyUid, studyId) {
  var identifier = normalizeString_(studyUid) || normalizeString_(studyId);
  assert_(identifier, 'ORTHANC_STUDY_ID_REQUIRED', 'Identitas pemeriksaan Orthanc wajib tersedia.');
  return normalizeString_(bridgeId) + '|' + identifier;
}

function sanitizeOrthancIdentifier_(value, maximum, label, optional) {
  var text = normalizeString_(value);
  if (!text && optional) return '';
  assert_(text && text.length <= maximum && /^[A-Za-z0-9._:-]+$/.test(text),
    'ORTHANC_IDENTIFIER_INVALID', (label || 'Identitas Orthanc') + ' tidak valid.');
  return text;
}

function orthancDateKey_(value) {
  var text = normalizeString_(value).replace(/-/g, '');
  var match = /^(\d{4})(\d{2})(\d{2})/.exec(text);
  if (!match) return '';
  var key = match[1] + '-' + match[2] + '-' + match[3];
  try {
    parseClaimDate_(key, 'Tanggal DICOM');
    return key;
  } catch (error) {
    return '';
  }
}

function boundedInteger_(value, minimum, maximum, fallback) {
  var number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

function getOrthancInboxFolders_(inboxId) {
  var root = DriveApp.getFolderById(getRequiredProperty_(SCRIPT_PROPERTY_KEYS.ORTHANC_INBOX_FOLDER_ID));
  var folderName = 'INBOX_' + normalizeString_(inboxId).replace(/-/g, '');
  var matches = root.getFoldersByName(folderName);
  var folder = matches.hasNext() ? matches.next() : root.createFolder(folderName);
  assert_(!matches.hasNext(), 'ORTHANC_FOLDER_AMBIGUOUS', 'Folder penampungan Orthanc tidak unik.');
  var thumbnails = folder.getFoldersByName('THUMBNAILS');
  var thumbnailFolder = thumbnails.hasNext() ? thumbnails.next() : folder.createFolder('THUMBNAILS');
  assert_(!thumbnails.hasNext(), 'ORTHANC_FOLDER_AMBIGUOUS', 'Folder thumbnail Orthanc tidak unik.');
  return { images: folder, thumbnails: thumbnailFolder };
}

function orthancImagesForInbox_(inboxId) {
  return readAllRecords_('ORTHANC_IMAGES').filter(function (image) {
    return normalizeString_(image.inbox_id) === normalizeString_(inboxId);
  });
}

function requireOrthancInbox_(inboxId) {
  var id = normalizeString_(inboxId);
  assert_(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id),
    'ORTHANC_INBOX_ID_INVALID', 'Identitas kotak masuk Orthanc tidak valid.');
  var inbox = findRecord_('ORTHANC_INBOX', 'inbox_id', id);
  assert_(inbox, 'ORTHANC_INBOX_NOT_FOUND', 'Pemeriksaan Orthanc tidak ditemukan.');
  return inbox;
}

function requireOrthancImage_(imageId) {
  var id = normalizeString_(imageId);
  assert_(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id),
    'ORTHANC_IMAGE_ID_INVALID', 'Identitas gambar Orthanc tidak valid.');
  var image = findRecord_('ORTHANC_IMAGES', 'image_id', id);
  assert_(image, 'ORTHANC_IMAGE_NOT_FOUND', 'Gambar Orthanc tidak ditemukan.');
  return image;
}

function orthancInboxListItem_(inbox) {
  return {
    inbox_id: normalizeString_(inbox.inbox_id),
    patient_name_masked: maskPatientName(inbox.patient_name),
    patient_id_masked: maskNik(inbox.patient_id),
    patient_nik_available: Boolean(normalizeString_(inbox.patient_nik_candidate)),
    study_date: claimDateKey_(inbox.study_date),
    study_description: normalizeString_(inbox.study_description),
    accession_number: normalizeString_(inbox.accession_number),
    status: normalizeString_(inbox.status).toUpperCase(),
    received_images: Number(inbox.received_images) || 0,
    skipped_images: Number(inbox.skipped_images) || 0,
    claim_id: normalizeString_(inbox.claim_id),
    updated_at: toIsoString_(inbox.updated_at || inbox.received_at)
  };
}

function orthancInboxForClient_(inbox) {
  var item = orthancInboxListItem_(inbox);
  item.patient_name = normalizeString_(inbox.patient_name);
  item.patient_id = normalizeString_(inbox.patient_id);
  item.patient_nik_candidate = normalizeString_(inbox.patient_nik_candidate);
  item.patient_birth_date = claimDateKey_(inbox.patient_birth_date);
  item.orthanc_study_id = normalizeString_(inbox.orthanc_study_id);
  item.study_instance_uid = normalizeString_(inbox.study_instance_uid);
  item.bridge_message = normalizeString_(inbox.bridge_message);
  return item;
}

function orthancImageForClient_(image) {
  return {
    image_id: normalizeString_(image.image_id),
    orthanc_instance_id: normalizeString_(image.orthanc_instance_id),
    orthanc_series_id: normalizeString_(image.orthanc_series_id),
    frame_index: Number(image.frame_index) || 0,
    image_width: Number(image.image_width) || 0,
    image_height: Number(image.image_height) || 0,
    file_size_bytes: Number(image.file_size_bytes) || 0,
    imported: Boolean(normalizeString_(image.imported_document_id))
  };
}
