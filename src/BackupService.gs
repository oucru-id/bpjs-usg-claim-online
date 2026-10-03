var BACKUP_FOLDER_NAMES = Object.freeze({
  RAW_DICOM: 'DICOM RAW',
  DICOM: 'DICOM',
  CLAIMS: 'KLAIM'
});

function secondaryBackupEnabled_() {
  return getBooleanSetting_('ENABLE_SECONDARY_DRIVE_BACKUP', false);
}

function getSecondaryBackupRoot_() {
  var folderId = getRequiredProperty_(SCRIPT_PROPERTY_KEYS.BACKUP_DRIVE_FOLDER_ID);
  try {
    return DriveApp.getFolderById(folderId);
  } catch (error) {
    throw appError_('BACKUP_FOLDER_UNAVAILABLE',
      'Folder Drive cadangan tidak dapat dibuka. Pastikan folder dibagikan sebagai Editor kepada akun deployment.');
  }
}

function getSecondaryBackupSubfolder_(name) {
  assert_([BACKUP_FOLDER_NAMES.RAW_DICOM, BACKUP_FOLDER_NAMES.DICOM, BACKUP_FOLDER_NAMES.CLAIMS].indexOf(name) >= 0,
    'BACKUP_FOLDER_INVALID', 'Jenis folder cadangan tidak valid.');
  var root = getSecondaryBackupRoot_();
  var matches = root.getFoldersByName(name);
  var folder = matches.hasNext() ? matches.next() : root.createFolder(name);
  assert_(!matches.hasNext(), 'BACKUP_FOLDER_AMBIGUOUS',
    'Lebih dari satu subfolder cadangan bernama ' + name + ' ditemukan.');
  return folder;
}

function backupFilenameSegment_(value, fallback) {
  var text = normalizeString_(value) || normalizeString_(fallback) || 'TIDAK_DIKETAHUI';
  if (text.normalize) text = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  text = text.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return (text || 'TIDAK_DIKETAHUI').substring(0, 80);
}

function anonymousFilenameCode_(namespace, identifier) {
  var scope = normalizeString_(namespace).toUpperCase();
  var stableId = normalizeString_(identifier);
  assert_(scope && stableId, 'FILENAME_CODE_INPUT_MISSING',
    'Identitas untuk membuat kode nama file belum tersedia.');
  var signature = Utilities.computeHmacSha256Signature(
    scope + '|' + stableId,
    getRequiredProperty_(SCRIPT_PROPERTY_KEYS.FILENAME_CODE_SECRET),
    Utilities.Charset.UTF_8
  );
  var token = Utilities.base64EncodeWebSafe(signature).replace(/=+$/g, '').substring(0, 22);
  assert_(token.length === 22, 'FILENAME_CODE_FAILED', 'Kode nama file tidak dapat dibuat.');
  return 'F1' + token;
}

function claimBackupFilenameParts_(claim) {
  var facility = findRecord_('FACILITIES', 'facility_id', claim.facility_id);
  var facilityName = facility ? normalizeString_(facility.facility_name) : normalizeString_(claim.facility_id);
  var examinationDate = claimDateKey_(claim.examination_date).replace(/-/g, '');
  var nik = normalizeString_(claim.patient_nik).replace(/\D/g, '');
  var phone = normalizePatientPhone_(claim.patient_phone);
  assert_(facilityName, 'BACKUP_FACILITY_MISSING', 'Nama Puskesmas untuk penamaan backup belum tersedia.');
  assert_(/^\d{8}$/.test(examinationDate), 'BACKUP_DATE_INVALID', 'Tanggal pemeriksaan untuk penamaan backup tidak valid.');
  assert_(/^\d{16}$/.test(nik), 'BACKUP_NIK_INVALID', 'NIK untuk penamaan backup tidak valid.');
  return {
    facility: backupFilenameSegment_(facilityName, claim.facility_id),
    examinationDate: examinationDate,
    nik: nik,
    phone: phone
  };
}

