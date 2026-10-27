var PDF_LAYOUT = Object.freeze({
  PAGE_WIDTH: 595.28,
  PAGE_HEIGHT: 841.89,
  HORIZONTAL_MARGIN_POINTS: 12,
  VERTICAL_MARGIN_POINTS: 24,
  CONTENT_WIDTH_POINTS: 571.28,
  CONTENT_HEIGHT_POINTS: 793.89,
  FULL_PAGE_IMAGE_HEIGHT_POINTS: 680,
  POINTS_TO_PIXELS: 96 / 72,
  PAGE_NUMBER_RESERVED_HEIGHT_POINTS: 90
});

function getPdfPreparation(sessionToken, claimId) {
  try {
    var user = requireAuthenticatedUser(sessionToken);
    var claim = requireAccessibleClaim_(user, claimId);
    return success_(pdfPreparationForClient_(claim, user));
  } catch (error) {
    return publicError_(error);
  }
}

function generateClaimPdf(sessionToken, payload) {
  var outputFile = null;
  var temporaryFile = null;
  var backupResult = { status: 'DISABLED', filename: '' };
  var verifierResult = { status: 'DISABLED', filename: '' };
  try {
    var user = requirePermission('can_generate_pdf', sessionToken);
    assert_(normalizeBoolean_(payload && payload.confirmed_same_patient),
      'PATIENT_CONFIRMATION_REQUIRED', 'Konfirmasi bahwa seluruh berkas berasal dari pasien yang sama.');
    var result = withScriptLock_(function () {
      var claim = requireAccessibleClaim_(user, payload && payload.claim_id);
      var status = normalizeString_(claim.status).toUpperCase();
      assert_([CLAIM_STATUSES.COLLECTING_DOCUMENTS, CLAIM_STATUSES.READY, CLAIM_STATUSES.PDF_GENERATED].indexOf(status) >= 0,
        'CLAIM_NOT_READY_FOR_PDF', 'Klaim pada status ini belum dapat dibuat menjadi PDF.');
      var preparation = buildPdfPreparation_(claim);
      assert_(preparation.issues.length === 0, 'PDF_REQUIREMENTS_NOT_MET', preparation.issues.join(' '));
      var version = Math.max(0, Number(claim.pdf_version) || 0) + 1;
      assert_(version <= 999, 'PDF_VERSION_LIMIT', 'Batas versi PDF untuk klaim ini sudah tercapai. Hubungi administrator.');
      var filename = claimPdfFilename_(claim, version);
      var storageFilename = claimPdfStorageFilename_(claim, version);
      var temporaryDocument = DocumentApp.create('TEMP_' + normalizeString_(claim.claim_code) + '_' + Utilities.getUuid());
      temporaryFile = DriveApp.getFileById(temporaryDocument.getId());
      temporaryFile.moveTo(DriveApp.getFolderById(getRequiredProperty_(SCRIPT_PROPERTY_KEYS.SYSTEM_FOLDER_ID)));
      composeClaimPdf_(temporaryDocument, claim, preparation.documents);
      temporaryDocument.saveAndClose();
      var pdfBlob = DriveApp.getFileById(temporaryDocument.getId()).getAs(MimeType.PDF).setName(storageFilename);
      var pdfBytes = pdfBlob.getBytes();
      assert_(pdfBytes.length > 0, 'PDF_EMPTY', 'PDF yang dibuat kosong. Silakan coba kembali.');
      assert_(pdfBytes.length <= maxPdfSizeBytes_(), 'PDF_TOO_LARGE',
        'Ukuran PDF melebihi batas ' + maxPdfSizeMb_() + ' MB. Kurangi jumlah berkas atau gunakan gambar yang lebih kecil.');
      outputFile = getClaimSubfolder_(claim, 'OUTPUT').createFile(pdfBlob);
      var timestamp = now_();
      var changes = {
        status: CLAIM_STATUSES.PDF_GENERATED,
        selected_document_count: preparation.documents.length,
        pdf_version: version,
        final_pdf_file_id: outputFile.getId(),
        final_pdf_filename: filename,
        final_pdf_storage_filename: storageFilename,
        final_pdf_url: outputFile.getUrl(),
        final_pdf_generated_at: timestamp,
        final_pdf_generated_by: user.google_email,
        gcs_pdf_bucket: '',
        gcs_pdf_object: '',
        gcs_pdf_generation: '',
        gcs_pdf_at: '',
        gcs_pdf_status: gcsPdfDeliveryEnabled_() ? 'WAITING_COMPLETION' : 'DISABLED',
        gcs_pdf_error: '',
        updated_by: user.google_email,
        updated_at: timestamp
      };
      updateRecord_('CLAIMS', claim._rowNumber, changes);
      Object.keys(changes).forEach(function (key) { claim[key] = changes[key]; });
      return {
        claim: claim,
        filename: filename,
        storageFilename: storageFilename,
        version: version,
        fileSizeBytes: pdfBytes.length,
        documentCount: preparation.documents.length
      };
    });
    backupResult = backupClaimPdfSafely_(result.claim, outputFile);
    verifierResult = deliverClaimPdfToVerifierSafely_(result.claim, outputFile);
    writeAudit_(user, 'PDF_GENERATED', result.claim.claim_id, '', {
      storage_filename: result.storageFilename,
      pdf_version: result.version,
      file_size_bytes: result.fileSizeBytes,
      selected_document_count: result.documentCount,
      backup_status: backupResult.status,
      verifier_status: verifierResult.status
    });
    return success_({
      filename: result.filename,
      pdf_version: result.version,
      file_size_bytes: result.fileSizeBytes,
      backup: backupResult,
      verifier: verifierResult,
      claim: claimDetailForClient_(result.claim)
    });
  } catch (error) {
    trashDriveFile_(outputFile);
    return publicError_(error);
  } finally {
    trashDriveFile_(temporaryFile);
  }
}

