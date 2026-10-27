function loginWithPassword(username, password) {
  var normalizedUsername = normalizeUsername_(username);
  var suppliedPassword = password === null || password === undefined ? '' : String(password);
  try {
    assert_(isValidUsername_(normalizedUsername) && suppliedPassword.length >= 1 && suppliedPassword.length <= 128,
      'INVALID_CREDENTIALS', 'Nama pengguna atau kata sandi salah.');
    var credential = findCredentialByUsername_(normalizedUsername);
    if (!credential) {
      derivePasswordHash_(suppliedPassword, 'invalid-user-salt', getPasswordIterations_());
      throw appError_('INVALID_CREDENTIALS', 'Nama pengguna atau kata sandi salah.');
    }
    var calculated = derivePasswordHash_(suppliedPassword, credential.password_salt, Number(credential.hash_iterations));
    var userRecord = findRecord_('USERS', 'user_id', credential.user_id);
    var user = userRecord ? normalizeUserRecord_(userRecord) : null;
    var lockedUntil = credential.locked_until ? new Date(credential.locked_until).getTime() : 0;
    var eligible = user && user.active && (!lockedUntil || lockedUntil <= Date.now());
    if (!eligible || !constantTimeEquals_(calculated, normalizeString_(credential.password_hash))) {
      if (eligible) recordFailedLogin_(credential, user);
      throw appError_('INVALID_CREDENTIALS', 'Nama pengguna atau kata sandi salah.');
    }

    var loginResult = withScriptLock_(function () {
      var freshCredential = findRecord_('AUTH_CREDENTIALS', 'credential_id', credential.credential_id);
      updateRecord_('AUTH_CREDENTIALS', freshCredential._rowNumber, { failed_attempts: 0, locked_until: '', updated_at: now_() });
      return {
        sessionToken: createPasswordSession_(user),
        mustChangePassword: normalizeBoolean_(freshCredential.must_change_password)
      };
    });
    user._authMode = 'USERNAME_PASSWORD';
    user._mustChangePassword = loginResult.mustChangePassword;
    writeAudit_(user, 'LOGIN_SUCCESS', '', '', { auth_provider: 'USERNAME_PASSWORD' });
    return success_({
      sessionToken: loginResult.sessionToken,
      bootstrap: tryBuildAppBootstrap_(user)
    });
  } catch (error) {
    if (error && error.code === 'INVALID_CREDENTIALS') {
      console.warn(JSON.stringify({ code: 'LOGIN_FAILED' }));
      return { success: false, code: 'INVALID_CREDENTIALS', message: 'Nama pengguna atau kata sandi salah.' };
    }
    return publicError_(error);
  } finally {
    suppliedPassword = '';
  }
}

function prepareCredentialUpdate_(userId, username, password) {
  var normalizedUsername = normalizeUsername_(username);
  var suppliedPassword = password === null || password === undefined ? '' : String(password);
  var existing = findRecord_('AUTH_CREDENTIALS', 'user_id', userId);
  assert_(isValidUsername_(normalizedUsername), 'INVALID_USERNAME', 'Nama pengguna harus 4–64 karakter: huruf kecil, angka, titik, garis bawah, atau tanda hubung.');
  var usernameOwner = findCredentialByUsername_(normalizedUsername);
  assert_(!usernameOwner || normalizeString_(usernameOwner.user_id) === userId,
    'USERNAME_EXISTS', 'Nama pengguna sudah digunakan.');
  if (existing) {
    assert_(normalizeUsername_(existing.username) === normalizedUsername,
      'USERNAME_IMMUTABLE', 'Nama pengguna tidak dapat diubah. Buat akun baru jika diperlukan.');
    if (!suppliedPassword) return { existing: existing, changes: null };
  } else {
    if (!suppliedPassword) suppliedPassword = PASSWORD_POLICY.DEFAULT_INITIAL_PASSWORD;
  }
  validatePassword_(suppliedPassword);
  var iterations = getPasswordIterations_();
  var salt = createSecureToken_();
  var hash = derivePasswordHash_(suppliedPassword, salt, iterations);
  suppliedPassword = '';
  return {
    existing: existing,
    changes: {
      username: normalizedUsername,
      password_salt: salt,
      password_hash: hash,
      hash_algorithm: 'ITERATED_HMAC_SHA256_V1',
      hash_iterations: iterations,
      failed_attempts: 0,
      locked_until: '',
      password_changed_at: now_(),
      updated_at: now_(),
      must_change_password: true
    }
  };
}