function claimPdfFilename_(claim, version) {
  var parts = claimBackupFilenameParts_(claim);
  var suffix = Number(version) > 0 ? '_v' + ('000' + Number(version)).slice(-3) : '';
  return 'KLAIM_' + parts.facility + '_' + parts.examinationDate + '_' + parts.nik + '_' + parts.phone + suffix + '.pdf';
}

function claimPdfBackupFilename_(claim) {
  return claimPdfFilename_(claim, 0);
}

function claimPdfStorageFilename_(claim, version) {
  var suffix = Number(version) > 0 ? '_v' + ('000' + Number(version)).slice(-3) : '';
  return 'KLAIM_' + anonymousFilenameCode_('CLAIM_PDF', claim.claim_id) + suffix + '.pdf';
}

function claimPdfBackupStorageFilename_(claim) {
  return claimPdfStorageFilename_(claim, 0);
}

function claimDicomFilename_(claim, sequence, total) {
  var parts = claimBackupFilenameParts_(claim);
  var suffix = Number(total) > 1 ? '_' + ('000' + Number(sequence)).slice(-3) : '';
  return 'DICOM_' + parts.facility + '_' + parts.examinationDate + '_' + parts.nik + '_' + parts.phone + suffix + '.dcm';
}

function claimDicomStorageFilename_(dicom, sequence, total) {
  var suffix = Number(total) > 1 ? '_' + ('000' + Number(sequence)).slice(-3) : '';
  return 'DICOM_' + anonymousFilenameCode_('CLAIM_DICOM', dicom.dicom_id) + suffix + '.dcm';
}

function rawDicomBackupFilename_(dicom) {
  return 'DICOM_RAW_' + anonymousFilenameCode_('RAW_DICOM', dicom.dicom_id) + '.dcm';
}

function accessibleDriveFile_(fileId) {
  var id = normalizeString_(fileId);
  if (!id) return null;
  try {
    var file = DriveApp.getFileById(id);
    return file.isTrashed() ? null : file;
  } catch (error) {
    return null;
  }
}

function backupErrorMessage_(error) {
  return sanitizePlainText_(error && error.message ? error.message : 'Backup gagal tanpa pesan.', 300);
}