function getFinalPdfForPreview(sessionToken, claimId) {
  try {
    var user = requireAuthenticatedUser(sessionToken);
    var claim = requireAccessibleClaim_(user, claimId);
    var content = finalPdfContent_(claim);
    writeAudit_(user, 'PDF_PREVIEWED', claim.claim_id, '', {
      storage_filename: normalizeString_(claim.final_pdf_storage_filename),
      file_size_bytes: content.file_size_bytes
    });
    return success_(content);
  } catch (error) {
    return publicError_(error);
  }
}

function downloadFinalPdf(sessionToken, claimId) {
  try {
    var user = requirePermission('can_download_pdf', sessionToken);
    var claim = requireAccessibleClaim_(user, claimId);
    var content = finalPdfContent_(claim);
    writeAudit_(user, 'PDF_DOWNLOADED', claim.claim_id, '', {
      storage_filename: normalizeString_(claim.final_pdf_storage_filename),
      file_size_bytes: content.file_size_bytes
    });
    return success_(content);
  } catch (error) {
    return publicError_(error);
  }
}

function completeClaim(sessionToken, claimId) {
  var gcsResult = { status: 'DISABLED', filename: '' };
  try {
    var user = requirePermission('can_generate_pdf', sessionToken);
    var completion = withScriptLock_(function () {
      var claim = requireAccessibleClaim_(user, claimId);
      assert_(normalizeString_(claim.status).toUpperCase() === CLAIM_STATUSES.PDF_GENERATED,
        'CLAIM_NOT_READY_TO_COMPLETE', 'Klaim hanya dapat diselesaikan setelah PDF dibuat.');
      var sourceFile = finalPdfFile_(claim);
      var timestamp = now_();
      var changes = {
        status: CLAIM_STATUSES.COMPLETED,
        completed_at: timestamp,
        mobile_upload_token_revoked_at: timestamp,
        updated_by: user.google_email,
        updated_at: timestamp
      };
      updateRecord_('CLAIMS', claim._rowNumber, changes);
      Object.keys(changes).forEach(function (key) { claim[key] = changes[key]; });
      return { claim: claim, sourceFile: sourceFile };
    });
    gcsResult = deliverClaimPdfToGcsSafely_(completion.claim, completion.sourceFile);
    writeAudit_(user, 'CLAIM_COMPLETED', completion.claim.claim_id, '', {
      claim_code: completion.claim.claim_code,
      pdf_version: Number(completion.claim.pdf_version) || 0,
      gcs_status: gcsResult.status
    });
    return success_({
      claim: claimDetailForClient_(completion.claim),
      gcs: gcsResult
    });
  } catch (error) {
    return publicError_(error);
  }
}

