function listUsersAdmin(sessionToken) {
  try {
    requireRole(ROLES.ADMIN, sessionToken);
    var credentialsByUser = {};
    readAllRecords_('AUTH_CREDENTIALS').forEach(function (credential) {
      credentialsByUser[normalizeString_(credential.user_id)] = credential;
    });
    return success_(readAllRecords_('USERS').map(function (record) {
      delete record._rowNumber;
      var user = serializeForClient_(normalizeUserRecord_(record));
      var credential = credentialsByUser[user.user_id];
      user.auth_username = credential ? normalizeString_(credential.username) : '';
      user.has_password = Boolean(credential);
      user.must_change_password = credential ? normalizeBoolean_(credential.must_change_password) : false;
      return user;
    }));
  } catch (error) {
    return publicError_(error);
  }
}

function listFacilitiesAdmin(sessionToken) {
  try {
    requireRole(ROLES.ADMIN, sessionToken);
    return success_(readAllRecords_('FACILITIES').map(function (record) {
      delete record._rowNumber;
      record.active = normalizeBoolean_(record.active);
      return serializeForClient_(record);
    }));
  } catch (error) {
    return publicError_(error);
  }
}

function saveUserAdmin(sessionToken, payload) {
  try {
    var actor = requireRole(ROLES.ADMIN, sessionToken);
    var saved = withScriptLock_(function () {
      return saveUserAdminLocked_(actor, payload || {});
    });
    writeAudit_(actor, saved.created ? 'USER_CREATED' : 'USER_UPDATED', '', '', {
      target_user_id: saved.user.user_id,
      target_email: saved.user.google_email,
      target_role: saved.user.role,
      target_active: saved.user.active
    });
    return success_(saved.user);
  } catch (error) {
    return publicError_(error);
  }
}

function deleteUserAdmin(sessionToken, userId) {
  try {
    var actor = requireRole(ROLES.ADMIN, sessionToken);
    var targetId = normalizeString_(userId);
    assert_(targetId, 'USER_REQUIRED', 'Pengguna yang akan dihapus wajib dipilih.');
    var deleted = withScriptLock_(function () {
      var target = findRecord_('USERS', 'user_id', targetId);
      assert_(target, 'USER_NOT_FOUND', 'Pengguna tidak ditemukan atau sudah dihapus.');
      assert_(normalizeString_(actor.user_id) !== targetId,
        'SELF_DELETE_BLOCKED', 'Administrator tidak dapat menghapus akun yang sedang digunakan.');
      assert_(!hasUserOperationalActivity_(target),
        'USER_HAS_ACTIVITY', 'Pengguna sudah memiliki riwayat klaim atau dokumen. Nonaktifkan akun ini; jangan menghapusnya.');

      var credential = findRecord_('AUTH_CREDENTIALS', 'user_id', targetId);
      getSheet_('USERS').deleteRow(target._rowNumber);
      deleteRecordsByField_('AUTH_SESSIONS', 'user_id', targetId);
      deleteRecordsByField_('AUTH_CREDENTIALS', 'user_id', targetId);
      return {
        user_id: targetId,
        google_email: normalizeEmail_(target.google_email),
        full_name: normalizeString_(target.full_name),
        role: normalizeString_(target.role),
        username: credential ? normalizeString_(credential.username) : ''
      };
    });
    writeAudit_(actor, 'USER_DELETED', '', '', {
      target_user_id: deleted.user_id,
      target_email: deleted.google_email,
      target_full_name: deleted.full_name,
      target_role: deleted.role,
      target_username: deleted.username
    });
    return success_(deleted);
  } catch (error) {
    return publicError_(error);
  }
}

function hasUserOperationalActivity_(user) {
  var email = normalizeEmail_(user.google_email);
  var claimFields = ['created_by', 'updated_by', 'final_pdf_generated_by'];
  var documentFields = ['uploaded_by', 'updated_by', 'deleted_by'];
  return recordsContainEmail_('CLAIMS', claimFields, email) ||
    recordsContainEmail_('DOCUMENTS', documentFields, email);
}

function recordsContainEmail_(sheetName, fields, email) {
  if (!email) return false;
  return readAllRecords_(sheetName).some(function (record) {
    return fields.some(function (field) { return normalizeEmail_(record[field]) === email; });
  });
}

