function listDocuments(sessionToken, claimId) {
  try {
    var user = requireAuthenticatedUser(sessionToken);
    var claim = requireAccessibleClaim_(user, claimId);
    return success_(activeDocumentsForClaim_(claim.claim_id).map(documentForClient_));
  } catch (error) {
    return publicError_(error);
  }
}

function listMobileDocuments(sessionToken, rawToken) {
  try {
    var user = requireAuthenticatedUser(sessionToken);
    var claim = requireValidMobileToken_(user, rawToken);
    return success_(activeDocumentsForClaim_(claim.claim_id).map(documentForClient_));
  } catch (error) {
    return publicError_(error);
  }
}

function uploadDocument(sessionToken, payload) {
  try {
    var user = requireAuthenticatedUser(sessionToken);
    var claim = requireAccessibleClaim_(user, payload && payload.claim_id);
    var documentType = normalizeString_(payload && payload.document_type).toUpperCase();
    var sourceType = documentType === DOCUMENT_TYPES.USG ? SOURCE_TYPES.PC_UPLOAD : SOURCE_TYPES.MOBILE_UPLOAD;
    return success_(storeUploadedDocument_(user, claim, payload || {}, sourceType, ''));
  } catch (error) {
    return publicError_(error);
  }
}

function uploadMobileDocument(sessionToken, rawToken, payload) {
  try {
    var user = requireAuthenticatedUser(sessionToken);
    var claim = requireValidMobileToken_(user, rawToken);
    return success_(storeUploadedDocument_(user, claim, payload || {}, SOURCE_TYPES.MOBILE_UPLOAD, rawToken));
  } catch (error) {
    return publicError_(error);
  }
}

function getDocumentThumbnail(sessionToken, documentId) {
  return getAuthorizedDocumentContent_(sessionToken, documentId, true);
}

function getDocumentPreview(sessionToken, documentId) {
  return getAuthorizedDocumentContent_(sessionToken, documentId, false);
}

function deleteDocument(sessionToken, documentId) {
  try {
    var user = requireAuthenticatedUser(sessionToken);
    return success_(softDeleteDocument_(user, documentId, ''));
  } catch (error) {
    return publicError_(error);
  }
}

function deleteMobileDocument(sessionToken, rawToken, documentId) {
  try {
    var user = requireAuthenticatedUser(sessionToken);
    return success_(softDeleteDocument_(user, documentId, rawToken));
  } catch (error) {
    return publicError_(error);
  }
}

function updateDocumentSelection(sessionToken, documentId, selectedForPdf) {
  try {
    var user = requireAuthenticatedUser(sessionToken);
    var result = withScriptLock_(function () {
      var document = requireAccessibleDocument_(user, documentId);
      var claim = requireAccessibleClaim_(user, document.claim_id);
      assertClaimAcceptsDocuments_(claim);
      var selected = normalizeBoolean_(selectedForPdf);
      var timestamp = now_();
      updateRecord_('DOCUMENTS', document._rowNumber, {
        selected_for_pdf: selected,
        updated_by: user.google_email,
        updated_at: timestamp
      });
      document.selected_for_pdf = selected;
      updateClaimDocumentCount_(claim, user);
      return { document: document, claim: claim };
    });
    writeAudit_(user, 'DOCUMENT_SELECTION_UPDATED', result.claim.claim_id, result.document.document_id, {
      selected_for_pdf: normalizeBoolean_(result.document.selected_for_pdf)
    });
    return success_(documentForClient_(result.document));
  } catch (error) {
    return publicError_(error);
  }
}