function backupClaimPdfSafely_(claim, sourceFile) {
  if (!secondaryBackupEnabled_()) {
    return { status: 'DISABLED', filename: '' };
  }
  var backupFile = null;
  var logicalFilename = '';
  var storedFilename = '';
  var primaryLogicalFilename = '';
  var primaryStoredFilename = '';
  try {
    logicalFilename = claimPdfBackupFilename_(claim);
    storedFilename = claimPdfBackupStorageFilename_(claim);
    primaryLogicalFilename = claimPdfFilename_(claim, Math.max(1, Number(claim.pdf_version) || 1));
    primaryStoredFilename = claimPdfStorageFilename_(claim, Math.max(1, Number(claim.pdf_version) || 1));
    if (sourceFile.getName() !== primaryStoredFilename) sourceFile.setName(primaryStoredFilename);
    var previousFile = accessibleDriveFile_(claim.backup_pdf_file_id);
    if (previousFile && previousFile.getName() === storedFilename &&
        Number(previousFile.getSize()) === Number(sourceFile.getSize())) {
      withScriptLock_(function () {
        var current = findRecord_('CLAIMS', 'claim_id', claim.claim_id);
        if (current) updateRecord_('CLAIMS', current._rowNumber, {
          final_pdf_filename: primaryLogicalFilename,
          final_pdf_storage_filename: primaryStoredFilename,
          final_pdf_url: sourceFile.getUrl(),
          backup_pdf_filename: logicalFilename,
          backup_pdf_storage_filename: storedFilename,
          backup_pdf_url: previousFile.getUrl(),
          backup_pdf_status: 'READY', backup_pdf_error: '', backup_pdf_at: now_()
        });
      });
      return { status: 'READY', filename: logicalFilename, storageFilename: storedFilename, duplicate: true };
    }
    backupFile = sourceFile.makeCopy(storedFilename, getSecondaryBackupSubfolder_(BACKUP_FOLDER_NAMES.CLAIMS));
    var timestamp = now_();
    withScriptLock_(function () {
      var current = findRecord_('CLAIMS', 'claim_id', claim.claim_id);
      assert_(current, 'CLAIM_NOT_FOUND', 'Klaim tidak ditemukan saat menyimpan status backup.');
      updateRecord_('CLAIMS', current._rowNumber, {
        backup_pdf_file_id: backupFile.getId(),
        backup_pdf_filename: logicalFilename,
        backup_pdf_storage_filename: storedFilename,
        backup_pdf_url: backupFile.getUrl(),
        final_pdf_filename: primaryLogicalFilename,
        final_pdf_storage_filename: primaryStoredFilename,
        final_pdf_url: sourceFile.getUrl(),
        backup_pdf_at: timestamp,
        backup_pdf_status: 'READY',
        backup_pdf_error: ''
      });
    });
    if (previousFile && previousFile.getId() !== backupFile.getId()) trashDriveFile_(previousFile);
    return { status: 'READY', filename: logicalFilename, storageFilename: storedFilename };
  } catch (error) {
    trashDriveFile_(backupFile);
    var message = backupErrorMessage_(error);
    withScriptLock_(function () {
      var current = findRecord_('CLAIMS', 'claim_id', claim.claim_id);
      if (current) {
        var changes = { backup_pdf_status: 'ERROR', backup_pdf_error: message };
        if (primaryLogicalFilename) changes.final_pdf_filename = primaryLogicalFilename;
        if (primaryStoredFilename) changes.final_pdf_storage_filename = primaryStoredFilename;
        updateRecord_('CLAIMS', current._rowNumber, changes);
      }
    });
    return { status: 'ERROR', filename: logicalFilename, storageFilename: storedFilename, message: message };
  }
}

function backupOriginalDicomSafely_(dicom, claim, sequence, total) {
  if (!secondaryBackupEnabled_()) {
    updateOrthancDicomBackupStatus_(dicom.dicom_id, 'DISABLED', '', '', '', '', '');
    return { status: 'DISABLED', filename: '' };
  }
  var backupFile = null;
  var logicalFilename = '';
  var storedFilename = '';
  try {
    var sourceFile = accessibleDriveFile_(dicom.claim_drive_file_id);
    assert_(sourceFile, 'DICOM_CLAIM_FILE_MISSING', 'DICOM asli pada folder klaim tidak tersedia.');
    logicalFilename = claimDicomFilename_(claim, sequence, total);
    storedFilename = claimDicomStorageFilename_(dicom, sequence, total);
    if (sourceFile.getName() !== storedFilename) sourceFile.setName(storedFilename);
    var previousFile = accessibleDriveFile_(dicom.backup_drive_file_id);
    if (previousFile && previousFile.getName() === storedFilename &&
        Number(previousFile.getSize()) === Number(sourceFile.getSize())) {
      updateOrthancDicomBackupStatus_(dicom.dicom_id, 'READY', previousFile.getId(),
        logicalFilename, storedFilename, previousFile.getUrl(), '');
      return { status: 'READY', filename: logicalFilename, storageFilename: storedFilename, duplicate: true };
    }
    backupFile = sourceFile.makeCopy(storedFilename, getSecondaryBackupSubfolder_(BACKUP_FOLDER_NAMES.DICOM));
    updateOrthancDicomBackupStatus_(dicom.dicom_id, 'READY', backupFile.getId(),
      logicalFilename, storedFilename, backupFile.getUrl(), '');
    if (previousFile && previousFile.getId() !== backupFile.getId()) trashDriveFile_(previousFile);
    return { status: 'READY', filename: logicalFilename, storageFilename: storedFilename };
  } catch (error) {
    trashDriveFile_(backupFile);
    var message = backupErrorMessage_(error);
    updateOrthancDicomBackupStatus_(dicom.dicom_id, 'ERROR', '',
      logicalFilename, storedFilename, '', message);
    return { status: 'ERROR', filename: logicalFilename, storageFilename: storedFilename, message: message };
  }
}

