function createClaimFolder_(claimCode) {
  var root = DriveApp.getFolderById(getRequiredProperty_(SCRIPT_PROPERTY_KEYS.CLAIMS_FOLDER_ID));
  var existing = root.getFoldersByName(claimCode);
  assert_(!existing.hasNext(), 'CLAIM_FOLDER_EXISTS', 'Folder untuk kode klaim ini sudah ada. Silakan coba kembali.');
  var folder = root.createFolder(claimCode);
  try {
    ['USG', 'KTP', 'BUKU_KIA', 'SPP_FKPP_BPJS', 'OTHER', 'THUMBNAILS', 'OUTPUT'].forEach(function (name) {
      folder.createFolder(name);
    });
  } catch (error) {
    trashEmptyClaimFolder_(folder);
    throw error;
  }
  return folder;
}

function trashEmptyClaimFolder_(folder) {
  if (!folder) return;
  try {
    folder.setTrashed(true);
  } catch (error) {
    console.error(JSON.stringify({ code: 'CLAIM_FOLDER_ROLLBACK_FAILED', message: error.message }));
  }
}

function getClaimSubfolder_(claim, folderName) {
  var allowed = Object.keys(DOCUMENT_TYPES).map(function (key) { return DOCUMENT_TYPES[key]; })
    .concat(['THUMBNAILS', 'OUTPUT']);
  assert_(allowed.indexOf(folderName) >= 0, 'INVALID_CLAIM_FOLDER', 'Folder berkas tidak valid.');
  var claimFolder;
  try {
    claimFolder = DriveApp.getFolderById(normalizeString_(claim.drive_claim_folder_id));
  } catch (error) {
    throw appError_('CLAIM_FOLDER_UNAVAILABLE', 'Folder klaim tidak dapat dibuka.');
  }
  var matches = claimFolder.getFoldersByName(folderName);
  var folder = matches.hasNext() ? matches.next() : claimFolder.createFolder(folderName);
  assert_(!matches.hasNext(), 'CLAIM_SUBFOLDER_AMBIGUOUS', 'Ditemukan lebih dari satu folder ' + folderName + '.');
  return folder;
}

function createPrivateDocumentFiles_(claim, documentType, imageBlob, thumbnailBlob, storedFilename, thumbnailFilename) {
  var imageFile = null;
  var thumbnailFile = null;
  try {
    imageFile = getClaimSubfolder_(claim, documentType).createFile(imageBlob.setName(storedFilename));
    thumbnailFile = getClaimSubfolder_(claim, 'THUMBNAILS').createFile(thumbnailBlob.setName(thumbnailFilename));
    return { imageFile: imageFile, thumbnailFile: thumbnailFile };
  } catch (error) {
    trashDriveFile_(imageFile);
    trashDriveFile_(thumbnailFile);
    throw error;
  }
}

function getPrivateFileBlob_(fileId) {
  try {
    return DriveApp.getFileById(normalizeString_(fileId)).getBlob();
  } catch (error) {
    throw appError_('DOCUMENT_FILE_UNAVAILABLE', 'Berkas gambar tidak dapat dibuka.');
  }
}

function trashDriveFile_(file) {
  if (!file) return;
  try {
    file.setTrashed(true);
  } catch (error) {
    console.error(JSON.stringify({ code: 'DOCUMENT_TRASH_FAILED', message: error.message }));
  }
}
