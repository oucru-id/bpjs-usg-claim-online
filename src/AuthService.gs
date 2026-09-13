function getCurrentUserEmail() {
  return normalizeEmail_(Session.getActiveUser().getEmail());
}

function getCurrentUser(sessionToken) {
  return requireAuthenticatedUser(sessionToken);
}

function findUserByEmail_(email) {
  var normalized = normalizeEmail_(email);
  var users = readAllRecords_('USERS');
  for (var i = 0; i < users.length; i += 1) {
    if (normalizeEmail_(users[i].google_email) === normalized) return users[i];
  }
  return null;
}

function requireAuthenticatedUser(sessionToken, allowPasswordChange) {
  if (normalizeString_(sessionToken)) {
    var sessionUser = getPasswordSessionUser_(sessionToken);
    if (sessionUser._mustChangePassword && allowPasswordChange !== true) {
      throw appError_('PASSWORD_CHANGE_REQUIRED', 'Anda wajib mengganti kata sandi awal sebelum menggunakan aplikasi.');
    }
    return sessionUser;
  }
  var email = getCurrentUserEmail();
  if (!email) {
    throw appError_('IDENTITY_UNAVAILABLE', 'Sesi login belum tersedia. Silakan masuk dengan nama pengguna dan kata sandi.');
  }
  var configuredAdmin = normalizeEmail_(getRequiredProperty_(SCRIPT_PROPERTY_KEYS.ADMIN_EMAIL));
  if (email !== configuredAdmin) {
    throw appError_('IDENTITY_UNAVAILABLE', 'Sesi login belum tersedia. Silakan masuk dengan nama pengguna dan kata sandi.');
  }
  var record = findUserByEmail_(email);
  var user = record ? normalizeUserRecord_(record) : null;
  if (!user || !user.active || user.role !== ROLES.ADMIN) {
    throw appError_('IDENTITY_UNAVAILABLE', 'Sesi login belum tersedia. Silakan masuk dengan nama pengguna dan kata sandi.');
  }
  if (findRecord_('AUTH_CREDENTIALS', 'user_id', user.user_id)) {
    throw appError_('IDENTITY_UNAVAILABLE', 'Sesi login belum tersedia. Silakan masuk dengan nama pengguna dan kata sandi.');
  }
  user._authMode = 'INSTALLER_ADMIN';
  return user;
}

function requireRole(role, sessionToken) {
  var user = requireAuthenticatedUser(sessionToken);
  if (user.role !== role) throw appError_('ROLE_REQUIRED', 'Anda tidak memiliki izin untuk tindakan ini.');
  return user;
}

function requirePermission(permission, sessionToken) {
  assert_(PERMISSIONS.indexOf(permission) >= 0, 'UNKNOWN_PERMISSION', 'Izin aplikasi tidak dikenal.');
  var user = requireAuthenticatedUser(sessionToken);
  if (user.role !== ROLES.ADMIN && !user[permission]) {
    throw appError_('PERMISSION_DENIED', 'Anda tidak memiliki izin untuk tindakan ini.');
  }
  return user;
}

function canAccessClaim(user, claim) {
  if (!user || !claim || !user.active) return false;
  if (user.role === ROLES.ADMIN || user.can_view_all_claims) return true;
  return normalizeEmail_(claim.created_by) === user.google_email ||
    (normalizeString_(user.facility_id) && normalizeString_(claim.facility_id) === normalizeString_(user.facility_id));
}

function normalizeUserRecord_(record) {
  var user = {};
  Object.keys(record).forEach(function (key) { user[key] = record[key]; });
  user.google_email = normalizeEmail_(record.google_email);
  user.role = normalizeString_(record.role).toUpperCase();
  user.active = normalizeBoolean_(record.active);
  PERMISSIONS.forEach(function (permission) { user[permission] = normalizeBoolean_(record[permission]); });
  return user;
}