function backupRawOriginalDicomSafely_(dicom) {
  if (!secondaryBackupEnabled_()) {
    updateOrthancRawDicomBackupStatus_(dicom.dicom_id, 'DISABLED', '', '', '', '');
    return { status: 'DISABLED', filename: '' };
  }
  var backupFile = null;
  var filename = '';
  try {
    var sourceFile = accessibleDriveFile_(dicom.staging_drive_file_id) ||
      accessibleDriveFile_(dicom.claim_drive_file_id);
    assert_(sourceFile, 'RAW_DICOM_SOURCE_MISSING', 'DICOM raw pada penampungan atau folder klaim tidak tersedia.');
    filename = rawDicomBackupFilename_(dicom);
    if (normalizeString_(dicom.staging_drive_file_id) === sourceFile.getId() && sourceFile.getName() !== filename) {
      sourceFile.setName(filename);
    }
    var previousFile = accessibleDriveFile_(dicom.raw_backup_drive_file_id);
    if (previousFile && previousFile.getName() === filename &&
        Number(previousFile.getSize()) === Number(sourceFile.getSize())) {
      updateOrthancRawDicomBackupStatus_(dicom.dicom_id, 'READY', previousFile.getId(),
        filename, previousFile.getUrl(), '');
      return { status: 'READY', filename: filename, duplicate: true };
    }
    backupFile = sourceFile.makeCopy(filename, getSecondaryBackupSubfolder_(BACKUP_FOLDER_NAMES.RAW_DICOM));
    updateOrthancRawDicomBackupStatus_(dicom.dicom_id, 'READY', backupFile.getId(),
      filename, backupFile.getUrl(), '');
    if (previousFile && previousFile.getId() !== backupFile.getId()) trashDriveFile_(previousFile);
    return { status: 'READY', filename: filename };
  } catch (error) {
    trashDriveFile_(backupFile);
    var message = backupErrorMessage_(error);
    updateOrthancRawDicomBackupStatus_(dicom.dicom_id, 'ERROR', '', filename, '', message);
    return { status: 'ERROR', filename: filename, message: message };
  }
}

function updateOrthancDicomBackupStatus_(dicomId, status, fileId, logicalFilename,
    storedFilename, driveUrl, errorMessage) {
  withScriptLock_(function () {
    var current = findRecord_('ORTHANC_DICOMS', 'dicom_id', dicomId);
    if (!current) return;
    var changes = {
      backup_status: status,
      backup_filename: logicalFilename || normalizeString_(current.backup_filename),
      backup_stored_filename: storedFilename || normalizeString_(current.backup_stored_filename),
      backup_error: errorMessage || ''
    };
    if (fileId) {
      changes.backup_drive_file_id = fileId;
      changes.backup_drive_url = driveUrl;
      changes.backup_at = now_();
    }
    if (status === 'READY') {
      if (logicalFilename) changes.claim_filename = logicalFilename;
      if (storedFilename) changes.claim_stored_filename = storedFilename;
      var claimFile = accessibleDriveFile_(current.claim_drive_file_id);
      if (claimFile) changes.claim_drive_url = claimFile.getUrl();
    }
    updateRecord_('ORTHANC_DICOMS', current._rowNumber, changes);
  });
}