function deleteRecordsByField_(sheetName, field, value) {
  var expected = normalizeString_(value);
  var rowNumbers = readAllRecords_(sheetName).filter(function (record) {
    return normalizeString_(record[field]) === expected;
  }).map(function (record) {
    return record._rowNumber;
  }).sort(function (left, right) {
    return right - left;
  });
  var sheet = getSheet_(sheetName);
  rowNumbers.forEach(function (rowNumber) { sheet.deleteRow(rowNumber); });
  return rowNumbers.length;
}

function saveUserAdminLocked_(actor, payload) {
  var targetUserId = normalizeString_(payload.user_id);
  var email = normalizeEmail_(payload.google_email);
  var fullName = sanitizePlainText_(payload.full_name, 120);
  var role = normalizeString_(payload.role).toUpperCase();
  var facilityId = normalizeString_(payload.facility_id);
  var active = normalizeBoolean_(payload.active);
  assert_(validateEmail_(email), 'INVALID_EMAIL', 'Email kontak tidak valid.');
  assert_(fullName, 'NAME_REQUIRED', 'Nama pengguna wajib diisi.');
  assert_([ROLES.ADMIN, ROLES.STAFF].indexOf(role) >= 0, 'INVALID_ROLE', 'Peran pengguna tidak valid.');
  var facility = findRecord_('FACILITIES', 'facility_id', facilityId);
  assert_(facility && normalizeBoolean_(facility.active), 'INVALID_FACILITY', 'Fasilitas tidak aktif atau tidak ditemukan.');

  var existing = targetUserId ? findRecord_('USERS', 'user_id', targetUserId) : findUserByEmail_(email);
 
  assert_(!targetUserId || existing, 'USER_NOT_FOUND', 'Pengguna yang diedit tidak ditemukan.');
  assert_(!existing || normalizeEmail_(existing.google_email) === email,
    'USER_EMAIL_IMMUTABLE', 'Email kontak tidak dapat diubah. Nonaktifkan pengguna lama dan tambahkan pengguna baru.');
  if (existing && email === actor.google_email) {
    assert_(active && role === ROLES.ADMIN, 'SELF_LOCKOUT_BLOCKED', 'Administrator tidak dapat menonaktifkan atau menurunkan perannya sendiri.');
  }
  var timestamp = now_();
  var userId = existing ? normalizeString_(existing.user_id) : 'USR_' + Utilities.getUuid();
  assert_(!payload.password || String(payload.password) === String(payload.password_confirmation || ''),
    'PASSWORD_CONFIRMATION_MISMATCH', 'Konfirmasi kata sandi tidak sama.');
  var preparedCredential = prepareCredentialUpdate_(userId, payload.username, payload.password);
  payload.password = '';
  payload.password_confirmation = '';
  var values = {
    google_email: email,
    full_name: fullName,
    role: role,
    facility_id: facilityId,
    active: active,
    can_create_claim: role === ROLES.ADMIN || normalizeBoolean_(payload.can_create_claim),
    can_view_all_claims: role === ROLES.ADMIN || normalizeBoolean_(payload.can_view_all_claims),
    can_generate_pdf: role === ROLES.ADMIN || normalizeBoolean_(payload.can_generate_pdf),
    can_download_pdf: role === ROLES.ADMIN || normalizeBoolean_(payload.can_download_pdf),
    can_send_whatsapp: role === ROLES.ADMIN || normalizeBoolean_(payload.can_send_whatsapp),
    can_manage_users: role === ROLES.ADMIN,
    updated_at: timestamp,
    updated_by: actor.google_email
  };
  if (existing) {
    updateRecord_('USERS', existing._rowNumber, values);
    applyCredentialUpdate_(userId, preparedCredential);
    values.user_id = userId;
    values.created_at = existing.created_at;
    values.created_by = existing.created_by;
    return { created: false, user: serializeForClient_(normalizeUserRecord_(values)) };
  }
  values.user_id = userId;
  values.created_at = timestamp;
  values.created_by = actor.google_email;
  appendRecord_('USERS', values);
  applyCredentialUpdate_(userId, preparedCredential);
  return { created: true, user: serializeForClient_(normalizeUserRecord_(values)) };
}
