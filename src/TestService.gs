function runPhase1SelfTests(sessionToken) {
  var admin = requireRole(ROLES.ADMIN, sessionToken);
  var tests = [];
  function test(name, callback) {
    try { callback(); tests.push({ name: name, ok: true }); }
    catch (error) { tests.push({ name: name, ok: false, message: error.message }); }
  }
  test('Email dinormalisasi', function () { assert_(normalizeEmail_(' Admin@Example.Org ') === 'admin@example.org', 'TEST_FAILED', 'Normalisasi email gagal.'); });
  test('NIK tetap string dan tersamar', function () { assert_(maskNik('0000000000000157') === '************0157', 'TEST_FAILED', 'Masking NIK gagal.'); });
  test('No. HP dinormalisasi', function () {
    assert_(normalizePatientPhone_('+62 812-3456-7890') === '081234567890', 'TEST_FAILED', 'Normalisasi No. HP gagal.');
  });
  test('Token aplikasi disimpan sebagai hash', function () {
    var token = createSecureToken_();
    assert_(token.length >= 64 && hashToken_(token) !== token && hashToken_(token) === hashToken_(token), 'TEST_FAILED', 'Hash token gagal.');
  });
  test('Nama pengguna dinormalisasi', function () {
    assert_(normalizeUsername_(' Staff.01 ') === 'staff.01' && isValidUsername_('staff.01'), 'TEST_FAILED', 'Normalisasi username gagal.');
  });
  test('Kebijakan kata sandi minimum 6 karakter', function () {
    validatePassword_('abcdef');
    rememberPasswordValidationFails_('abcde');
    assert_(PASSWORD_POLICY.DEFAULT_INITIAL_PASSWORD === 'admin123', 'TEST_FAILED', 'Kata sandi awal tidak sesuai.');
  });
  test('Status klaim dikenali', function () {
    assert_(isClaimStatus_(CLAIM_STATUSES.DRAFT) && isClaimStatus_(CLAIM_STATUSES.ARCHIVED) && !isClaimStatus_('DIHAPUS'),
      'TEST_FAILED', 'Validasi status klaim gagal.');
  });
  test('Tanggal klaim divalidasi', function () {
    assert_(claimDateKey_(parseClaimDate_('2026-09-12', 'Tanggal uji')) === '2026-09-12',
      'TEST_FAILED', 'Validasi tanggal klaim gagal.');
  });
  test('Jenis dokumen Fase 3 tersedia', function () {
    assert_(DOCUMENT_TYPE_LABELS.USG === 'Gambar USG' && DOCUMENT_TYPE_LABELS.KTP === 'KTP (Identitas)' &&
      DOCUMENT_TYPE_LABELS.SPP_FKPP_BPJS === 'Berkas SPP & FKPP BPJS' &&
      Object.keys(DOCUMENT_TYPES).length === 5, 'TEST_FAILED', 'Konfigurasi jenis dokumen tidak lengkap.');
  });
  test('Tanda tangan berkas gambar diperiksa', function () {
    assert_(hasImageSignature_([-1, -40, -1, -37], 'image/jpeg') &&
      hasImageSignature_([-119, 80, 78, 71, 13, 10, 26, 10], 'image/png') &&
      !hasImageSignature_([71, 73, 70, 56, 57, 97], 'image/jpeg'),
      'TEST_FAILED', 'Pemeriksaan tanda tangan gambar gagal.');
  });
  test('Token unggah ponsel memiliki entropi dan format yang benar', function () {
    var token = createSecureToken_();
    assert_(token.length === 96 && sanitizeMobileToken_(token) === token && sanitizeMobileToken_('<script>') === '',
      'TEST_FAILED', 'Format token unggah ponsel gagal.');
  });
  test('Akses ADMIN ke semua klaim', function () { assert_(canAccessClaim({ active: true, role: 'ADMIN' }, {}), 'TEST_FAILED', 'Akses ADMIN gagal.'); });
  test('Akses STAFF lintas fasilitas ditolak', function () {
    assert_(!canAccessClaim({ active: true, role: 'STAFF', google_email: 'staff@example.org', facility_id: 'A' }, { created_by: 'other@example.org', facility_id: 'B' }), 'TEST_FAILED', 'Pembatasan fasilitas gagal.');
  });
  test('Pengguna saat ini terdaftar dan aktif', function () { assert_(admin.active && admin.google_email, 'TEST_FAILED', 'Pengguna aktif gagal.'); });
  Object.keys(SHEET_SCHEMAS).forEach(function (sheetName) {
    test('Skema ' + sheetName, function () {
      var actual = getSheet_(sheetName).getRange(1, 1, 1, SHEET_SCHEMAS[sheetName].length).getDisplayValues()[0];
      assert_(actual.join('|') === SHEET_SCHEMAS[sheetName].join('|'), 'TEST_FAILED', 'Header berbeda.');
    });
  });
  return { success: tests.every(function (item) { return item.ok; }), tests: tests };
}

function rememberPasswordValidationFails_(password) {
  var failed = false;
  try { validatePassword_(password); }
  catch (error) { failed = error && error.code === 'WEAK_PASSWORD'; }
  assert_(failed, 'TEST_FAILED', 'Kata sandi terlalu pendek tidak ditolak.');
}