function applyCredentialUpdate_(userId, prepared) {
  if (!prepared.changes) return;
  if (prepared.existing) {
    updateRecord_('AUTH_CREDENTIALS', prepared.existing._rowNumber, prepared.changes);
    revokeSessionsForUser_(userId);
    return;
  }
  var record = prepared.changes;
  record.credential_id = 'CRED_' + Utilities.getUuid();
  record.user_id = userId;
  record.created_at = now_();
  appendRecord_('AUTH_CREDENTIALS', record);
}

function recordFailedLogin_(credential, user) {
  withScriptLock_(function () {
    var fresh = findRecord_('AUTH_CREDENTIALS', 'credential_id', credential.credential_id);
    if (!fresh) return;
    var attempts = Number(fresh.failed_attempts || 0) + 1;
    var maximum = Number(getRequiredProperty_(SCRIPT_PROPERTY_KEYS.LOGIN_MAX_ATTEMPTS));
    var changes = { failed_attempts: attempts, updated_at: now_() };
    if (attempts >= maximum) {
      var lockMinutes = Number(getRequiredProperty_(SCRIPT_PROPERTY_KEYS.LOGIN_LOCK_MINUTES));
      changes.locked_until = new Date(Date.now() + lockMinutes * 60 * 1000);
      changes.failed_attempts = 0;
    }
    updateRecord_('AUTH_CREDENTIALS', fresh._rowNumber, changes);
  });
  writeAudit_(user, 'LOGIN_FAILED', '', '', { auth_provider: 'USERNAME_PASSWORD' });
}

function createPasswordSession_(user) {
  var hours = Number(getRequiredProperty_(SCRIPT_PROPERTY_KEYS.APP_SESSION_HOURS));
  assert_(isFinite(hours) && hours > 0 && hours <= 24, 'SESSION_CONFIGURATION_INVALID', 'APP_SESSION_HOURS harus antara 1 dan 24.');
  var token = createSecureToken_();
  var createdAt = now_();
  appendRecord_('AUTH_SESSIONS', {
    session_id: Utilities.getUuid(),
    token_hash: hashToken_(token),
    user_id: user.user_id,
    created_at: createdAt,
    expires_at: new Date(createdAt.getTime() + hours * 60 * 60 * 1000),
    revoked_at: ''
  });
  return token;
}

function getPasswordSessionUser_(sessionToken) {
  var token = normalizeString_(sessionToken);
  if (!token) return null;
  var session = findRecord_('AUTH_SESSIONS', 'token_hash', hashToken_(token));
  assert_(session, 'SESSION_INVALID', 'Sesi login tidak valid. Silakan masuk kembali.');
  assert_(!session.revoked_at, 'SESSION_REVOKED', 'Sesi login telah berakhir. Silakan masuk kembali.');
  assert_(new Date(session.expires_at).getTime() > Date.now(), 'SESSION_EXPIRED', 'Sesi login sudah kedaluwarsa. Silakan masuk kembali.');
  var userRecord = findRecord_('USERS', 'user_id', session.user_id);
  assert_(userRecord, 'USER_NOT_REGISTERED', 'Pengguna tidak ditemukan. Hubungi administrator.');
  var user = normalizeUserRecord_(userRecord);
  assert_(user.active, 'USER_DISABLED', 'Akun Anda tidak aktif. Hubungi administrator.');
  var credential = findRecord_('AUTH_CREDENTIALS', 'user_id', user.user_id);
  assert_(credential, 'CREDENTIAL_NOT_FOUND', 'Kredensial akun tidak ditemukan. Hubungi administrator.');
  user._authMode = 'USERNAME_PASSWORD';
  user._mustChangePassword = normalizeBoolean_(credential.must_change_password);
  return user;
}

