function listClaims(sessionToken, filters) {
  try {
    var user = requireAuthenticatedUser(sessionToken);
    var options = filters || {};
    var search = normalizeString_(options.search).toLowerCase();
    var status = normalizeString_(options.status).toUpperCase();
    var examinationDate = normalizeString_(options.examination_date);
    var includeArchived = user.role === ROLES.ADMIN &&
      (normalizeBoolean_(options.include_archived) || status === CLAIM_STATUSES.ARCHIVED);
    if (status) assert_(isClaimStatus_(status), 'INVALID_STATUS', 'Status klaim tidak valid.');
    if (examinationDate) parseClaimDate_(examinationDate, 'Tanggal pemeriksaan');

    var facilities = facilityNameMap_();
    var accessible = readAllRecords_('CLAIMS').filter(function (claim) {
      if (!canAccessClaim(user, claim)) return false;
      var claimStatus = normalizeString_(claim.status).toUpperCase();
      if (!includeArchived && claimStatus === CLAIM_STATUSES.ARCHIVED) return false;
      if (status && claimStatus !== status) return false;
      if (examinationDate && claimDateKey_(claim.examination_date) !== examinationDate) return false;
      if (!search) return true;
      return [claim.claim_code, claim.patient_name, claim.patient_nik].some(function (value) {
        return normalizeString_(value).toLowerCase().indexOf(search) >= 0;
      });
    });
    accessible.sort(function (left, right) {
      return claimTimestamp_(right.updated_at || right.created_at) - claimTimestamp_(left.updated_at || left.created_at);
    });
    var counts = {};
    Object.keys(CLAIM_STATUSES).forEach(function (key) { counts[CLAIM_STATUSES[key]] = 0; });
    accessible.forEach(function (claim) {
      var claimStatus = normalizeString_(claim.status).toUpperCase();
      if (Object.prototype.hasOwnProperty.call(counts, claimStatus)) counts[claimStatus] += 1;
    });
    var total = accessible.length;
    return success_({
      claims: accessible.slice(0, 200).map(function (claim) { return claimListItem_(claim, facilities); }),
      total: total,
      truncated: total > 200,
      counts: counts
    });
  } catch (error) {
    return publicError_(error);
  }
}

function getClaimDetail(sessionToken, claimId) {
  try {
    var user = requireAuthenticatedUser(sessionToken);
    var claim = requireAccessibleClaim_(user, claimId);
    return success_(claimDetailForClient_(claim));
  } catch (error) {
    return publicError_(error);
  }
}

function listClaimFacilities(sessionToken) {
  try {
    var user = requireAuthenticatedUser(sessionToken);
    var facilities = readAllRecords_('FACILITIES').filter(function (facility) {
      if (!normalizeBoolean_(facility.active)) return false;
      return user.role === ROLES.ADMIN || normalizeString_(facility.facility_id) === normalizeString_(user.facility_id);
    }).map(function (facility) {
      return {
        facility_id: normalizeString_(facility.facility_id),
        facility_name: normalizeString_(facility.facility_name)
      };
    });
    return success_(facilities);
  } catch (error) {
    return publicError_(error);
  }
}

function createClaim(sessionToken, payload) {
  var folder = null;
  try {
    var user = requirePermission('can_create_claim', sessionToken);
    var created = withScriptLock_(function () {
      var values = validateClaimPayload_(user, payload || {}, null);
      var claimId = Utilities.getUuid();
      var claimCode = generateClaimCode_();
      folder = createClaimFolder_(claimCode);
      var timestamp = now_();
      var record = {
        claim_id: claimId,
        claim_code: claimCode,
        facility_id: values.facility_id,
        patient_name: values.patient_name,
        patient_nik: values.patient_nik,
        patient_birth_date: values.patient_birth_date,
        examination_date: values.examination_date,
        status: CLAIM_STATUSES.DRAFT,
        created_by: user.google_email,
        created_at: timestamp,
        updated_by: user.google_email,
        updated_at: timestamp,
        drive_claim_folder_id: folder.getId(),
        selected_document_count: 0,
        pdf_version: 0
      };
      try {
        appendRecord_('CLAIMS', record);
      } catch (error) {
        trashEmptyClaimFolder_(folder);
        folder = null;
        throw error;
      }
      return record;
    });
    writeAudit_(user, 'CLAIM_CREATED', created.claim_id, '', {
      claim_code: created.claim_code,
      status: created.status,
      facility_id: created.facility_id
    });
    return success_(claimDetailForClient_(created));
  } catch (error) {
    return publicError_(error);
  }
}

