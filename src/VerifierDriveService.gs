var VERIFIER_FOLDER_NAMES = Object.freeze({
  CLAIMS: 'KLAIM'
});

function verifierDriveDeliveryEnabled_() {
  return getBooleanSetting_('ENABLE_VERIFIER_DRIVE_DELIVERY', false);
}

function getVerifierDriveRoot_() {
  var folderId = getRequiredProperty_(SCRIPT_PROPERTY_KEYS.VERIFIER_DRIVE_FOLDER_ID);
  try {
    return DriveApp.getFolderById(folderId);
  } catch (error) {
    throw appError_('VERIFIER_FOLDER_UNAVAILABLE',
      'Folder Drive verifikator tidak dapat dibuka. Pastikan folder dibagikan sebagai Editor kepada akun deployment.');
  }
}

function assertVerifierDriveIsDistinct_(folder) {
  var verifierId = folder.getId();
  var primaryId = normalizeString_(getScriptProperties_().getProperty(SCRIPT_PROPERTY_KEYS.ROOT_DRIVE_FOLDER_ID));
  var backupId = normalizeString_(getScriptProperties_().getProperty(SCRIPT_PROPERTY_KEYS.BACKUP_DRIVE_FOLDER_ID));
  assert_(verifierId !== primaryId, 'VERIFIER_FOLDER_NOT_DISTINCT',
    'Folder Drive verifikator harus berbeda dari folder Drive utama aplikasi.');
  assert_(!backupId || verifierId !== backupId, 'VERIFIER_FOLDER_NOT_DISTINCT',
    'Folder Drive verifikator harus berbeda dari folder Drive cadangan.');
}

function getVerifierDriveClaimsFolder_() {
  var root = getVerifierDriveRoot_();
  assertVerifierDriveIsDistinct_(root);
  var matches = root.getFoldersByName(VERIFIER_FOLDER_NAMES.CLAIMS);
  var folder = matches.hasNext() ? matches.next() : root.createFolder(VERIFIER_FOLDER_NAMES.CLAIMS);
  assert_(!matches.hasNext(), 'VERIFIER_FOLDER_AMBIGUOUS',
    'Lebih dari satu subfolder verifikator bernama ' + VERIFIER_FOLDER_NAMES.CLAIMS + ' ditemukan.');
  return folder;
}

function verifierDeliveryErrorMessage_(error) {
  return sanitizePlainText_(error && error.message ? error.message :
    'Pengiriman ke Drive verifikator gagal tanpa pesan.', 300);
}

function recordVerifierDeliveryErrorSafely_(claimId, message) {
  try {
    withScriptLock_(function () {
      var current = findRecord_('CLAIMS', 'claim_id', claimId);
      if (current) updateRecord_('CLAIMS', current._rowNumber, {
        verifier_pdf_status: 'ERROR', verifier_pdf_error: message
      });
    });
  } catch (ignored) {
    // Delivery status is best effort so a metadata/schema problem never removes the primary PDF.
  }
}

function deliverClaimPdfToVerifierSafely_(claim, sourceFile) {
  if (!verifierDriveDeliveryEnabled_()) {
    return { status: 'DISABLED', filename: '' };
  }
  var verifierFile = null;
  var logicalFilename = '';
  var storedFilename = '';
  try {
    assert_(sourceFile && !sourceFile.isTrashed(), 'VERIFIER_PDF_SOURCE_MISSING',
      'PDF utama tidak tersedia untuk dikirim ke Drive verifikator.');
    var version = Math.max(1, Number(claim.pdf_version) || 1);
    logicalFilename = claimPdfFilename_(claim, version);
    storedFilename = logicalFilename;
    var previousFile = accessibleDriveFile_(claim.verifier_pdf_file_id);
    if (previousFile && previousFile.getName() === storedFilename &&
        Number(previousFile.getSize()) === Number(sourceFile.getSize())) {
      withScriptLock_(function () {
        var current = findRecord_('CLAIMS', 'claim_id', claim.claim_id);
        if (current) updateRecord_('CLAIMS', current._rowNumber, {
          verifier_pdf_filename: logicalFilename,
          verifier_pdf_storage_filename: storedFilename,
          verifier_pdf_url: previousFile.getUrl(),
          verifier_pdf_status: 'READY', verifier_pdf_error: '', verifier_pdf_at: now_()
        });
      });
      return { status: 'READY', filename: logicalFilename, storageFilename: storedFilename, duplicate: true };
    }
    verifierFile = sourceFile.makeCopy(storedFilename, getVerifierDriveClaimsFolder_());
    withScriptLock_(function () {
      var current = findRecord_('CLAIMS', 'claim_id', claim.claim_id);
      assert_(current, 'CLAIM_NOT_FOUND', 'Klaim tidak ditemukan saat menyimpan status pengiriman verifikator.');
      updateRecord_('CLAIMS', current._rowNumber, {
        verifier_pdf_file_id: verifierFile.getId(),
        verifier_pdf_filename: logicalFilename,
        verifier_pdf_storage_filename: storedFilename,
        verifier_pdf_url: verifierFile.getUrl(),
        verifier_pdf_at: now_(),
        verifier_pdf_status: 'READY',
        verifier_pdf_error: ''
      });
    });
    return { status: 'READY', filename: logicalFilename, storageFilename: storedFilename };
  } catch (error) {
    trashDriveFile_(verifierFile);
    var message = verifierDeliveryErrorMessage_(error);
    recordVerifierDeliveryErrorSafely_(claim.claim_id, message);
    return { status: 'ERROR', filename: logicalFilename, storageFilename: storedFilename, message: message };
  }
}