function changeOwnPassword(sessionToken, newPassword, confirmation) {
  var suppliedPassword = newPassword === null || newPassword === undefined ? '' : String(newPassword);
  var suppliedConfirmation = confirmation === null || confirmation === undefined ? '' : String(confirmation);
  try {
    var user = getPasswordSessionUser_(sessionToken);
    assert_(user._mustChangePassword,
      'PASSWORD_CHANGE_NOT_REQUIRED', 'Perubahan ini hanya tersedia untuk kata sandi sementara.');
    assert_(suppliedPassword === suppliedConfirmation,
      'PASSWORD_CONFIRMATION_MISMATCH', 'Konfirmasi kata sandi tidak sama.');
    validatePassword_(suppliedPassword);
    assert_(suppliedPassword !== PASSWORD_POLICY.DEFAULT_INITIAL_PASSWORD,
      'DEFAULT_PASSWORD_NOT_ALLOWED', 'Pilih kata sandi baru selain kata sandi awal admin123.');

    var currentCredential = findRecord_('AUTH_CREDENTIALS', 'user_id', user.user_id);
    assert_(currentCredential, 'CREDENTIAL_NOT_FOUND', 'Kredensial akun tidak ditemukan. Hubungi administrator.');
    var repeatedHash = derivePasswordHash_(
      suppliedPassword,
      currentCredential.password_salt,
      Number(currentCredential.hash_iterations)
    );
    assert_(!constantTimeEquals_(repeatedHash, normalizeString_(currentCredential.password_hash)),
      'PASSWORD_UNCHANGED', 'Kata sandi baru harus berbeda dari kata sandi sementara.');

    var currentIterations = Number(currentCredential.hash_iterations);
    var iterations = getPasswordIterations_();
    var salt = normalizeString_(currentCredential.password_salt);
    var hash = repeatedHash;
    if (currentIterations !== iterations) {
      salt = createSecureToken_();
      hash = derivePasswordHash_(suppliedPassword, salt, iterations);
    }
    var replacementToken = withScriptLock_(function () {
      var credential = findRecord_('AUTH_CREDENTIALS', 'user_id', user.user_id);
      assert_(credential, 'CREDENTIAL_NOT_FOUND', 'Kredensial akun tidak ditemukan. Hubungi administrator.');
      assert_(normalizeString_(credential.password_hash) === normalizeString_(currentCredential.password_hash),
        'SESSION_REVOKED', 'Kata sandi sementara telah berubah. Silakan masuk kembali.');
      updateRecord_('AUTH_CREDENTIALS', credential._rowNumber, {
        password_salt: salt,
        password_hash: hash,
        hash_algorithm: 'ITERATED_HMAC_SHA256_V1',
        hash_iterations: iterations,
        failed_attempts: 0,
        locked_until: '',
        password_changed_at: now_(),
        updated_at: now_(),
        must_change_password: false
      });
      revokeSessionsForUser_(user.user_id);
      return createPasswordSession_(user);
    });
    user._authMode = 'USERNAME_PASSWORD';
    user._mustChangePassword = false;
    writeAudit_(user, 'PASSWORD_CHANGED', '', '', { auth_provider: 'USERNAME_PASSWORD' });
    return success_({
      sessionToken: replacementToken,
      bootstrap: tryBuildAppBootstrap_(user)
    });
  } catch (error) {
    return publicError_(error);
  } finally {
    suppliedPassword = '';
    suppliedConfirmation = '';
  }
}

function resetAdminPassword() {
  var callerEmail = normalizeEmail_(Session.getActiveUser().getEmail());
  var configuredAdminEmail = normalizeEmail_(getRequiredProperty_(SCRIPT_PROPERTY_KEYS.ADMIN_EMAIL));
  assert_(callerEmail && callerEmail === configuredAdminEmail,
    'ADMIN_PASSWORD_RESET_DENIED',
    'Reset kata sandi administrator hanya boleh dijalankan langsung dari editor oleh ADMIN_EMAIL.');

  var recovered = withScriptLock_(function () {
    var adminRecord = findUserByEmail_(configuredAdminEmail);
    assert_(adminRecord, 'ADMIN_USER_NOT_FOUND',
      'Akun administrator tidak ditemukan. Periksa sheet USERS dan ADMIN_EMAIL.');
    var adminUser = normalizeUserRecord_(adminRecord);
    assert_(adminUser.active && adminUser.role === ROLES.ADMIN,
      'ADMIN_USER_INVALID', 'Akun ADMIN_EMAIL harus aktif dan memiliki peran ADMIN.');

    var credential = findRecord_('AUTH_CREDENTIALS', 'user_id', adminUser.user_id);
    var credentialCreated = !credential;
    var username = credential
      ? normalizeUsername_(credential.username)
      : availableAdminRecoveryUsername_(configuredAdminEmail, adminUser.user_id);
    assert_(isValidUsername_(username), 'ADMIN_USERNAME_INVALID',
      'Username administrator tidak dapat dibuat atau dipulihkan.');

    var prepared = prepareCredentialUpdate_(
      adminUser.user_id,
      username,
      PASSWORD_POLICY.DEFAULT_INITIAL_PASSWORD
    );
    applyCredentialUpdate_(adminUser.user_id, prepared);
    return { user: adminUser, username: username, credentialCreated: credentialCreated };
  });

  writeAudit_(recovered.user, 'ADMIN_PASSWORD_RESET', '', '', {
    target_user_id: recovered.user.user_id,
    target_username: recovered.username,
    credential_created: recovered.credentialCreated,
    forced_password_change: true,
    reset_by_google_email: callerEmail
  });
  return {
    success: true,
    username: recovered.username,
    credentialCreated: recovered.credentialCreated,
    mustChangePassword: true,
    message: recovered.credentialCreated
      ? 'Kredensial administrator dibuat. Masuk dengan username yang ditampilkan dan kata sandi sementara admin123, lalu segera buat kata sandi baru.'
      : 'Kata sandi administrator direset ke kata sandi awal. Masuk dengan admin123 lalu segera buat kata sandi baru.'
  };
}

