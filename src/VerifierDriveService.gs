var VERIFIER_MONTH_NAMES = Object.freeze([
  'JANUARI', 'FEBRUARI', 'MARET', 'APRIL', 'MEI', 'JUNI',
  'JULI', 'AGUSTUS', 'SEPTEMBER', 'OKTOBER', 'NOVEMBER', 'DESEMBER'
]);

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

function verifierClaimPdfFilename_(claim) {
  var facility = findRecord_('FACILITIES', 'facility_id', claim.facility_id);
  var facilityName = facility ? normalizeString_(facility.facility_name) : normalizeString_(claim.facility_id);
  var facilitySegment = backupFilenameSegment_(facilityName, claim.facility_id).toUpperCase()
    .replace(/^(PUSKESMAS|PKM)_+/, '');
  var examinationDate = claimDateKey_(claim.examination_date).replace(/-/g, '');
  var patientName = backupFilenameSegment_(claim.patient_name, 'TIDAK_DIKETAHUI').toUpperCase();
  var nik = normalizeString_(claim.patient_nik).replace(/\D/g, '');
  var doctorName = normalizeString_(claim.doctor_name).replace(/^(DR|DOKTER)\.?\s*/i, '');
  var doctorSegment = backupFilenameSegment_(doctorName, 'TIDAK_DIKETAHUI').toUpperCase();
  assert_(facilitySegment, 'VERIFIER_FACILITY_MISSING', 'Nama Puskesmas untuk file verifikator belum tersedia.');
  assert_(/^\d{8}$/.test(examinationDate), 'VERIFIER_DATE_INVALID',
    'Tanggal pemeriksaan untuk file verifikator tidak valid.');
  assert_(/^\d{16}$/.test(nik), 'VERIFIER_NIK_INVALID', 'NIK untuk file verifikator tidak valid.');
  return 'KLAIM_USG_PKM_' + facilitySegment + '_' + examinationDate + '_' + patientName + '_' + nik +
    '_DR_' + doctorSegment + '.pdf';
}

function verifierMonthFolderName_(claim) {
  var dateKey = claimDateKey_(claim.examination_date);
  assert_(/^\d{4}-\d{2}-\d{2}$/.test(dateKey), 'VERIFIER_DATE_INVALID',
    'Tanggal pemeriksaan untuk folder verifikator tidak valid.');
  var year = dateKey.substring(0, 4);
  var monthIndex = Number(dateKey.substring(5, 7)) - 1;
  assert_(monthIndex >= 0 && monthIndex < VERIFIER_MONTH_NAMES.length, 'VERIFIER_DATE_INVALID',
    'Bulan pemeriksaan untuk folder verifikator tidak valid.');
  return VERIFIER_MONTH_NAMES[monthIndex] + ' ' + year;
}

function getVerifierDriveMonthFolder_(claim) {
  var root = getVerifierDriveRoot_();
  assertVerifierDriveIsDistinct_(root);
  var folderName = verifierMonthFolderName_(claim);
  var matches = root.getFoldersByName(folderName);
  var folder = matches.hasNext() ? matches.next() : root.createFolder(folderName);
  assert_(!matches.hasNext(), 'VERIFIER_MONTH_FOLDER_AMBIGUOUS',
    'Lebih dari satu folder verifikator bernama ' + folderName + ' ditemukan.');
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
    logicalFilename = verifierClaimPdfFilename_(claim);
    storedFilename = logicalFilename;
    var previousFile = accessibleDriveFile_(claim.verifier_pdf_file_id);
    verifierFile = sourceFile.makeCopy(storedFilename, getVerifierDriveMonthFolder_(claim));
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
    if (previousFile && previousFile.getId() !== verifierFile.getId() &&
        previousFile.getId() !== sourceFile.getId()) {
      trashDriveFile_(previousFile);
    }
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
  var probe = null;
  try {
    probe = root.createFile('VALIDASI_AKSES.txt', 'Validasi akses tulis aplikasi BPJS USG.');
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

function organizeExistingVerifierPdfFiles() {
  var activeUser = normalizeEmail_(Session.getActiveUser().getEmail());
  var adminEmail = normalizeEmail_(getRequiredProperty_(SCRIPT_PROPERTY_KEYS.ADMIN_EMAIL));
  assert_(activeUser && activeUser === adminEmail, 'VERIFIER_RENAME_DENIED',
    'Penataan PDF verifikator hanya boleh dijalankan oleh administrator pemasang.');
  assert_(verifierDriveDeliveryEnabled_(), 'VERIFIER_DELIVERY_DISABLED',
    'Pengiriman ke Drive verifikator belum diaktifkan.');
  var result = { success: true, checked: 0, renamed: 0, organized: 0, ready: 0, errors: 0, hasMore: false };
  var claims = readAllRecords_('CLAIMS').filter(function (claim) {
    return normalizeString_(claim.verifier_pdf_file_id);
  });
  for (var index = 0; index < claims.length; index += 1) {
    var claim = claims[index];
    if (result.checked >= 100) {
      result.hasMore = true;
      break;
    }
    var counted = false;
    try {
      var file = accessibleDriveFile_(claim.verifier_pdf_file_id);
      assert_(file, 'VERIFIER_PDF_NOT_FOUND', 'PDF verifikator tidak dapat dibuka.');
      var readableFilename = verifierClaimPdfFilename_(claim);
      var monthFolder = getVerifierDriveMonthFolder_(claim);
      if (file.getName() === readableFilename && verifierFileIsInFolder_(file, monthFolder)) continue;
      result.checked += 1;
      counted = true;
      if (file.getName() !== readableFilename) {
        file.setName(readableFilename);
        result.renamed += 1;
      }
      file.moveTo(monthFolder);
      result.organized += 1;
      updateRecord_('CLAIMS', claim._rowNumber, {
        verifier_pdf_filename: readableFilename,
        verifier_pdf_storage_filename: readableFilename,
        verifier_pdf_url: file.getUrl(),
        verifier_pdf_status: 'READY',
        verifier_pdf_error: ''
      });
      result.ready += 1;
    } catch (error) {
      if (!counted) result.checked += 1;
      result.errors += 1;
      recordVerifierDeliveryErrorSafely_(claim.claim_id, verifierDeliveryErrorMessage_(error));
    }
  }
  return result;
}

function verifierFileIsInFolder_(file, folder) {
  var parents = file.getParents();
  while (parents.hasNext()) {
    if (parents.next().getId() === folder.getId()) return true;
  }
  return false;
}

function renameExistingVerifierPdfFiles() {
  return organizeExistingVerifierPdfFiles();
}
