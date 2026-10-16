var DATABASE_CONNECTION_CACHE_ = { id: '', spreadsheet: null };

function getDatabase_() {
  var id = getRequiredProperty_(SCRIPT_PROPERTY_KEYS.DATABASE_SPREADSHEET_ID);
  if (DATABASE_CONNECTION_CACHE_.id === id && DATABASE_CONNECTION_CACHE_.spreadsheet) {
    return DATABASE_CONNECTION_CACHE_.spreadsheet;
  }
  try {
    var spreadsheet = SpreadsheetApp.openById(id);
    DATABASE_CONNECTION_CACHE_ = { id: id, spreadsheet: spreadsheet };
    return spreadsheet;
  } catch (error) {
    throw appError_('DATABASE_UNAVAILABLE', 'Database aplikasi tidak dapat dibuka.');
  }
}

function getSheet_(sheetName) {
  var sheet = getDatabase_().getSheetByName(sheetName);
  if (!sheet) throw appError_('SHEET_MISSING', 'Lembar ' + sheetName + ' tidak ditemukan.');
  return sheet;
}

function ensureSheetSchema_(spreadsheet, sheetName, headers) {
  var sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) sheet = spreadsheet.insertSheet(sheetName);
  var lastColumn = sheet.getLastColumn();
  if (lastColumn === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    return { sheet: sheet, createdHeaders: true };
  }
  var existing = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0].map(function (header) {
    return normalizeString_(header);
  });
  var seen = {};
  var repairedBlankHeader = false;
  existing.forEach(function (header) {
    if (!header) return;
    assert_(headers.indexOf(header) >= 0, 'SCHEMA_UNKNOWN_COLUMN',
      'Header sheet ' + sheetName + ' memiliki kolom yang tidak dikenal: ' + header + '. Data tidak diubah.');
    assert_(!seen[header], 'SCHEMA_DUPLICATE_COLUMN',
      'Header sheet ' + sheetName + ' memiliki kolom duplikat: ' + header + '. Data tidak diubah.');
    seen[header] = true;
  });
  existing = existing.map(function (header, index) {
    if (header) return header;
    var expectedAtPosition = headers[index];
    assert_(expectedAtPosition && !seen[expectedAtPosition], 'SCHEMA_BLANK_COLUMN_AMBIGUOUS',
      'Header kosong pada kolom ' + (index + 1) + ' di sheet ' + sheetName + ' tidak dapat dipetakan dengan aman. Data tidak diubah.');
    seen[expectedAtPosition] = true;
    repairedBlankHeader = true;
    return expectedAtPosition;
  });
  var exactMatch = !repairedBlankHeader && existing.length === headers.length && existing.every(function (header, index) {
    return header === headers[index];
  });
  if (exactMatch) return { sheet: sheet, createdHeaders: false, migratedHeaders: false };

  var lastRow = Math.max(sheet.getLastRow(), 1);
  var currentValues = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
  var existingIndexes = {};
  existing.forEach(function (header, index) { existingIndexes[header] = index; });
  var migratedValues = [headers.slice()];
  for (var rowIndex = 1; rowIndex < currentValues.length; rowIndex += 1) {
    migratedValues.push(headers.map(function (header) {
      return Object.prototype.hasOwnProperty.call(existingIndexes, header)
        ? currentValues[rowIndex][existingIndexes[header]]
        : '';
    }));
  }
  if (sheet.getMaxColumns() < headers.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
  }
  sheet.getRange(1, 1, lastRow, Math.max(lastColumn, headers.length)).clearContent();
  sheet.getRange(1, 1, migratedValues.length, headers.length).setValues(migratedValues);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  return { sheet: sheet, createdHeaders: false, migratedHeaders: true };
}

function repairClaimDoctorSchemaMigration_(spreadsheet) {
  var sheet = spreadsheet.getSheetByName('CLAIMS');
  if (!sheet || sheet.getLastColumn() === 0 || sheet.getLastRow() < 2) {
    return { repairedRows: 0, migratedHeaders: false };
  }
  var expectedHeaders = SHEET_SCHEMAS.CLAIMS;
  var preVerifierHeaders = expectedHeaders.filter(function (header) {
    return header.indexOf('verifier_pdf_') !== 0;
  });
  var legacyHeaders = preVerifierHeaders.filter(function (header) { return header !== 'doctor_name'; });
  var lastColumn = sheet.getLastColumn();
  var actualHeaders = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0].map(function (header) {
    return normalizeString_(header);
  });
  var isCurrentSchema = sameHeaders_(actualHeaders, expectedHeaders) ||
    sameHeaders_(actualHeaders, preVerifierHeaders);
  var isLegacySchema = sameHeaders_(actualHeaders, legacyHeaders);
  if (!isCurrentSchema && !isLegacySchema) {
    return { repairedRows: 0, migratedHeaders: false };
  }

  var lastRow = sheet.getLastRow();
  var currentValues = sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues();
  var repairedRows = 0;
  var migratedValues = currentValues.map(function (row) {
    var record = {};
    actualHeaders.forEach(function (header, index) { record[header] = row[index]; });
    var repaired = repairCorruptedClaimDoctorRecord_(record);
    if (repaired) {
      record = repaired;
      repairedRows += 1;
    }
    return expectedHeaders.map(function (header) {
      return record[header] === undefined ? '' : record[header];
    });
  });
  if (!repairedRows) return { repairedRows: 0, migratedHeaders: false };

  if (sheet.getMaxColumns() < expectedHeaders.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), expectedHeaders.length - sheet.getMaxColumns());
  }
  sheet.getRange(1, 1, lastRow, Math.max(lastColumn, expectedHeaders.length)).clearContent();
  sheet.getRange(1, 1, 1, expectedHeaders.length).setValues([expectedHeaders]).setFontWeight('bold');
  sheet.getRange(2, 1, migratedValues.length, expectedHeaders.length).setValues(migratedValues);
  sheet.setFrozenRows(1);
  return { repairedRows: repairedRows, migratedHeaders: isLegacySchema };
}