function availableAdminRecoveryUsername_(adminEmail, userId) {
  var localPart = normalizeString_(adminEmail).split('@')[0].toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '.')
    .replace(/^[._-]+|[._-]+$/g, '');
  var base = localPart ? 'admin.' + localPart : 'administrator';
  base = base.slice(0, 60).replace(/[._-]+$/g, '') || 'administrator';
  var candidates = ['admin', base];
  for (var suffix = 2; suffix <= 99; suffix += 1) {
    candidates.push(base.slice(0, 61) + '.' + suffix);
  }
  for (var index = 0; index < candidates.length; index += 1) {
    var candidate = normalizeUsername_(candidates[index]);
    if (!isValidUsername_(candidate)) continue;
    var owner = findCredentialByUsername_(candidate);
    if (!owner || normalizeString_(owner.user_id) === normalizeString_(userId)) return candidate;
  }
  throw appError_('ADMIN_USERNAME_UNAVAILABLE',
    'Tidak dapat membuat username pemulihan administrator yang unik. Periksa AUTH_CREDENTIALS.');
}

function logoutPasswordSession(sessionToken) {
  try {
    var user = getPasswordSessionUser_(sessionToken);
    var session = findRecord_('AUTH_SESSIONS', 'token_hash', hashToken_(sessionToken));
    updateRecord_('AUTH_SESSIONS', session._rowNumber, { revoked_at: now_() });
    writeAudit_(user, 'LOGOUT', '', '', { auth_provider: 'USERNAME_PASSWORD' });
    return success_(null);
  } catch (error) {
    return publicError_(error);
  }
}

function revokeSessionsForUser_(userId) {
  readAllRecords_('AUTH_SESSIONS').forEach(function (session) {
    if (normalizeString_(session.user_id) === userId && !session.revoked_at) {
      updateRecord_('AUTH_SESSIONS', session._rowNumber, { revoked_at: now_() });
    }
  });
}

function findCredentialByUsername_(username) {
  var expected = normalizeUsername_(username);
  var credentials = readAllRecords_('AUTH_CREDENTIALS');
  for (var i = 0; i < credentials.length; i += 1) {
    if (normalizeUsername_(credentials[i].username) === expected) return credentials[i];
  }
  return null;
}

function normalizeUsername_(username) {
  return normalizeString_(username).toLowerCase();
}

function isValidUsername_(username) {
  return /^[a-z0-9._-]{4,64}$/.test(username);
}

function validatePassword_(password) {
  assert_(password.length >= PASSWORD_POLICY.MIN_LENGTH && password.length <= PASSWORD_POLICY.MAX_LENGTH,
    'WEAK_PASSWORD', 'Kata sandi harus 6-128 karakter.');
}

function getPasswordIterations_() {
  var iterations = Number(getRequiredProperty_(SCRIPT_PROPERTY_KEYS.PASSWORD_HASH_ITERATIONS));
  assert_(isFinite(iterations) && iterations >= 1000 && iterations <= 100000,
    'PASSWORD_CONFIGURATION_INVALID', 'PASSWORD_HASH_ITERATIONS harus antara 1000 dan 100000.');
  return Math.floor(iterations);
}

function derivePasswordHash_(password, salt, iterations) {
  var pepper = getRequiredProperty_(SCRIPT_PROPERTY_KEYS.PASSWORD_PEPPER);
  var block = String(password) + ':' + String(salt);
  for (var i = 0; i < iterations; i += 1) {
    block = Utilities.base64EncodeWebSafe(
      Utilities.computeHmacSha256Signature(block, pepper, Utilities.Charset.UTF_8)
    ).replace(/=+$/g, '');
  }
  return block;
}

function constantTimeEquals_(left, right) {
  left = String(left || '');
  right = String(right || '');
  var mismatch = left.length ^ right.length;
  var length = Math.max(left.length, right.length);
  for (var i = 0; i < length; i += 1) {
    mismatch |= (left.charCodeAt(i % Math.max(left.length, 1)) || 0) ^ (right.charCodeAt(i % Math.max(right.length, 1)) || 0);
  }
  return mismatch === 0;
}

function createSecureToken_() {
  return (Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

function hashToken_(token) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(token), Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(digest).replace(/=+$/g, '');
}
