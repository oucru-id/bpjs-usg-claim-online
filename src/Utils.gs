function appError_(code, message) {
  var error = new Error(message);
  error.code = code;
  return error;
}

function normalizeString_(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function normalizeEmail_(email) {
  return normalizeString_(email).toLowerCase();
}

function normalizeBoolean_(value) {
  return value === true || String(value).toLowerCase() === 'true';
}

function now_() {
  return new Date();
}

function toIsoString_(value) {
  if (!value) return '';
  return value instanceof Date ? value.toISOString() : String(value);
}

function publicError_(error) {
  var knownCode = error && error.code ? String(error.code) : 'UNEXPECTED_ERROR';
  var knownMessage = error && error.message
    ? String(error.message)
    : 'Terjadi kesalahan. Silakan coba kembali.';
  console.error(JSON.stringify({ code: knownCode, message: knownMessage }));
  return { success: false, code: knownCode, message: knownMessage };
}

function success_(data) {
  return { success: true, data: data === undefined ? null : data };
}

function assert_(condition, code, message) {
  if (!condition) throw appError_(code, message);
}

function validateEmail_(email) {
  var normalized = normalizeEmail_(email);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
}

function sanitizePlainText_(value, maxLength) {
  var text = normalizeString_(value).replace(/[\u0000-\u001F\u007F]/g, ' ');
  return text.substring(0, maxLength || 200);
}

function maskNik(nik) {
  var value = normalizeString_(nik).replace(/\s/g, '');
  if (!value) return '';
  var suffix = value.slice(-4);
  return new Array(Math.max(value.length - suffix.length, 0) + 1).join('*') + suffix;
}

function maskPatientName(name) {
  return normalizeString_(name).split(/\s+/).filter(Boolean).map(function (part, index) {
    if (index === 0) return part;
    return part.charAt(0) + new Array(Math.max(part.length, 2)).join('*');
  }).join(' ');
}

function serializeForClient_(record) {
  var copy = {};
  Object.keys(record || {}).forEach(function (key) {
    copy[key] = record[key] instanceof Date ? record[key].toISOString() : record[key];
  });
  return copy;
}

function withScriptLock_(callback) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw appError_('SYSTEM_BUSY', 'Sistem sedang sibuk. Silakan coba kembali.');
  }
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}