function claimPdfFilesNeedRefresh_(claim) {
  var sourceFile = accessibleDriveFile_(claim.final_pdf_file_id);
  if (!sourceFile) return true;
  try {
    var version = Math.max(1, Number(claim.pdf_version) || 1);
    var primaryLogicalFilename = claimPdfFilename_(claim, version);
    var primaryStoredFilename = claimPdfStorageFilename_(claim, version);
    var backupLogicalFilename = claimPdfBackupFilename_(claim);
    var backupStoredFilename = claimPdfBackupStorageFilename_(claim);
    var backupFile = accessibleDriveFile_(claim.backup_pdf_file_id);
    return sourceFile.getName() !== primaryStoredFilename ||
      normalizeString_(claim.final_pdf_filename) !== primaryLogicalFilename ||
      normalizeString_(claim.final_pdf_storage_filename) !== primaryStoredFilename ||
      normalizeString_(claim.final_pdf_url) !== normalizeString_(sourceFile.getUrl()) ||
      normalizeString_(claim.backup_pdf_status).toUpperCase() !== 'READY' ||
      normalizeString_(claim.backup_pdf_filename) !== backupLogicalFilename ||
      normalizeString_(claim.backup_pdf_storage_filename) !== backupStoredFilename ||
      (backupFile && normalizeString_(claim.backup_pdf_url) !== normalizeString_(backupFile.getUrl())) ||
      !backupFile || backupFile.getName() !== backupStoredFilename;
  } catch (error) {
    return true;
  }
}

function claimDicomFilesNeedRefresh_(dicom, claim, sequence, total) {
  try {
    var logicalFilename = claimDicomFilename_(claim, sequence, total);
    var storedFilename = claimDicomStorageFilename_(dicom, sequence, total);
    var sourceFile = accessibleDriveFile_(dicom.claim_drive_file_id);
    var backupFile = accessibleDriveFile_(dicom.backup_drive_file_id);
    return !sourceFile || sourceFile.getName() !== storedFilename ||
      normalizeString_(dicom.claim_filename) !== logicalFilename ||
      normalizeString_(dicom.claim_stored_filename) !== storedFilename ||
      (sourceFile && normalizeString_(dicom.claim_drive_url) !== normalizeString_(sourceFile.getUrl())) ||
      normalizeString_(dicom.backup_status).toUpperCase() !== 'READY' ||
      normalizeString_(dicom.backup_filename) !== logicalFilename ||
      normalizeString_(dicom.backup_stored_filename) !== storedFilename ||
      (backupFile && normalizeString_(dicom.backup_drive_url) !== normalizeString_(backupFile.getUrl())) ||
      !backupFile || backupFile.getName() !== storedFilename;
  } catch (error) {
    return true;
  }
}

function updateOrthancRawDicomBackupStatus_(dicomId, status, fileId, filename, driveUrl, errorMessage) {
  withScriptLock_(function () {
    var current = findRecord_('ORTHANC_DICOMS', 'dicom_id', dicomId);
    if (!current) return;
    var changes = {
      raw_backup_status: status,
      raw_backup_filename: filename || normalizeString_(current.raw_backup_filename),
      raw_backup_error: errorMessage || ''
    };
    if (fileId) {
      changes.raw_backup_drive_file_id = fileId;
      changes.raw_backup_drive_url = driveUrl;
      changes.raw_backup_at = now_();
    }
    var stagingFile = accessibleDriveFile_(current.staging_drive_file_id);
    if (stagingFile) {
      changes.stored_filename = stagingFile.getName();
      changes.staging_drive_url = stagingFile.getUrl();
    }
    updateRecord_('ORTHANC_DICOMS', current._rowNumber, changes);
  });
}

function rawDicomFilesNeedRefresh_(dicom) {
  try {
    var filename = rawDicomBackupFilename_(dicom);
    var backupFile = accessibleDriveFile_(dicom.raw_backup_drive_file_id);
    var stagingFile = accessibleDriveFile_(dicom.staging_drive_file_id);
    return normalizeString_(dicom.raw_backup_status).toUpperCase() !== 'READY' ||
      !backupFile || backupFile.getName() !== filename ||
      normalizeString_(dicom.raw_backup_filename) !== filename ||
      (backupFile && normalizeString_(dicom.raw_backup_drive_url) !== normalizeString_(backupFile.getUrl())) ||
      (stagingFile && (stagingFile.getName() !== filename ||
        normalizeString_(dicom.staging_drive_url) !== normalizeString_(stagingFile.getUrl())));
  } catch (error) {
    return true;
  }
}