function validateVerifierDriveConfiguration() {
  var activeUser = normalizeEmail_(Session.getActiveUser().getEmail());
  var adminEmail = normalizeEmail_(getRequiredProperty_(SCRIPT_PROPERTY_KEYS.ADMIN_EMAIL));
  assert_(activeUser && activeUser === adminEmail, 'VERIFIER_CONFIGURATION_DENIED',
    'Konfigurasi Drive verifikator hanya boleh divalidasi oleh administrator pemasang.');
  var root = getVerifierDriveRoot_();
  assertVerifierDriveIsDistinct_(root);
  var claimsFolder = getVerifierDriveClaimsFolder_();
  var probe = null;
  try {
    probe = claimsFolder.createFile('VALIDASI_AKSES.txt', 'Validasi akses tulis aplikasi BPJS USG.');
    assert_(probe && probe.getId(), 'VERIFIER_FOLDER_NOT_WRITABLE',
      'Folder Drive verifikator tidak dapat ditulisi oleh akun deployment.');
  } finally {
    trashDriveFile_(probe);
  }
  var setting = findRecord_('SETTINGS', 'setting_key', 'ENABLE_VERIFIER_DRIVE_DELIVERY');
  assert_(setting, 'VERIFIER_SETTING_MISSING', 'Jalankan setupApplication() terlebih dahulu.');
  updateRecord_('SETTINGS', setting._rowNumber, {
    setting_value: 'true', updated_at: now_(), updated_by: activeUser
  });
  return { success: true, folderId: root.getId(), folderName: root.getName(), enabled: true };
}

function renameExistingVerifierPdfFiles() {
  var activeUser = normalizeEmail_(Session.getActiveUser().getEmail());
  var adminEmail = normalizeEmail_(getRequiredProperty_(SCRIPT_PROPERTY_KEYS.ADMIN_EMAIL));
  assert_(activeUser && activeUser === adminEmail, 'VERIFIER_RENAME_DENIED',
    'Penggantian nama PDF verifikator hanya boleh dijalankan oleh administrator pemasang.');
  assert_(verifierDriveDeliveryEnabled_(), 'VERIFIER_DELIVERY_DISABLED',
    'Pengiriman ke Drive verifikator belum diaktifkan.');
  var result = { success: true, checked: 0, renamed: 0, ready: 0, errors: 0 };
  readAllRecords_('CLAIMS').filter(function (claim) {
    return normalizeString_(claim.verifier_pdf_file_id);
  }).slice(0, 100).forEach(function (claim) {
    result.checked += 1;
    try {
      var file = accessibleDriveFile_(claim.verifier_pdf_file_id);
      assert_(file, 'VERIFIER_PDF_NOT_FOUND', 'PDF verifikator tidak dapat dibuka.');
      var version = Math.max(1, Number(claim.pdf_version) || 1);
      var readableFilename = claimPdfFilename_(claim, version);
      if (file.getName() !== readableFilename) {
        file.setName(readableFilename);
        result.renamed += 1;
      }
      updateRecord_('CLAIMS', claim._rowNumber, {
        verifier_pdf_filename: readableFilename,
        verifier_pdf_storage_filename: readableFilename,
        verifier_pdf_url: file.getUrl(),
        verifier_pdf_status: 'READY',
        verifier_pdf_error: ''
      });
      result.ready += 1;
    } catch (error) {
      result.errors += 1;
      recordVerifierDeliveryErrorSafely_(claim.claim_id, verifierDeliveryErrorMessage_(error));
    }
  });
  return result;
}