function reorderDocuments(sessionToken, claimId, orderedDocumentIds) {
  try {
    var user = requireAuthenticatedUser(sessionToken);
    var result = withScriptLock_(function () {
      var claim = requireAccessibleClaim_(user, claimId);
      assertClaimAcceptsDocuments_(claim);
      var documents = activeDocumentsForClaim_(claim.claim_id);
      var supplied = Array.isArray(orderedDocumentIds) ? orderedDocumentIds.map(normalizeString_) : [];
      assert_(supplied.length === documents.length && supplied.length <= maxDocumentsPerClaim_(),
        'INVALID_DOCUMENT_ORDER', 'Urutan berkas tidak lengkap. Perbarui daftar lalu coba kembali.');
      var existingById = {};
      documents.forEach(function (document) { existingById[normalizeString_(document.document_id)] = document; });
      var seen = {};
      supplied.forEach(function (documentId) {
        assert_(existingById[documentId] && !seen[documentId],
          'INVALID_DOCUMENT_ORDER', 'Urutan berkas berisi data yang tidak valid atau berulang.');
        seen[documentId] = true;
      });
      var timestamp = now_();
      batchUpdateDocumentOrder_(supplied, existingById, user, timestamp);
      markClaimDocumentsChanged_(claim, user, timestamp);
      return { claim: claim, order: supplied };
    });
    writeAudit_(user, 'DOCUMENTS_REORDERED', result.claim.claim_id, '', {
      document_count: result.order.length,
      ordered_document_ids: result.order
    });
    return success_(activeDocumentsForClaim_(result.claim.claim_id).map(documentForClient_));
  } catch (error) {
    return publicError_(error);
  }
}

function rotateDocument(sessionToken, payload) {
  var files = null;
  try {
    var user = requireAuthenticatedUser(sessionToken);
    var image = decodeUploadedImage_(payload && payload.base64, payload && payload.mime_type,
      payload && payload.width, payload && payload.height, false);
    var thumbnail = decodeUploadedImage_(payload && payload.thumbnail_base64, 'image/jpeg',
      payload && payload.thumbnail_width, payload && payload.thumbnail_height, true);
    var hash = sha256Hex_(image.bytes);
    var result = withScriptLock_(function () {
      var document = requireAccessibleDocument_(user, payload && payload.document_id);
      var claim = requireAccessibleClaim_(user, document.claim_id);
      assertClaimAcceptsDocuments_(claim);
      if (normalizeString_(document.document_type).toUpperCase() !== DOCUMENT_TYPES.USG) {
        assertMobileHdDimensions_(image.width, image.height);
      }
      var duplicate = activeDocumentsForClaim_(claim.claim_id).some(function (item) {
        return normalizeString_(item.document_id) !== normalizeString_(document.document_id) &&
          normalizeString_(item.sha256_hash) === hash;
      });
      assert_(!duplicate, 'DUPLICATE_DOCUMENT', 'Hasil rotasi sama dengan berkas lain yang sudah ada.');
      var storedFilename = (normalizeString_(document.stored_filename) ||
        normalizeString_(document.document_type) + '_' + normalizeString_(document.document_id).replace(/-/g, ''))
        .replace(/\.[^.]+$/, '') + '.jpg';
      var thumbnailFilename = 'THUMB_' + normalizeString_(document.document_id).replace(/-/g, '') + '.jpg';
      files = createPrivateDocumentFiles_(claim, normalizeString_(document.document_type),
        Utilities.newBlob(image.bytes, image.mimeType, storedFilename),
        Utilities.newBlob(thumbnail.bytes, 'image/jpeg', thumbnailFilename),
        storedFilename, thumbnailFilename);
      var timestamp = now_();
      var previousImageFileId = normalizeString_(document.drive_file_id);
      var previousThumbnailFileId = normalizeString_(document.thumbnail_file_id);
      var rotation = ((Number(document.rotation_degrees) || 0) + 90) % 360;
      var changes = {
        drive_file_id: files.imageFile.getId(),
        thumbnail_file_id: files.thumbnailFile.getId(),
        mime_type: image.mimeType,
        file_size_bytes: image.bytes.length,
        image_width: image.width,
        image_height: image.height,
        sha256_hash: hash,
        rotation_degrees: rotation,
        updated_by: user.google_email,
        updated_at: timestamp
      };
      markClaimDocumentsChanged_(claim, user, timestamp);
      updateRecord_('DOCUMENTS', document._rowNumber, changes);
      Object.keys(changes).forEach(function (key) { document[key] = changes[key]; });
      return {
        document: document,
        claim: claim,
        previousImageFileId: previousImageFileId,
        previousThumbnailFileId: previousThumbnailFileId
      };
    });
    trashDriveFileById_(result.previousImageFileId);
    trashDriveFileById_(result.previousThumbnailFileId);
    writeAudit_(user, 'DOCUMENT_ROTATED', result.claim.claim_id, result.document.document_id, {
      rotation_degrees: Number(result.document.rotation_degrees) || 0,
      file_size_bytes: Number(result.document.file_size_bytes) || 0
    });
    return success_(documentForClient_(result.document));
  } catch (error) {
    if (files) {
      trashDriveFile_(files.imageFile);
      trashDriveFile_(files.thumbnailFile);
    }
    return publicError_(error);
  }
}