function reconstructFilenameFromDatabase_(storageNameOrUrl) {
  var reference = normalizeString_(storageNameOrUrl);
  assert_(reference, 'FILE_REFERENCE_REQUIRED', 'Nama penyimpanan atau URL file wajib diisi.');
  var result = null;
  readAllRecords_('CLAIMS').some(function (claim) {
    var mappings = [
      {
        location: 'PRIMARY_PDF', storage: claim.final_pdf_storage_filename,
        url: claim.final_pdf_url, original: claim.final_pdf_filename
      },
      {
        location: 'BACKUP_PDF', storage: claim.backup_pdf_storage_filename,
        url: claim.backup_pdf_url, original: claim.backup_pdf_filename
      }
    ];
    return mappings.some(function (mapping) {
      if (reference !== normalizeString_(mapping.storage) && reference !== normalizeString_(mapping.url)) return false;
      result = {
        file_type: 'PDF', location: mapping.location, claim_id: normalizeString_(claim.claim_id),
        storage_filename: normalizeString_(mapping.storage), original_filename: normalizeString_(mapping.original),
        drive_url: normalizeString_(mapping.url)
      };
      return true;
    });
  });
  if (result) return result;
  readAllRecords_('ORTHANC_DICOMS').some(function (dicom) {
    var mappings = [
      {
        location: 'STAGING_DICOM', storage: dicom.stored_filename,
        url: dicom.staging_drive_url, original: dicom.original_filename
      },
      {
        location: 'PRIMARY_DICOM', storage: dicom.claim_stored_filename,
        url: dicom.claim_drive_url, original: dicom.claim_filename
      },
      {
        location: 'BACKUP_DICOM', storage: dicom.backup_stored_filename,
        url: dicom.backup_drive_url, original: dicom.backup_filename
      },
      {
        location: 'RAW_BACKUP_DICOM', storage: dicom.raw_backup_filename,
        url: dicom.raw_backup_drive_url, original: dicom.original_filename
      }
    ];
    return mappings.some(function (mapping) {
      if (reference !== normalizeString_(mapping.storage) && reference !== normalizeString_(mapping.url)) return false;
      result = {
        file_type: 'DICOM', location: mapping.location, dicom_id: normalizeString_(dicom.dicom_id),
        claim_id: normalizeString_(dicom.claim_id), storage_filename: normalizeString_(mapping.storage),
        original_filename: normalizeString_(mapping.original), drive_url: normalizeString_(mapping.url)
      };
      return true;
    });
  });
  assert_(result, 'FILE_MAPPING_NOT_FOUND', 'Pemetaan nama file tidak ditemukan pada database.');
  return result;
}

function validateSecondaryBackupConfiguration() {
  var activeUser = normalizeEmail_(Session.getActiveUser().getEmail());
  var adminEmail = normalizeEmail_(getRequiredProperty_(SCRIPT_PROPERTY_KEYS.ADMIN_EMAIL));
  assert_(activeUser && activeUser === adminEmail, 'BACKUP_CONFIGURATION_DENIED',
    'Konfigurasi backup hanya boleh divalidasi oleh administrator pemasang.');
  var root = getSecondaryBackupRoot_();
  getSecondaryBackupSubfolder_(BACKUP_FOLDER_NAMES.RAW_DICOM);
  getSecondaryBackupSubfolder_(BACKUP_FOLDER_NAMES.DICOM);
  getSecondaryBackupSubfolder_(BACKUP_FOLDER_NAMES.CLAIMS);
  var setting = findRecord_('SETTINGS', 'setting_key', 'ENABLE_SECONDARY_DRIVE_BACKUP');
  assert_(setting, 'BACKUP_SETTING_MISSING', 'Jalankan setupApplication() terlebih dahulu.');
  updateRecord_('SETTINGS', setting._rowNumber, {
    setting_value: 'true', updated_at: now_(), updated_by: activeUser
  });
  return { success: true, folderId: root.getId(), folderName: root.getName(), enabled: true };
}