function reopenClaim(sessionToken, claimId) {
  try {
    var user = requireAuthenticatedUser(sessionToken);
    var updated = withScriptLock_(function () {
      var claim = requireAccessibleClaim_(user, claimId);
      assert_(normalizeString_(claim.status).toUpperCase() === CLAIM_STATUSES.COMPLETED,
        'CLAIM_NOT_COMPLETED', 'Hanya klaim yang sudah selesai yang dapat dibuka kembali.');
      var timestamp = now_();
      var changes = {
        status: CLAIM_STATUSES.COLLECTING_DOCUMENTS,
        completed_at: '',
        updated_by: user.google_email,
        updated_at: timestamp
      };
      updateRecord_('CLAIMS', claim._rowNumber, changes);
      Object.keys(changes).forEach(function (key) { claim[key] = changes[key]; });
      return claim;
    });
    writeAudit_(user, 'CLAIM_REOPENED', updated.claim_id, '', {
      claim_code: updated.claim_code,
      previous_pdf_version: Number(updated.pdf_version) || 0
    });
    return success_(claimDetailForClient_(updated));
  } catch (error) {
    return publicError_(error);
  }
}

function pdfPreparationForClient_(claim, user) {
  var preparation = buildPdfPreparation_(claim);
  return {
    ready: preparation.issues.length === 0,
    issues: preparation.issues,
    counts: preparation.counts,
    total_selected: preparation.documents.length,
    patient_name_masked: maskPatientName(claim.patient_name),
    examination_date: claimDateKey_(claim.examination_date),
    can_generate_pdf: user.role === ROLES.ADMIN || Boolean(user.can_generate_pdf),
    can_download_pdf: user.role === ROLES.ADMIN || Boolean(user.can_download_pdf),
    has_pdf: Boolean(normalizeString_(claim.final_pdf_file_id)),
    pdf_version: Number(claim.pdf_version) || 0,
    final_pdf_filename: normalizeString_(claim.final_pdf_filename),
    final_pdf_generated_at: toIsoString_(claim.final_pdf_generated_at),
    status: normalizeString_(claim.status).toUpperCase()
  };
}

function buildPdfPreparation_(claim) {
  var documents = activeDocumentsForClaim_(claim.claim_id).filter(function (document) {
    return normalizeBoolean_(document.selected_for_pdf);
  });
  var counts = { USG: 0, KTP: 0, BUKU_KIA: 0, SPP_FKPP_BPJS: 0, OTHER: 0 };
  documents.forEach(function (document) {
    var type = normalizeString_(document.document_type).toUpperCase();
    if (['RUJUKAN', 'BPJS', 'LAB'].indexOf(type) >= 0) type = DOCUMENT_TYPES.OTHER;
    if (Object.prototype.hasOwnProperty.call(counts, type)) counts[type] += 1;
  });
  var issues = [];
  if (!normalizeString_(claim.doctor_name)) {
    issues.push('Lengkapi Nama Dokter pada data klaim.');
  }
  if (getBooleanSetting_('REQUIRE_USG', true) && counts.USG < 1) {
    issues.push('Pilih sedikitnya satu Gambar USG.');
  }
  if (getBooleanSetting_('REQUIRE_KTP', false) && counts.KTP < 1) {
    issues.push('KTP wajib dipilih.');
  }
  if (getBooleanSetting_('REQUIRE_BUKU_KIA', false) && counts.BUKU_KIA < 1) {
    issues.push('Buku KIA wajib dipilih.');
  }
  if (getBooleanSetting_('REQUIRE_SPP_FKPP_BPJS', false) && counts.SPP_FKPP_BPJS < 1) {
    issues.push('Berkas SPP & FKPP BPJS wajib dipilih.');
  }
  if (!documents.length && !issues.length) issues.push('Pilih sedikitnya satu berkas untuk PDF.');
  return { documents: documents, counts: counts, issues: issues };
}