function updateClaim(sessionToken, payload) {
  try {
    var user = requireAuthenticatedUser(sessionToken);
    var updated = withScriptLock_(function () {
      var claim = requireAccessibleClaim_(user, payload && payload.claim_id);
      var status = normalizeString_(claim.status).toUpperCase();
      assert_([CLAIM_STATUSES.DRAFT, CLAIM_STATUSES.COLLECTING_DOCUMENTS].indexOf(status) >= 0,
        'CLAIM_NOT_EDITABLE', 'Klaim pada status ini tidak dapat diubah.');
      var values = validateClaimPayload_(user, payload || {}, claim);
      var changes = {
        patient_name: values.patient_name,
        patient_nik: values.patient_nik,
        patient_birth_date: values.patient_birth_date,
        examination_date: values.examination_date,
        updated_by: user.google_email,
        updated_at: now_()
      };
      updateRecord_('CLAIMS', claim._rowNumber, changes);
      Object.keys(changes).forEach(function (key) { claim[key] = changes[key]; });
      return claim;
    });
    writeAudit_(user, 'CLAIM_UPDATED', updated.claim_id, '', {
      claim_code: updated.claim_code,
      status: updated.status
    });
    return success_(claimDetailForClient_(updated));
  } catch (error) {
    return publicError_(error);
  }
}

function startClaimDocumentCollection(sessionToken, claimId) {
  try {
    var user = requireAuthenticatedUser(sessionToken);
    var updated = withScriptLock_(function () {
      var claim = requireAccessibleClaim_(user, claimId);
      assert_(normalizeString_(claim.status).toUpperCase() === CLAIM_STATUSES.DRAFT,
        'INVALID_STATUS_TRANSITION', 'Hanya klaim Draf yang dapat mulai mengumpulkan berkas.');
      var changes = {
        status: CLAIM_STATUSES.COLLECTING_DOCUMENTS,
        updated_by: user.google_email,
        updated_at: now_()
      };
      updateRecord_('CLAIMS', claim._rowNumber, changes);
      Object.keys(changes).forEach(function (key) { claim[key] = changes[key]; });
      return claim;
    });
    writeAudit_(user, 'CLAIM_COLLECTION_STARTED', updated.claim_id, '', {
      claim_code: updated.claim_code,
      status: updated.status
    });
    return success_(claimDetailForClient_(updated));
  } catch (error) {
    return publicError_(error);
  }
}

function archiveClaim(sessionToken, claimId) {
  try {
    var user = requireRole(ROLES.ADMIN, sessionToken);
    var result = withScriptLock_(function () {
      var claim = requireAccessibleClaim_(user, claimId);
      var previousStatus = normalizeString_(claim.status).toUpperCase();
      assert_(previousStatus !== CLAIM_STATUSES.ARCHIVED,
        'CLAIM_ALREADY_ARCHIVED', 'Klaim sudah diarsipkan.');
      var timestamp = now_();
      var changes = {
        status: CLAIM_STATUSES.ARCHIVED,
        archived_at: timestamp,
        updated_by: user.google_email,
        updated_at: timestamp,
        mobile_upload_token_revoked_at: timestamp
      };
      updateRecord_('CLAIMS', claim._rowNumber, changes);
      Object.keys(changes).forEach(function (key) { claim[key] = changes[key]; });
      return { claim: claim, previousStatus: previousStatus };
    });
    writeAudit_(user, 'CLAIM_ARCHIVED', result.claim.claim_id, '', {
      claim_code: result.claim.claim_code,
      previous_status: result.previousStatus
    });
    return success_(claimDetailForClient_(result.claim));
  } catch (error) {
    return publicError_(error);
  }
}