function backupExistingClaimFiles() {
  var activeUser = normalizeEmail_(Session.getActiveUser().getEmail());
  var adminEmail = normalizeEmail_(getRequiredProperty_(SCRIPT_PROPERTY_KEYS.ADMIN_EMAIL));
  assert_(activeUser && activeUser === adminEmail, 'BACKUP_RECOVERY_DENIED',
    'Pemulihan backup hanya boleh dijalankan oleh administrator pemasang.');
  assert_(secondaryBackupEnabled_(), 'BACKUP_DISABLED', 'Backup Drive kedua belum diaktifkan.');
  var result = {
    success: true,
    rawDicomReady: 0,
    rawDicomError: 0,
    pdfReady: 0,
    pdfError: 0,
    dicomReady: 0,
    dicomError: 0
  };
  readAllRecords_('ORTHANC_DICOMS').filter(function (dicom) {
    return (normalizeString_(dicom.staging_drive_file_id) || normalizeString_(dicom.claim_drive_file_id)) &&
      rawDicomFilesNeedRefresh_(dicom);
  }).slice(0, 100).forEach(function (dicom) {
    var item = backupRawOriginalDicomSafely_(dicom);
    if (item.status === 'READY') result.rawDicomReady += 1;
    else result.rawDicomError += 1;
  });
  readAllRecords_('CLAIMS').filter(function (claim) {
    return normalizeString_(claim.final_pdf_file_id) && claimPdfFilesNeedRefresh_(claim);
  }).slice(0, 50).forEach(function (claim) {
    var source = accessibleDriveFile_(claim.final_pdf_file_id);
    var item = source ? backupClaimPdfSafely_(claim, source) : { status: 'ERROR' };
    if (item.status === 'READY') result.pdfReady += 1;
    else result.pdfError += 1;
  });
  var grouped = {};
  readAllRecords_('ORTHANC_DICOMS').filter(function (dicom) {
    return normalizeString_(dicom.claim_id) && normalizeString_(dicom.claim_drive_file_id);
  }).forEach(function (dicom) {
    var claimId = normalizeString_(dicom.claim_id);
    if (!grouped[claimId]) grouped[claimId] = [];
    grouped[claimId].push(dicom);
  });
  Object.keys(grouped).forEach(function (claimId) {
    var claim = findRecord_('CLAIMS', 'claim_id', claimId);
    if (!claim) return;
    grouped[claimId].sort(function (left, right) {
      return (Number(left.sequence_number) || 0) - (Number(right.sequence_number) || 0) ||
        normalizeString_(left.source_key).localeCompare(normalizeString_(right.source_key));
    });
    var inbox = grouped[claimId].length ?
      findRecord_('ORTHANC_INBOX', 'inbox_id', grouped[claimId][0].inbox_id) : null;
    var total = Math.max(grouped[claimId].length, Number(inbox && inbox.expected_dicoms) || 0);
    grouped[claimId].forEach(function (dicom, index) {
      if (result.dicomReady + result.dicomError >= 100) return;
      var sequence = Number(dicom.sequence_number) || index + 1;
      if (!claimDicomFilesNeedRefresh_(dicom, claim, sequence, total)) return;
      var item = backupOriginalDicomSafely_(dicom, claim, sequence, total);
      if (item.status === 'READY') result.dicomReady += 1;
      else result.dicomError += 1;
    });
  });
  return result;
}