function composeClaimPdf_(document, claim, documents) {
  var body = document.getBody();
  body.clear();
  body.setPageWidth(PDF_LAYOUT.PAGE_WIDTH).setPageHeight(PDF_LAYOUT.PAGE_HEIGHT)
    .setMarginTop(PDF_LAYOUT.VERTICAL_MARGIN_POINTS).setMarginBottom(PDF_LAYOUT.VERTICAL_MARGIN_POINTS)
    .setMarginLeft(PDF_LAYOUT.HORIZONTAL_MARGIN_POINTS).setMarginRight(PDF_LAYOUT.HORIZONTAL_MARGIN_POINTS);
  var hasPage = false;
  var pageNumber = 0;
  if (getBooleanSetting_('PDF_INCLUDE_COVER', true)) {
    pageNumber += 1;
    appendPdfCover_(body, claim, pageNumber);
    hasPage = true;
  }
  var usgPerPage = pdfUsgImagesPerPage_();
  var usgOnPage = 0;
  var previousWasUsg = false;
  documents.forEach(function (item, index) {
    var type = normalizeString_(item.document_type).toUpperCase();
    var isUsg = type === DOCUMENT_TYPES.USG;
    var startNewPage = !isUsg || !previousWasUsg || usgOnPage >= usgPerPage;
    if (startNewPage) {
      if (hasPage) body.appendPageBreak();
      body.appendParagraph(isUsg ? 'GAMBAR USG' : (DOCUMENT_TYPE_LABELS[type] || 'BERKAS PENDUKUNG'))
        .setHeading(DocumentApp.ParagraphHeading.HEADING2)
        .setAlignment(DocumentApp.HorizontalAlignment.CENTER);
      hasPage = true;
      pageNumber += 1;
      usgOnPage = 0;
    }
    if (isUsg) usgOnPage += 1;
    var imageDimensions = appendPdfImage_(
      body,
      item,
      index + 1,
      pdfPointsToPixels_(PDF_LAYOUT.FULL_PAGE_IMAGE_HEIGHT_POINTS),
      pdfPointsToPixels_(PDF_LAYOUT.CONTENT_WIDTH_POINTS)
    );
    appendPdfPageNumber_(body, pageNumber, imageDimensions.height);
    previousWasUsg = isUsg;
    if (!isUsg) usgOnPage = 0;
  });
}

function appendPdfCover_(body, claim, pageNumber) {
  var facility = findRecord_('FACILITIES', 'facility_id', claim.facility_id);
  var facilityName = facility ? normalizeString_(facility.facility_name) : normalizeString_(claim.facility_id);
  body.appendParagraph('DOKUMEN PENDUKUNG')
    .setHeading(DocumentApp.ParagraphHeading.TITLE)
    .setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  body.appendParagraph('KLAIM USG BPJS')
    .setHeading(DocumentApp.ParagraphHeading.HEADING1)
    .setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  var facilityTitle = body.appendParagraph(facilityName || '-');
  facilityTitle.setAlignment(DocumentApp.HorizontalAlignment.CENTER).setSpacingAfter(10);
  facilityTitle.editAsText().setBold(true).setFontSize(14);
  body.appendParagraph('');
  appendPdfCoverField_(body, 'Kode Klaim', normalizeString_(claim.claim_code));
  appendPdfCoverField_(body, 'Nama Pasien', normalizeString_(claim.patient_name));
  appendPdfCoverField_(body, 'NIK', normalizeString_(claim.patient_nik));
  appendPdfCoverField_(body, 'No. HP', normalizeString_(claim.patient_phone));
  appendPdfCoverField_(body, 'Nama Dokter', normalizeString_(claim.doctor_name));
  appendPdfCoverField_(body, 'Tanggal Lahir', formatIndonesianServerDate_(claim.patient_birth_date));
  appendPdfCoverField_(body, 'Tanggal Pemeriksaan USG', formatIndonesianServerDate_(claim.examination_date));
  appendPdfCoverField_(body, 'Fasilitas', facilityName);
  appendPdfCoverField_(body, 'Dibuat', formatIndonesianServerDateTime_(now_()));
  appendPdfPageNumber_(body, pageNumber, null);
}

function appendPdfCoverField_(body, label, value) {
  var labelParagraph = body.appendParagraph(label + ':');
  labelParagraph.setSpacingBefore(10).setSpacingAfter(2);
  labelParagraph.editAsText().setBold(true);
  body.appendParagraph(value || '-').setSpacingAfter(4);
}

function appendPdfImage_(body, item, sequence, maxHeight, maxWidth) {
  var label = (DOCUMENT_TYPE_LABELS[normalizeString_(item.document_type)] || 'Berkas') + ' ' + sequence;
  body.appendParagraph(label).setAlignment(DocumentApp.HorizontalAlignment.CENTER).setSpacingAfter(4);
  var blob = getPrivateFileBlob_(item.drive_file_id);
  var image = body.appendImage(blob);
  var originalWidth = Math.max(1, Number(image.getWidth()) || Number(item.image_width) || 1);
  var originalHeight = Math.max(1, Number(image.getHeight()) || Number(item.image_height) || 1);
  var dimensions = pdfImageDimensions_(originalWidth, originalHeight, maxWidth, maxHeight);
  image.setWidth(dimensions.width);
  image.setHeight(dimensions.height);
  image.setAltTitle(label).setAltDescription('Berkas klaim ' + label);
  image.getParent().asParagraph().setAlignment(DocumentApp.HorizontalAlignment.CENTER).setSpacingAfter(8);
  return dimensions;
}