function storeUploadedDocument_(user, claim, payload, sourceType, rawMobileToken) {
  assertClaimAcceptsDocuments_(claim);
  var documentType = normalizeString_(payload.document_type).toUpperCase();
  assert_(isActiveDocumentType_(documentType),
    'INVALID_DOCUMENT_TYPE', 'Jenis berkas tidak valid.');
  var originalFilename = sanitizeFilename_(payload.original_filename);
  var image = decodeUploadedImage_(payload.base64, payload.mime_type, payload.width, payload.height, false);
  var thumbnail = decodeUploadedImage_(payload.thumbnail_base64, 'image/jpeg', payload.thumbnail_width, payload.thumbnail_height, true);
  if (sourceType === SOURCE_TYPES.MOBILE_UPLOAD && documentType !== DOCUMENT_TYPES.USG) {
    assertMobileHdDimensions_(image.width, image.height);
  }
  var hash = sha256Hex_(image.bytes);
  var documentId = Utilities.getUuid();
  var extension = image.mimeType === 'image/png' ? '.png' : '.jpg';
  var storedFilename = documentType + '_' + documentId.replace(/-/g, '') + extension;
  var thumbnailFilename = 'THUMB_' + documentId.replace(/-/g, '') + '.jpg';
  var files = null;
  var record;
  try {
    record = withScriptLock_(function () {
      var currentClaim = rawMobileToken
        ? requireValidMobileToken_(user, rawMobileToken)
        : requireAccessibleClaim_(user, claim.claim_id);
      assert_(normalizeString_(currentClaim.claim_id) === normalizeString_(claim.claim_id),
        'DOCUMENT_ACCESS_DENIED', 'Tautan unggah tidak sesuai dengan klaim.');
      assertClaimAcceptsDocuments_(currentClaim);
      var existing = activeDocumentsForClaim_(currentClaim.claim_id);
      assert_(existing.length < maxDocumentsPerClaim_(), 'DOCUMENT_LIMIT_REACHED',
        'Batas jumlah berkas untuk klaim ini sudah tercapai.');
      var duplicate = existing.some(function (item) { return normalizeString_(item.sha256_hash) === hash; });
      assert_(!duplicate, 'DUPLICATE_DOCUMENT', 'Gambar yang sama tampaknya sudah pernah diunggah.');
      var order = existing.reduce(function (maximum, item) {
        return Math.max(maximum, Number(item.display_order) || 0);
      }, 0) + 1;
      var imageBlob = Utilities.newBlob(image.bytes, image.mimeType, storedFilename);
      var thumbnailBlob = Utilities.newBlob(thumbnail.bytes, 'image/jpeg', thumbnailFilename);
      files = createPrivateDocumentFiles_(currentClaim, documentType, imageBlob, thumbnailBlob, storedFilename, thumbnailFilename);
      var timestamp = now_();
      var nextStatus = changedDocumentStatus_(currentClaim.status);
      record = {
        document_id: documentId,
        claim_id: currentClaim.claim_id,
        document_type: documentType,
        source_type: sourceType,
        original_filename: originalFilename,
        stored_filename: storedFilename,
        drive_file_id: files.imageFile.getId(),
        thumbnail_file_id: files.thumbnailFile.getId(),
        mime_type: image.mimeType,
        file_size_bytes: image.bytes.length,
        image_width: image.width,
        image_height: image.height,
        sha256_hash: hash,
        display_order: order,
        rotation_degrees: 0,
        selected_for_pdf: true,
        uploaded_by: user.google_email,
        uploaded_at: timestamp,
        updated_by: user.google_email,
        updated_at: timestamp,
        deleted_flag: false
      };
      appendRecord_('DOCUMENTS', record);
      updateRecord_('CLAIMS', currentClaim._rowNumber, {
        selected_document_count: existing.filter(function (item) {
          return normalizeBoolean_(item.selected_for_pdf);
        }).length + 1,
        status: nextStatus,
        updated_by: user.google_email,
        updated_at: timestamp
      });
      return record;
    });
  } catch (error) {
    if (record && record.document_id) {
      try {
        var orphan = findRecord_('DOCUMENTS', 'document_id', record.document_id);
        if (orphan && !normalizeBoolean_(orphan.deleted_flag)) {
          updateRecord_('DOCUMENTS', orphan._rowNumber, { deleted_flag: true, deleted_at: now_(), deleted_by: 'SYSTEM_ROLLBACK' });
        }
      } catch (rollbackError) {
        console.error(JSON.stringify({ code: 'DOCUMENT_METADATA_ROLLBACK_FAILED', message: rollbackError.message }));
      }
    }
    if (files) {
      trashDriveFile_(files.imageFile);
      trashDriveFile_(files.thumbnailFile);
    }
    throw error;
  }
  writeAudit_(user, 'DOCUMENT_UPLOADED', claim.claim_id, record.document_id, {
    document_type: record.document_type,
    source_type: record.source_type,
    stored_filename: record.stored_filename,
    file_size_bytes: record.file_size_bytes,
    sha256_hash: record.sha256_hash
  });
  return documentForClient_(record);
}

