function setupApplication() {
  return withScriptLock_(function () {
    var properties = getScriptProperties_();
    var previousVersion = normalizeString_(properties.getProperty(SCRIPT_PROPERTY_KEYS.APP_VERSION));
    var effectiveAdmin = normalizeEmail_(Session.getEffectiveUser().getEmail());
    var activeInstaller = normalizeEmail_(Session.getActiveUser().getEmail());
    assert_(effectiveAdmin && validateEmail_(effectiveAdmin), 'ADMIN_IDENTITY_MISSING', 'Email administrator tidak dapat diverifikasi.');
    assert_(activeInstaller && activeInstaller === effectiveAdmin, 'SETUP_CALLER_DENIED', 'setupApplication() hanya boleh dijalankan langsung oleh administrator pemasang.');
    var configuredAdmin = normalizeEmail_(properties.getProperty(SCRIPT_PROPERTY_KEYS.ADMIN_EMAIL));
    assert_(!configuredAdmin || configuredAdmin === activeInstaller, 'SETUP_CALLER_DENIED', 'Akun ini bukan administrator pemasang yang dikonfigurasi.');

    var domain = effectiveAdmin.split('@')[1];
    var rootFolder = getOrCreateConfiguredFolder_(SCRIPT_PROPERTY_KEYS.ROOT_DRIVE_FOLDER_ID, APP_CONFIG.ROOT_FOLDER_NAME, null);
    var claimsFolder = getOrCreateConfiguredFolder_(SCRIPT_PROPERTY_KEYS.CLAIMS_FOLDER_ID, APP_CONFIG.CLAIMS_FOLDER_NAME, rootFolder);
    var systemFolder = getOrCreateConfiguredFolder_(SCRIPT_PROPERTY_KEYS.SYSTEM_FOLDER_ID, APP_CONFIG.SYSTEM_FOLDER_NAME, rootFolder);
    var orthancInboxFolder = getOrCreateConfiguredFolder_(SCRIPT_PROPERTY_KEYS.ORTHANC_INBOX_FOLDER_ID, 'ORTHANC_INBOX', systemFolder);
    var spreadsheet = getOrCreateDatabase_(systemFolder);

    Object.keys(SHEET_SCHEMAS).forEach(function (sheetName) {
      ensureSheetSchema_(spreadsheet, sheetName, SHEET_SCHEMAS[sheetName]);
    });
    removeUnusedDefaultSheet_(spreadsheet);
    spreadsheet.setSpreadsheetTimeZone(APP_CONFIG.TIMEZONE);

    properties.setProperties({
      DATABASE_SPREADSHEET_ID: spreadsheet.getId(),
      ROOT_DRIVE_FOLDER_ID: rootFolder.getId(),
      CLAIMS_FOLDER_ID: claimsFolder.getId(),
      SYSTEM_FOLDER_ID: systemFolder.getId(),
      ORTHANC_INBOX_FOLDER_ID: orthancInboxFolder.getId(),
      ORTHANC_BRIDGE_ID: properties.getProperty('ORTHANC_BRIDGE_ID') || createOrthancBridgeId_(),
      ADMIN_EMAIL: properties.getProperty('ADMIN_EMAIL') || effectiveAdmin,
      WORKSPACE_DOMAIN: properties.getProperty('WORKSPACE_DOMAIN') || domain,
      APP_NAME: properties.getProperty('APP_NAME') || APP_CONFIG.APP_NAME,
      APP_VERSION: APP_CONFIG.APP_VERSION,
      AUTH_MODE: APP_CONFIG.AUTH_MODE,
      MAX_IMAGE_DIMENSION: properties.getProperty('MAX_IMAGE_DIMENSION') || '2800',
      JPEG_QUALITY: properties.getProperty('JPEG_QUALITY') || '0.90',
      MOBILE_TOKEN_LIFETIME_MINUTES: properties.getProperty('MOBILE_TOKEN_LIFETIME_MINUTES') || '120',
      MAX_DOCUMENTS_PER_CLAIM: properties.getProperty('MAX_DOCUMENTS_PER_CLAIM') || '30',
      MAX_PDF_SIZE_MB: properties.getProperty('MAX_PDF_SIZE_MB') || '10',
      APP_SESSION_HOURS: properties.getProperty('APP_SESSION_HOURS') || '8',
      PASSWORD_PEPPER: properties.getProperty('PASSWORD_PEPPER') || createSecureToken_(),
      PASSWORD_HASH_ITERATIONS: properties.getProperty('PASSWORD_HASH_ITERATIONS') || '12000',
      LOGIN_MAX_ATTEMPTS: properties.getProperty('LOGIN_MAX_ATTEMPTS') || '5',
      LOGIN_LOCK_MINUTES: properties.getProperty('LOGIN_LOCK_MINUTES') || '15',
      TIMEZONE: APP_CONFIG.TIMEZONE
    }, false);

    ensureDefaultFacility_();
    ensureBootstrapAdmin_(effectiveAdmin);
    ensureDefaultSettings_(effectiveAdmin);
    if (previousVersion && previousVersion !== APP_CONFIG.APP_VERSION) revokeAllSessionsForAuthMigration_();
    SpreadsheetApp.flush();

    return {
      success: true,
      appVersion: APP_CONFIG.APP_VERSION,
      databaseSpreadsheetId: spreadsheet.getId(),
      rootDriveFolderId: rootFolder.getId(),
      claimsFolderId: claimsFolder.getId(),
      systemFolderId: systemFolder.getId(),
      orthancInboxFolderId: orthancInboxFolder.getId(),
      adminEmail: effectiveAdmin,
      workspaceDomain: properties.getProperty('WORKSPACE_DOMAIN') || domain,
      sheets: Object.keys(SHEET_SCHEMAS),
      message: 'Setup selesai. Verifikasi hasil dan lanjutkan deployment sesuai docs/DEPLOYMENT.md.'
    };
  });
}