function appendPdfPageNumber_(body, pageNumber, imageHeight) {
  var spacingBefore = imageHeight === null || imageHeight === undefined
    ? 12
    : Math.max(4, PDF_LAYOUT.CONTENT_HEIGHT_POINTS - pdfPixelsToPoints_(Number(imageHeight || 0)) -
      PDF_LAYOUT.PAGE_NUMBER_RESERVED_HEIGHT_POINTS);
  var paragraph = body.appendParagraph('Halaman ' + pageNumber);
  paragraph.setAlignment(DocumentApp.HorizontalAlignment.RIGHT)
    .setSpacingBefore(spacingBefore)
    .setSpacingAfter(0);
  paragraph.editAsText().setFontSize(9).setForegroundColor('#666666');
}

function pdfImageDimensions_(originalWidth, originalHeight, maxWidth, maxHeight) {
  var width = Math.max(1, Number(originalWidth) || 1);
  var height = Math.max(1, Number(originalHeight) || 1);
  var widthLimit = Math.max(1, Number(maxWidth) || pdfPointsToPixels_(PDF_LAYOUT.CONTENT_WIDTH_POINTS));
  var heightLimit = Math.max(1, Number(maxHeight) || pdfPointsToPixels_(PDF_LAYOUT.FULL_PAGE_IMAGE_HEIGHT_POINTS));
  var scale = Math.min(widthLimit / width, heightLimit / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

function pdfPointsToPixels_(points) {
  return Math.max(1, Math.floor(Number(points || 0) * PDF_LAYOUT.POINTS_TO_PIXELS));
}

function pdfPixelsToPoints_(pixels) {
  return Number(pixels || 0) / PDF_LAYOUT.POINTS_TO_PIXELS;
}

function finalPdfContent_(claim) {
  var file = finalPdfFile_(claim);
  var blob = file.getBlob();
  var bytes = blob.getBytes();
  assert_(bytes.length > 0 && bytes.length <= maxPdfSizeBytes_(), 'PDF_FILE_TOO_LARGE',
    'PDF tidak dapat dikirim melalui aplikasi karena ukurannya melebihi batas.');
  return {
    filename: normalizeString_(claim.final_pdf_filename) || file.getName(),
    mime_type: 'application/pdf',
    file_size_bytes: bytes.length,
    base64: Utilities.base64Encode(bytes)
  };
}

function finalPdfFile_(claim) {
  var fileId = normalizeString_(claim.final_pdf_file_id);
  assert_(fileId, 'PDF_NOT_FOUND', 'PDF belum dibuat untuk klaim ini.');
  try {
    var file = DriveApp.getFileById(fileId);
    assert_(!file.isTrashed(), 'PDF_NOT_FOUND', 'PDF klaim sudah tidak tersedia.');
    assert_(file.getMimeType() === MimeType.PDF, 'PDF_NOT_FOUND', 'Berkas akhir klaim bukan PDF yang valid.');
    return file;
  } catch (error) {
    if (error && error.code) throw error;
    throw appError_('PDF_NOT_FOUND', 'PDF klaim tidak dapat dibuka.');
  }
}

function pdfUsgImagesPerPage_() {
  return 1;
}

function maxPdfSizeMb_() {
  var value = Number(getRequiredProperty_(SCRIPT_PROPERTY_KEYS.MAX_PDF_SIZE_MB));
  return isFinite(value) && value >= 1 && value <= 25 ? value : 10;
}

function maxPdfSizeBytes_() {
  return Math.floor(maxPdfSizeMb_() * 1024 * 1024);
}

function formatIndonesianServerDate_(value) {
  if (!value) return '-';
  var date = value instanceof Date ? value : parseClaimDate_(value, 'Tanggal');
  var monthNames = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
    'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  return date.getDate() + ' ' + monthNames[date.getMonth()] + ' ' + date.getFullYear();
}

function formatIndonesianServerDateTime_(value) {
  var date = value instanceof Date ? value : new Date(value);
  return formatIndonesianServerDate_(date) + ' pukul ' + Utilities.formatDate(date, APP_CONFIG.TIMEZONE, 'HH.mm') + ' WITA';
}
