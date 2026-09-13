function getDatabase_() {
  var id = getRequiredProperty_(SCRIPT_PROPERTY_KEYS.DATABASE_SPREADSHEET_ID);
  try {
    return SpreadsheetApp.openById(id);
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
  var headers = SHEET_SCHEMAS[sheetName];
  assert_(headers, 'INVALID_SHEET', 'Lembar tidak dikenal.');
  sheet.appendRow(headers.map(function (header) {
    return record[header] === undefined ? '' : record[header];
  }));
  return record;
}

function updateRecord_(sheetName, rowNumber, changes) {
  var sheet = getSheet_(sheetName);
  var headers = SHEET_SCHEMAS[sheetName];
  assert_(rowNumber >= 2, 'INVALID_ROW', 'Baris data tidak valid.');
  var current = sheet.getRange(rowNumber, 1, 1, headers.length).getValues()[0];
  headers.forEach(function (header, index) {
    if (Object.prototype.hasOwnProperty.call(changes, header)) current[index] = changes[header];
  });
  sheet.getRange(rowNumber, 1, 1, headers.length).setValues([current]);
}
