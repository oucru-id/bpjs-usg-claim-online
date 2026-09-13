function doGet(e) {
  try {
    var parameters = e && e.parameter ? e.parameter : {};
    return renderApplication_(parameters.view || 'dashboard', parameters.claimId || '', parameters.token || '');
  } catch (error) {
    return renderAccessDenied_(error);
  }
}

function doPost(e) {
  var response;
  try {
    assert_(e && e.postData && normalizeString_(e.postData.contents),
      'BRIDGE_REQUEST_EMPTY', 'Permintaan OrthancBridge kosong.');
    var payload = JSON.parse(e.postData.contents);
    response = receiveOrthancBridgeRequest_(payload);
  } catch (error) {
    response = publicError_(error);
  }
  return ContentService.createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}

function renderApplication_(requestedView, requestedClaimId, requestedMobileToken) {
  var template = HtmlService.createTemplateFromFile('Index');
  template.initialView = sanitizeView_(requestedView);
  template.initialClaimId = sanitizeClaimId_(requestedClaimId);
  template.initialMobileToken = sanitizeMobileToken_(requestedMobileToken);
  return template.evaluate()
    .setTitle(APP_CONFIG.APP_NAME)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function renderAccessDenied_(error) {
  var denied = HtmlService.createTemplateFromFile('AccessDenied');
  denied.errorMessage = error && error.message ? error.message : 'Aplikasi tidak dapat dimuat.';
  return denied.evaluate()
    .setTitle('BPJS USG')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include_(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function includeOptional_(filename) {
  try {
    return include_(filename);
  } catch (error) {
    console.warn(JSON.stringify({ code: 'OPTIONAL_HTML_MISSING', filename: filename }));
    return '';
  }
}

function sanitizeView_(requestedView) {
  var view = normalizeString_(requestedView).toLowerCase();
  return ['dashboard', 'claim', 'mobile', 'orthanc', 'users', 'system'].indexOf(view) >= 0 ? view : 'dashboard';
}

function sanitizeMobileToken_(token) {
  var value = normalizeString_(token);
  return /^[0-9a-f]{96}$/i.test(value) ? value : '';
}

function sanitizeClaimId_(claimId) {
  var value = normalizeString_(claimId);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : '';
}

function getAppBootstrap(sessionToken) {
  try {
    var user = requireAuthenticatedUser(sessionToken, true);
    var facility = user.facility_id ? findRecord_('FACILITIES', 'facility_id', user.facility_id) : null;
    return success_({
      appName: getRequiredProperty_(SCRIPT_PROPERTY_KEYS.APP_NAME),
      appVersion: getRequiredProperty_(SCRIPT_PROPERTY_KEYS.APP_VERSION),
      authMode: user._authMode,
      mustChangePassword: Boolean(user._mustChangePassword),
      features: {
        mobile_qr_upload: getBooleanSetting_('ENABLE_MOBILE_QR_UPLOAD', false),
        orthanc_bridge: getBooleanSetting_('ENABLE_ORTHANC_BRIDGE', false) &&
          Boolean(normalizeString_(getScriptProperties_().getProperty(SCRIPT_PROPERTY_KEYS.ORTHANC_BRIDGE_SECRET_HASH)))
      },
      user: {
        user_id: user.user_id,
        google_email: user.google_email,
        full_name: user.full_name,
        role: user.role,
        facility_id: user.facility_id,
        facility_name: facility ? facility.facility_name : '',
        can_create_claim: user.role === ROLES.ADMIN || Boolean(user.can_create_claim),
        can_view_all_claims: user.role === ROLES.ADMIN || Boolean(user.can_view_all_claims),
        can_generate_pdf: user.role === ROLES.ADMIN || Boolean(user.can_generate_pdf),
        can_download_pdf: user.role === ROLES.ADMIN || Boolean(user.can_download_pdf),
        can_manage_users: user.role === ROLES.ADMIN
      }
    });
  } catch (error) {
    return publicError_(error);
  }
}
