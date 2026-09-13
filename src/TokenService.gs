function createMobileUploadToken(sessionToken, claimId) {
  try {
    var user = requireAuthenticatedUser(sessionToken);
    assert_(getBooleanSetting_('ENABLE_MOBILE_QR_UPLOAD', false), 'FEATURE_DISABLED',
      'Unggah menggunakan QR sedang dinonaktifkan. Buka klaim langsung dari ponsel.');
    var rawToken = createSecureToken_();
    var tokenHash = hashToken_(rawToken);
    var result = withScriptLock_(function () {
      var claim = requireAccessibleClaim_(user, claimId);
      assertClaimAcceptsDocuments_(claim);
      var minutes = mobileTokenLifetimeMinutes_();
      var timestamp = now_();
      var expiresAt = new Date(timestamp.getTime() + minutes * 60 * 1000);
      updateRecord_('CLAIMS', claim._rowNumber, {
        mobile_upload_token_hash: tokenHash,
        mobile_upload_token_expires_at: expiresAt,
        mobile_upload_token_revoked_at: '',
        updated_by: user.google_email,
        updated_at: timestamp
      });
      return { claim: claim, expiresAt: expiresAt };
    });
    var baseUrl = normalizeString_(ScriptApp.getService().getUrl());
    assert_(baseUrl && /^https:\/\//i.test(baseUrl), 'WEB_APP_URL_UNAVAILABLE',
      'Alamat aplikasi belum tersedia. Pastikan aplikasi sudah di-deploy sebagai aplikasi web.');
    var uploadUrl = baseUrl + '?view=mobile&token=' + encodeURIComponent(rawToken);
    writeAudit_(user, 'MOBILE_UPLOAD_TOKEN_CREATED', result.claim.claim_id, '', {
      claim_code: result.claim.claim_code,
      expires_at: result.expiresAt.toISOString()
    });
    return success_({ upload_url: uploadUrl, expires_at: result.expiresAt.toISOString() });
  } catch (error) {
    return publicError_(error);
  }
}

function getMobileUploadContext(sessionToken, rawToken) {
  try {
    var user = requireAuthenticatedUser(sessionToken);
    var claim = requireValidMobileToken_(user, rawToken);
    var facility = findRecord_('FACILITIES', 'facility_id', claim.facility_id);
    return success_({
      claim_code: normalizeString_(claim.claim_code),
      patient_name_masked: maskPatientName(claim.patient_name),
      examination_date: claimDateKey_(claim.examination_date),
      facility_name: facility ? normalizeString_(facility.facility_name) : normalizeString_(claim.facility_id),
      expires_at: toIsoString_(claim.mobile_upload_token_expires_at)
    });
  } catch (error) {
    return publicError_(error);
  }
}

function finishMobileUpload(sessionToken, rawToken) {
  try {
    var user = requireAuthenticatedUser(sessionToken);
    var claim = withScriptLock_(function () {
      var activeClaim = requireValidMobileToken_(user, rawToken);
      var timestamp = now_();
      updateRecord_('CLAIMS', activeClaim._rowNumber, {
        mobile_upload_token_revoked_at: timestamp,
        updated_by: user.google_email,
        updated_at: timestamp
      });
      return activeClaim;
    });
    writeAudit_(user, 'MOBILE_UPLOAD_FINISHED', claim.claim_id, '', { claim_code: claim.claim_code });
    return success_({ message: 'Unggah dari ponsel telah selesai.' });
  } catch (error) {
    return publicError_(error);
  }
}

function requireValidMobileToken_(user, rawToken) {
  assert_(getBooleanSetting_('ENABLE_MOBILE_QR_UPLOAD', false), 'FEATURE_DISABLED',
    'Unggah menggunakan QR sedang dinonaktifkan. Buka klaim langsung dari ponsel.');
  var token = normalizeString_(rawToken);
  assert_(/^[0-9a-f]{96}$/i.test(token), 'MOBILE_TOKEN_INVALID', 'Tautan unggah tidak valid.');
  var expectedHash = hashToken_(token);
  var claims = readAllRecords_('CLAIMS');
  var claim = null;
  for (var i = 0; i < claims.length; i += 1) {
    if (constantTimeEquals_(normalizeString_(claims[i].mobile_upload_token_hash), expectedHash)) {
      claim = claims[i];
      break;
    }
  }
  assert_(claim, 'MOBILE_TOKEN_INVALID', 'Tautan unggah tidak valid atau sudah diganti.');
  assert_(canAccessClaim(user, claim), 'CLAIM_ACCESS_DENIED', 'Anda tidak memiliki akses ke klaim ini.');
  assert_(!claim.mobile_upload_token_revoked_at, 'MOBILE_TOKEN_REVOKED', 'Tautan unggah sudah tidak aktif.');
  var expiresAt = new Date(claim.mobile_upload_token_expires_at).getTime();
  assert_(isFinite(expiresAt) && expiresAt > Date.now(), 'MOBILE_TOKEN_EXPIRED', 'Tautan unggah sudah kedaluwarsa.');
  assertClaimAcceptsDocuments_(claim);
  return claim;
}

function mobileTokenLifetimeMinutes_() {
  var setting = findRecord_('SETTINGS', 'setting_key', 'MOBILE_UPLOAD_TOKEN_MINUTES');
  var raw = setting ? setting.setting_value : getRequiredProperty_(SCRIPT_PROPERTY_KEYS.MOBILE_TOKEN_LIFETIME_MINUTES);
  var minutes = Number(raw);
  return isFinite(minutes) && minutes >= 5 && minutes <= 1440 ? Math.floor(minutes) : 120;
}