function validateClaimPayload_(user, payload, existingClaim) {
  var patientName = sanitizePlainText_(payload.patient_name, 120);
  var patientNik = normalizeString_(payload.patient_nik).replace(/\s/g, '');
  var facilityId = existingClaim
    ? normalizeString_(existingClaim.facility_id)
    : normalizeString_(payload.facility_id || user.facility_id);
  assert_(patientName.length >= 2, 'PATIENT_NAME_REQUIRED', 'Nama pasien wajib diisi.');
  assert_(/^\d{16}$/.test(patientNik), 'INVALID_NIK', 'NIK harus terdiri dari tepat 16 angka.');
  var birthDate = parseClaimDate_(payload.patient_birth_date, 'Tanggal lahir');
  var examinationDate = parseClaimDate_(payload.examination_date, 'Tanggal pemeriksaan USG');
  assert_(birthDate.getTime() <= examinationDate.getTime(), 'INVALID_DATE_ORDER',
    'Tanggal lahir tidak boleh setelah tanggal pemeriksaan USG.');
  var today = parseClaimDate_(Utilities.formatDate(now_(), APP_CONFIG.TIMEZONE, 'yyyy-MM-dd'), 'Tanggal hari ini');
  assert_(examinationDate.getTime() <= today.getTime(), 'FUTURE_EXAMINATION_DATE',
    'Tanggal pemeriksaan USG tidak boleh setelah hari ini.');
  var facility = findRecord_('FACILITIES', 'facility_id', facilityId);
  assert_(facility && normalizeBoolean_(facility.active), 'INVALID_FACILITY', 'Fasilitas tidak aktif atau tidak ditemukan.');
  assert_(user.role === ROLES.ADMIN || facilityId === normalizeString_(user.facility_id),
    'FACILITY_ACCESS_DENIED', 'Staf hanya dapat membuat klaim untuk fasilitasnya sendiri.');
  return {
    patient_name: patientName,
    patient_nik: patientNik,
    patient_birth_date: birthDate,
    examination_date: examinationDate,
    facility_id: facilityId
  };
}

function parseClaimDate_(value, fieldName) {
  var text = value instanceof Date
    ? Utilities.formatDate(value, APP_CONFIG.TIMEZONE, 'yyyy-MM-dd')
    : normalizeString_(value).substring(0, 10);
  var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  assert_(match, 'INVALID_DATE', fieldName + ' tidak valid.');
  var date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0);
  assert_(date.getFullYear() === Number(match[1]) && date.getMonth() === Number(match[2]) - 1 && date.getDate() === Number(match[3]),
    'INVALID_DATE', fieldName + ' tidak valid.');
  return date;
}

function generateClaimCode_() {
  var datePart = Utilities.formatDate(now_(), APP_CONFIG.TIMEZONE, 'yyyyMMdd');
  for (var attempt = 0; attempt < 5; attempt += 1) {
    var suffix = Utilities.getUuid().replace(/-/g, '').substring(0, 6).toUpperCase();
    var code = 'CLAIM-' + datePart + '-' + suffix;
    if (!findRecord_('CLAIMS', 'claim_code', code)) return code;
  }
  throw appError_('CLAIM_CODE_GENERATION_FAILED', 'Kode klaim tidak dapat dibuat. Silakan coba kembali.');
}

