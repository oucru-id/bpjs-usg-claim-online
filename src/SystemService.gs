function runSystemDiagnostics(sessionToken) {
  try {
    var user = requireRole(ROLES.ADMIN, sessionToken);
    var results = [];
    function check(name, callback) {
      try {
        callback();
        results.push({ name: name, ok: true, message: 'OK' });
      } catch (error) {
        results.push({ name: name, ok: false, message: error.message || 'Gagal' });
      }
    }
    check('Spreadsheet database', function () { getDatabase_().getId(); });
    Object.keys(SHEET_SCHEMAS).forEach(function (sheetName) {
      check('Lembar ' + sheetName, function () { getSheet_(sheetName).getName(); });
    });
    check('Folder Drive utama', function () { DriveApp.getFolderById(getRequiredProperty_(SCRIPT_PROPERTY_KEYS.ROOT_DRIVE_FOLDER_ID)).getName(); });
    check('Folder Drive klaim', function () { DriveApp.getFolderById(getRequiredProperty_(SCRIPT_PROPERTY_KEYS.CLAIMS_FOLDER_ID)).getName(); });
    check('Folder penampungan Orthanc', function () { DriveApp.getFolderById(getRequiredProperty_(SCRIPT_PROPERTY_KEYS.ORTHANC_INBOX_FOLDER_ID)).getName(); });
    check('Akun administrator saat ini', function () { assert_(user.role === ROLES.ADMIN, 'NOT_ADMIN', 'Bukan administrator.'); });
    check('Rahasia pengaman kata sandi', function () { getRequiredProperty_(SCRIPT_PROPERTY_KEYS.PASSWORD_PEPPER); });
    check('Iterasi hash kata sandi', function () { getPasswordIterations_(); });
    check('Penguncian percobaan masuk', function () {
      assert_(Number(getRequiredProperty_(SCRIPT_PROPERTY_KEYS.LOGIN_MAX_ATTEMPTS)) >= 3, 'LOCKOUT_INVALID', 'LOGIN_MAX_ATTEMPTS terlalu kecil.');
      assert_(Number(getRequiredProperty_(SCRIPT_PROPERTY_KEYS.LOGIN_LOCK_MINUTES)) >= 1, 'LOCKOUT_INVALID', 'LOGIN_LOCK_MINUTES tidak valid.');
    });
    check('Zona waktu terkonfigurasi', function () {
      assert_(getRequiredProperty_(SCRIPT_PROPERTY_KEYS.TIMEZONE) === APP_CONFIG.TIMEZONE, 'TIMEZONE_MISMATCH', 'Timezone harus Asia/Makassar.');
    });
    check('Konfigurasi OrthancBridge', function () {
      var enabled = getBooleanSetting_('ENABLE_ORTHANC_BRIDGE', false);
      if (enabled) {
        getRequiredProperty_(SCRIPT_PROPERTY_KEYS.ORTHANC_BRIDGE_ID);
        getRequiredProperty_(SCRIPT_PROPERTY_KEYS.ORTHANC_BRIDGE_SECRET_HASH);
      }
    });
    writeAudit_(user, 'SYSTEM_DIAGNOSTICS_RUN', '', '', {
      passed: results.filter(function (item) { return item.ok; }).length,
      total: results.length
    });
    return success_({
      appName: getRequiredProperty_(SCRIPT_PROPERTY_KEYS.APP_NAME),
      appVersion: getRequiredProperty_(SCRIPT_PROPERTY_KEYS.APP_VERSION),
      authMode: APP_CONFIG.AUTH_MODE,
      timezone: getRequiredProperty_(SCRIPT_PROPERTY_KEYS.TIMEZONE),
      maxImageDimension: getRequiredProperty_(SCRIPT_PROPERTY_KEYS.MAX_IMAGE_DIMENSION),
      mobileTokenMinutes: getRequiredProperty_(SCRIPT_PROPERTY_KEYS.MOBILE_TOKEN_LIFETIME_MINUTES),
      maxDocumentsPerClaim: getRequiredProperty_(SCRIPT_PROPERTY_KEYS.MAX_DOCUMENTS_PER_CLAIM),
      maxPdfSizeMb: getRequiredProperty_(SCRIPT_PROPERTY_KEYS.MAX_PDF_SIZE_MB),
      currentUser: user.google_email,
      checks: results
    });
  } catch (error) {
    return publicError_(error);
  }
}