function softDeleteDocument_(user, documentId, rawMobileToken) {
  var result = withScriptLock_(function () {
    var tokenClaim = rawMobileToken ? requireValidMobileToken_(user, rawMobileToken) : null;
    var document = requireAccessibleDocument_(user, documentId);
    var claim = requireAccessibleClaim_(user, document.claim_id);
    if (tokenClaim) {
      assert_(normalizeString_(document.claim_id) === normalizeString_(tokenClaim.claim_id),
        'DOCUMENT_ACCESS_DENIED', 'Berkas bukan bagian dari klaim pada tautan ini.');
    }
    assertClaimAcceptsDocuments_(claim);
    var timestamp = now_();
    updateRecord_('DOCUMENTS', document._rowNumber, {
      deleted_flag: true,
      deleted_by: user.google_email,
      deleted_at: timestamp,
      updated_by: user.google_email,
      updated_at: timestamp
    });
    updateClaimDocumentCount_(claim, user);
    return { document: document, claim: claim };
  });
  trashDriveFileById_(result.document.drive_file_id);
  trashDriveFileById_(result.document.thumbnail_file_id);
  writeAudit_(user, 'DOCUMENT_DELETED', result.claim.claim_id, result.document.document_id, {
    document_type: result.document.document_type,
    stored_filename: result.document.stored_filename
  });
  return { document_id: result.document.document_id };
}

function getAuthorizedDocumentContent_(sessionToken, documentId, thumbnailOnly) {
  try {
    var user = requireAuthenticatedUser(sessionToken);
    var document = requireAccessibleDocument_(user, documentId);
    var blob = getPrivateFileBlob_(thumbnailOnly ? document.thumbnail_file_id : document.drive_file_id);
    var bytes = blob.getBytes();
    var maximum = thumbnailOnly ? UPLOAD_LIMITS.MAX_THUMBNAIL_BYTES : UPLOAD_LIMITS.MAX_IMAGE_BYTES;
    assert_(bytes.length <= maximum, 'DOCUMENT_FILE_TOO_LARGE', 'Berkas terlalu besar untuk ditampilkan.');
    return success_({
      mime_type: thumbnailOnly ? 'image/jpeg' : normalizeString_(document.mime_type),
      base64: Utilities.base64Encode(bytes)
    });
  } catch (error) {
    return publicError_(error);
  }
}

function requireAccessibleDocument_(user, documentId) {
  var id = normalizeString_(documentId);
  assert_(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id),
    'INVALID_DOCUMENT_ID', 'Identitas berkas tidak valid.');
  var document = findRecord_('DOCUMENTS', 'document_id', id);
  assert_(document && !normalizeBoolean_(document.deleted_flag), 'DOCUMENT_NOT_FOUND', 'Berkas tidak ditemukan.');
  requireAccessibleClaim_(user, document.claim_id);
  return document;
}

function activeDocumentsForClaim_(claimId) {
  return readAllRecords_('DOCUMENTS').filter(function (document) {
    return normalizeString_(document.claim_id) === normalizeString_(claimId) && !normalizeBoolean_(document.deleted_flag);
  }).sort(function (left, right) {
    return (Number(left.display_order) || 0) - (Number(right.display_order) || 0);
  });
}