function requireAccessibleClaim_(user, claimId) {
  var id = normalizeString_(claimId);
  assert_(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id),
    'INVALID_CLAIM_ID', 'Identitas klaim tidak valid.');
  var claim = findRecord_('CLAIMS', 'claim_id', id);
  assert_(claim, 'CLAIM_NOT_FOUND', 'Klaim tidak ditemukan.');
  assert_(canAccessClaim(user, claim), 'CLAIM_ACCESS_DENIED', 'Anda tidak memiliki akses ke klaim ini.');
  return claim;
}

function claimListItem_(claim, facilities) {
  return {
    claim_id: normalizeString_(claim.claim_id),
    claim_code: normalizeString_(claim.claim_code),
    patient_name_masked: maskPatientName(claim.patient_name),
    patient_nik_masked: maskNik(claim.patient_nik),
    examination_date: claimDateKey_(claim.examination_date),
    status: normalizeString_(claim.status).toUpperCase(),
    facility_id: normalizeString_(claim.facility_id),
    facility_name: facilities[normalizeString_(claim.facility_id)] || normalizeString_(claim.facility_id),
    updated_at: toIsoString_(claim.updated_at)
  };
}

function claimDetailForClient_(claim) {
  var facility = findRecord_('FACILITIES', 'facility_id', claim.facility_id);
  var tokenExpiry = claim.mobile_upload_token_expires_at
    ? new Date(claim.mobile_upload_token_expires_at).getTime()
    : 0;
  var mobileUploadActive = Boolean(normalizeString_(claim.mobile_upload_token_hash)) &&
    !claim.mobile_upload_token_revoked_at && isFinite(tokenExpiry) && tokenExpiry > Date.now() &&
    [CLAIM_STATUSES.COMPLETED, CLAIM_STATUSES.ARCHIVED].indexOf(normalizeString_(claim.status).toUpperCase()) < 0;
  return {
    claim_id: normalizeString_(claim.claim_id),
    claim_code: normalizeString_(claim.claim_code),
    facility_id: normalizeString_(claim.facility_id),
    facility_name: facility ? normalizeString_(facility.facility_name) : normalizeString_(claim.facility_id),
    patient_name: normalizeString_(claim.patient_name),
    patient_nik: normalizeString_(claim.patient_nik),
    patient_nik_masked: maskNik(claim.patient_nik),
    patient_birth_date: claimDateKey_(claim.patient_birth_date),
    examination_date: claimDateKey_(claim.examination_date),
    status: normalizeString_(claim.status).toUpperCase(),
    selected_document_count: Number(claim.selected_document_count || 0),
    pdf_version: Number(claim.pdf_version || 0),
    has_pdf: Boolean(normalizeString_(claim.final_pdf_file_id)),
    final_pdf_filename: normalizeString_(claim.final_pdf_filename),
    final_pdf_generated_at: toIsoString_(claim.final_pdf_generated_at),
    final_pdf_generated_by: normalizeEmail_(claim.final_pdf_generated_by),
    mobile_upload_active: mobileUploadActive,
    mobile_upload_expires_at: mobileUploadActive ? toIsoString_(claim.mobile_upload_token_expires_at) : '',
    created_at: toIsoString_(claim.created_at),
    updated_at: toIsoString_(claim.updated_at),
    completed_at: toIsoString_(claim.completed_at),
    archived_at: toIsoString_(claim.archived_at)
  };
}

function facilityNameMap_() {
  var map = {};
  readAllRecords_('FACILITIES').forEach(function (facility) {
    map[normalizeString_(facility.facility_id)] = normalizeString_(facility.facility_name);
  });
  return map;
}

function claimDateKey_(value) {
  if (!value) return '';
  if (value instanceof Date) return Utilities.formatDate(value, APP_CONFIG.TIMEZONE, 'yyyy-MM-dd');
  return normalizeString_(value).substring(0, 10);
}

function claimTimestamp_(value) {
  if (!value) return 0;
  var timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return isFinite(timestamp) ? timestamp : 0;
}

function isClaimStatus_(status) {
  return Object.keys(CLAIM_STATUSES).some(function (key) { return CLAIM_STATUSES[key] === status; });
}