function repairCorruptedClaimDoctorRecord_(record) {
  var doctorCandidate = normalizeString_(record.patient_birth_date);
  var recoveredBirthDate = claimMigrationDateKey_(record.examination_date);
  var recoveredExaminationDate = claimMigrationDateKey_(record.status);
  if (normalizeString_(record.doctor_name) || !doctorCandidate ||
      claimMigrationDateKey_(record.patient_birth_date) ||
      !recoveredBirthDate || !recoveredExaminationDate ||
      recoveredBirthDate > recoveredExaminationDate) {
    return null;
  }
  var repaired = {};
  Object.keys(record).forEach(function (key) { repaired[key] = record[key]; });
  repaired.doctor_name = doctorCandidate.substring(0, 120);
  repaired.patient_birth_date = record.examination_date;
  repaired.examination_date = record.status;
  repaired.status = inferClaimStatusAfterDoctorSchemaCorruption_(record);
  if (validateEmail_(normalizeString_(record.updated_at)) && claimMigrationDateKey_(record.mobile_upload_token_hash)) {
    repaired.updated_by = normalizeEmail_(record.updated_at);
    repaired.updated_at = record.mobile_upload_token_hash;
    repaired.mobile_upload_token_hash = '';
  }
  return repaired;
}

function inferClaimStatusAfterDoctorSchemaCorruption_(record) {
  if (record.archived_at) return CLAIM_STATUSES.ARCHIVED;
  if (record.completed_at) return CLAIM_STATUSES.COMPLETED;
  if (record.final_pdf_file_id || Number(record.selected_document_count || 0) > 0) {
    return CLAIM_STATUSES.COLLECTING_DOCUMENTS;
  }
  return CLAIM_STATUSES.DRAFT;
}

function claimMigrationDateKey_(value) {
  if (value instanceof Date && isFinite(value.getTime())) {
    return Utilities.formatDate(value, APP_CONFIG.TIMEZONE, 'yyyy-MM-dd');
  }
  var text = normalizeString_(value).substring(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function sameHeaders_(actual, expected) {
  return actual.length === expected.length && actual.every(function (header, index) {
    return header === expected[index];
  });
}

function assertSheetSchemaCurrent_(sheetName, sheet) {
  var expected = SHEET_SCHEMAS[sheetName];
  assert_(expected, 'INVALID_SHEET', 'Lembar tidak dikenal.');
  var lastColumn = sheet.getLastColumn();
  var actual = lastColumn
    ? sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0].map(function (header) { return normalizeString_(header); })
    : [];
  assert_(sameHeaders_(actual, expected), 'SCHEMA_MIGRATION_REQUIRED',
    'Struktur database belum sesuai versi aplikasi. Administrator harus menjalankan setupApplication() sebelum data dapat disimpan.');
  return expected;
}

function readAllRecords_(sheetName) {
  var sheet = getSheet_(sheetName);
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0];
  return values.slice(1).filter(function (row) {
    return row.some(function (value) { return value !== ''; });
  }).map(function (row, rowIndex) {
    var record = { _rowNumber: rowIndex + 2 };
    headers.forEach(function (header, columnIndex) { record[header] = row[columnIndex]; });
    return record;
  });
}

function findRecord_(sheetName, key, value) {
  var expected = normalizeString_(value);
  var rows = readAllRecords_(sheetName);
  for (var i = 0; i < rows.length; i += 1) {
    if (normalizeString_(rows[i][key]) === expected) return rows[i];
  }
  return null;
}

function appendRecord_(sheetName, record) {
  var sheet = getSheet_(sheetName);
  var headers = assertSheetSchemaCurrent_(sheetName, sheet);
  sheet.appendRow(headers.map(function (header) {
    return record[header] === undefined ? '' : record[header];
  }));
  return record;
}

function updateRecord_(sheetName, rowNumber, changes) {
  var sheet = getSheet_(sheetName);
  var headers = assertSheetSchemaCurrent_(sheetName, sheet);
  assert_(rowNumber >= 2, 'INVALID_ROW', 'Baris data tidak valid.');
  var current = sheet.getRange(rowNumber, 1, 1, headers.length).getValues()[0];
  headers.forEach(function (header, index) {
    if (Object.prototype.hasOwnProperty.call(changes, header)) current[index] = changes[header];
  });
  sheet.getRange(rowNumber, 1, 1, headers.length).setValues([current]);
}