function documentForClient_(document) {
  return {
    document_id: normalizeString_(document.document_id),
    document_type: normalizeString_(document.document_type),
    document_type_label: DOCUMENT_TYPE_LABELS[normalizeString_(document.document_type)] || 'Berkas',
    source_type: normalizeString_(document.source_type),
    original_filename: normalizeString_(document.original_filename),
    mime_type: normalizeString_(document.mime_type),
    file_size_bytes: Number(document.file_size_bytes) || 0,
    image_width: Number(document.image_width) || 0,
    image_height: Number(document.image_height) || 0,
    display_order: Number(document.display_order) || 0,
    rotation_degrees: Number(document.rotation_degrees) || 0,
    selected_for_pdf: normalizeBoolean_(document.selected_for_pdf),
    uploaded_at: toIsoString_(document.uploaded_at)
  };
}

function isActiveDocumentType_(documentType) {
  return Object.keys(DOCUMENT_TYPES).some(function (key) {
    return DOCUMENT_TYPES[key] === documentType;
  });
}

function assertMobileHdDimensions_(width, height) {
  var landscape = width >= height;
  var maximumWidth = landscape ? 1280 : 720;
  var maximumHeight = landscape ? 720 : 1280;
  assert_(width <= maximumWidth && height <= maximumHeight,
    'MOBILE_IMAGE_DIMENSIONS_EXCEEDED',
    'Foto berkas ponsel harus diperkecil maksimum 1280 x 720 piksel untuk lanskap atau 720 x 1280 piksel untuk potret. Muat ulang aplikasi lalu coba kembali.');
}

function assertClaimAcceptsDocuments_(claim) {
  var status = normalizeString_(claim.status).toUpperCase();
  assert_([CLAIM_STATUSES.DRAFT, CLAIM_STATUSES.COLLECTING_DOCUMENTS, CLAIM_STATUSES.READY].indexOf(status) >= 0,
    'CLAIM_DOCUMENTS_LOCKED', 'Berkas pada klaim dengan status ini tidak dapat diubah.');
}

function decodeUploadedImage_(base64, mimeType, width, height, thumbnail) {
  var encoded = normalizeString_(base64);
  var maxBytes = thumbnail ? UPLOAD_LIMITS.MAX_THUMBNAIL_BYTES : UPLOAD_LIMITS.MAX_IMAGE_BYTES;
  assert_(encoded && encoded.length <= Math.ceil(maxBytes * 4 / 3) + 16,
    'IMAGE_TOO_LARGE', thumbnail ? 'Pratinjau gambar terlalu besar.' : 'Gambar terlalu besar setelah dioptimalkan.');
  var normalizedMime = normalizeString_(mimeType).toLowerCase();
  assert_(['image/jpeg', 'image/png'].indexOf(normalizedMime) >= 0,
    'INVALID_IMAGE_TYPE', 'Hanya gambar JPEG atau PNG yang dapat diunggah.');
  if (thumbnail) normalizedMime = 'image/jpeg';
  var bytes;
  try {
    bytes = Utilities.base64Decode(encoded);
  } catch (error) {
    throw appError_('INVALID_IMAGE_DATA', 'Data gambar tidak dapat dibaca.');
  }
  assert_(bytes.length > 0 && bytes.length <= maxBytes, 'IMAGE_TOO_LARGE',
    thumbnail ? 'Pratinjau gambar terlalu besar.' : 'Gambar terlalu besar setelah dioptimalkan.');
  assert_(hasImageSignature_(bytes, normalizedMime), 'INVALID_IMAGE_DATA', 'Isi berkas bukan gambar JPEG atau PNG yang valid.');
  var imageWidth = Number(width);
  var imageHeight = Number(height);
  var maximumDimension = thumbnail ? UPLOAD_LIMITS.MAX_THUMBNAIL_DIMENSION : UPLOAD_LIMITS.MAX_IMAGE_DIMENSION;
  assert_(Number.isInteger(imageWidth) && Number.isInteger(imageHeight) && imageWidth > 0 && imageHeight > 0 &&
      imageWidth <= maximumDimension && imageHeight <= maximumDimension,
    'INVALID_IMAGE_DIMENSIONS', 'Ukuran gambar tidak valid.');
  return { bytes: bytes, mimeType: normalizedMime, width: imageWidth, height: imageHeight };
}