function getOrCreateConfiguredFolder_(propertyKey, folderName, parentFolder) {
  var properties = getScriptProperties_();
  var configuredId = normalizeString_(properties.getProperty(propertyKey));
  if (configuredId) {
    try {
      return DriveApp.getFolderById(configuredId);
    } catch (error) {
      throw appError_('FOLDER_CONFIGURATION_INVALID', propertyKey + ' sudah diatur tetapi tidak dapat dibuka. Perbaiki properti; folder baru tidak dibuat.');
    }
  }
  var iterator = parentFolder
    ? parentFolder.getFoldersByName(folderName)
    : DriveApp.getRootFolder().getFoldersByName(folderName);
  var folder = iterator.hasNext()
    ? iterator.next()
    : (parentFolder ? parentFolder.createFolder(folderName) : DriveApp.createFolder(folderName));
  assert_(!iterator.hasNext(), 'AMBIGUOUS_FOLDER', 'Lebih dari satu folder ' + folderName + ' ditemukan. Atur ' + propertyKey + ' secara manual.');
  properties.setProperty(propertyKey, folder.getId());
  return folder;
}

function getOrCreateDatabase_(systemFolder) {
  var properties = getScriptProperties_();
  var configuredId = normalizeString_(properties.getProperty(SCRIPT_PROPERTY_KEYS.DATABASE_SPREADSHEET_ID));
  if (configuredId) {
    try {
      return SpreadsheetApp.openById(configuredId);
    } catch (error) {
      throw appError_('DATABASE_CONFIGURATION_INVALID', 'DATABASE_SPREADSHEET_ID sudah diatur tetapi tidak dapat dibuka. Perbaiki properti; database baru tidak dibuat untuk melindungi data.');
    }
  }
  var files = systemFolder.getFilesByName(APP_CONFIG.DATABASE_NAME);
  var existingFile = files.hasNext() ? files.next() : null;
  assert_(!files.hasNext(), 'AMBIGUOUS_DATABASE', 'Lebih dari satu database bernama sama ditemukan. Atur DATABASE_SPREADSHEET_ID secara manual.');
  var spreadsheet;
  if (existingFile) {
    try {
      spreadsheet = SpreadsheetApp.openById(existingFile.getId());
    } catch (error) {
      throw appError_('DATABASE_FILE_INVALID', 'Berkas database yang ditemukan bukan Google Spreadsheet yang dapat dibuka.');
    }
  } else {
    spreadsheet = SpreadsheetApp.create(APP_CONFIG.DATABASE_NAME);
    DriveApp.getFileById(spreadsheet.getId()).moveTo(systemFolder);
  }
  properties.setProperty(SCRIPT_PROPERTY_KEYS.DATABASE_SPREADSHEET_ID, spreadsheet.getId());
  return spreadsheet;
}

function removeUnusedDefaultSheet_(spreadsheet) {
  var defaultSheet = spreadsheet.getSheetByName('Sheet1');
  if (defaultSheet && spreadsheet.getSheets().length > 1 && defaultSheet.getLastRow() === 0 && defaultSheet.getLastColumn() === 0) {
    spreadsheet.deleteSheet(defaultSheet);
  }
}

function ensureDefaultFacility_() {
  if (!findRecord_('FACILITIES', 'facility_id', APP_CONFIG.DEFAULT_FACILITY_ID)) {
    appendRecord_('FACILITIES', {
      facility_id: APP_CONFIG.DEFAULT_FACILITY_ID,
      facility_name: APP_CONFIG.DEFAULT_FACILITY_NAME,
      active: true,
      created_at: now_()
    });
  }
}

function ensureBootstrapAdmin_(adminEmail) {
  var existing = findUserByEmail_(adminEmail);
  if (existing) {
    assert_(normalizeBoolean_(existing.active) && normalizeString_(existing.role).toUpperCase() === ROLES.ADMIN,
      'BOOTSTRAP_ADMIN_CONFLICT', 'Email pemasang sudah ada tetapi bukan ADMIN aktif. Data tidak diubah.');
    return;
  }
  var timestamp = now_();
  appendRecord_('USERS', {
    user_id: 'USR_' + Utilities.getUuid(),
    google_email: adminEmail,
    full_name: 'Administrator',
    role: ROLES.ADMIN,
    facility_id: APP_CONFIG.DEFAULT_FACILITY_ID,
    active: true,
    can_create_claim: true,
    can_view_all_claims: true,
    can_generate_pdf: true,
    can_download_pdf: true,
    can_manage_users: true,
    created_at: timestamp,
    created_by: adminEmail,
    updated_at: timestamp,
    updated_by: adminEmail
  });
}

function ensureDefaultSettings_(adminEmail) {
  DEFAULT_SETTINGS.forEach(function (setting) {
    if (!findRecord_('SETTINGS', 'setting_key', setting[0])) {
      appendRecord_('SETTINGS', {
        setting_key: setting[0],
        setting_value: setting[1],
        description: setting[2],
        updated_at: now_(),
        updated_by: adminEmail
      });
    }
  });
}

function revokeAllSessionsForAuthMigration_() {
  readAllRecords_('AUTH_SESSIONS').forEach(function (session) {
    if (!session.revoked_at) updateRecord_('AUTH_SESSIONS', session._rowNumber, { revoked_at: now_() });
  });
}