function hasImageSignature_(bytes, mimeType) {
  function unsigned(index) { return ((Number(bytes[index]) || 0) + 256) % 256; }
  if (mimeType === 'image/jpeg') return bytes.length >= 3 && unsigned(0) === 0xff && unsigned(1) === 0xd8 && unsigned(2) === 0xff;
  return bytes.length >= 8 && unsigned(0) === 0x89 && unsigned(1) === 0x50 && unsigned(2) === 0x4e &&
    unsigned(3) === 0x47 && unsigned(4) === 0x0d && unsigned(5) === 0x0a && unsigned(6) === 0x1a && unsigned(7) === 0x0a;
}

function sanitizeFilename_(filename) {
  var cleaned = sanitizePlainText_(filename, UPLOAD_LIMITS.MAX_ORIGINAL_FILENAME_LENGTH)
    .replace(/[\\/:*?"<>|]+/g, '_');
  return cleaned || 'gambar.jpg';
}

function sha256Hex_(bytes) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes).map(function (value) {
    return ('0' + (((Number(value) || 0) + 256) % 256).toString(16)).slice(-2);
  }).join('');
}

function maxDocumentsPerClaim_() {
  var setting = findRecord_('SETTINGS', 'setting_key', 'MAX_DOCUMENTS_PER_CLAIM');
  var value = Number(setting ? setting.setting_value : getRequiredProperty_(SCRIPT_PROPERTY_KEYS.MAX_DOCUMENTS_PER_CLAIM));
  return isFinite(value) && value >= 1 && value <= 100 ? Math.floor(value) : 30;
}

function updateClaimDocumentCount_(claim, user) {
  var count = activeDocumentsForClaim_(claim.claim_id).filter(function (document) {
    return normalizeBoolean_(document.selected_for_pdf);
  }).length;
  var timestamp = now_();
  updateRecord_('CLAIMS', claim._rowNumber, {
    selected_document_count: count,
    status: changedDocumentStatus_(claim.status),
    updated_by: user.google_email,
    updated_at: timestamp
  });
}

function markClaimDocumentsChanged_(claim, user, timestamp) {
  var changes = {
    status: changedDocumentStatus_(claim.status),
    updated_by: user.google_email,
    updated_at: timestamp || now_()
  };
  updateRecord_('CLAIMS', claim._rowNumber, changes);
  Object.keys(changes).forEach(function (key) { claim[key] = changes[key]; });
}

function changedDocumentStatus_(status) {
  var normalized = normalizeString_(status).toUpperCase();
  return [CLAIM_STATUSES.DRAFT, CLAIM_STATUSES.READY].indexOf(normalized) >= 0
    ? CLAIM_STATUSES.COLLECTING_DOCUMENTS
    : normalized;
}

function batchUpdateDocumentOrder_(orderedIds, existingById, user, timestamp) {
  var sheet = getSheet_('DOCUMENTS');
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  var headers = SHEET_SCHEMAS.DOCUMENTS;
  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var orderIndex = headers.indexOf('display_order');
  var updatedByIndex = headers.indexOf('updated_by');
  var updatedAtIndex = headers.indexOf('updated_at');
  orderedIds.forEach(function (documentId, index) {
    var rowIndex = Number(existingById[documentId]._rowNumber) - 2;
    assert_(rowIndex >= 0 && rowIndex < values.length,
      'INVALID_DOCUMENT_ORDER', 'Baris berkas tidak valid. Perbarui daftar lalu coba kembali.');
    values[rowIndex][orderIndex] = index + 1;
    values[rowIndex][updatedByIndex] = user.google_email;
    values[rowIndex][updatedAtIndex] = timestamp;
  });
  sheet.getRange(2, 1, values.length, headers.length).setValues(values);
}

function trashDriveFileById_(fileId) {
  if (!fileId) return;
  try {
    trashDriveFile_(DriveApp.getFileById(normalizeString_(fileId)));
  } catch (error) {
    console.error(JSON.stringify({ code: 'DOCUMENT_TRASH_FAILED', message: error.message }));
  }
}
