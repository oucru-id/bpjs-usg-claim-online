const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const sourceRoot = path.join(projectRoot, 'src');
const read = (name) => fs.readFileSync(path.join(sourceRoot, name), 'utf8');

const mockServer = `<script>
window.__authCalls = [];
window.google = { script: {} };
(function () {
  function bootstrap(mustChangePassword) {
    return {
      appVersion: 'browser-test', authMode: 'USERNAME_PASSWORD', mustChangePassword: mustChangePassword,
      features: { mobile_qr_upload: false, orthanc_bridge: false },
      user: { user_id: 'USER-1', google_email: 'staff@example.test', full_name: 'Staff Test',
        role: 'STAFF', facility_id: 'FAC-1', facility_name: 'Puskesmas Test',
        can_create_claim: false, can_view_all_claims: false, can_generate_pdf: false,
        can_download_pdf: false, can_manage_users: false }
    };
  }
  function makeRunner(state) {
    return new Proxy({}, { get: function (_, property) {
      if (property === 'withSuccessHandler') return function (handler) { return makeRunner({ success: handler, failure: state.failure }); };
      if (property === 'withFailureHandler') return function (handler) { return makeRunner({ success: state.success, failure: handler }); };
      return function () {
        window.__authCalls.push(String(property));
        var response = null;
        if (property === 'loginWithPassword') response = { success: true, data: { sessionToken: 'temporary-token', bootstrap: bootstrap(true) } };
        if (property === 'changeOwnPassword') response = { success: true, data: { sessionToken: 'regular-token', bootstrap: bootstrap(false) } };
        if (property === 'createClaimFromOrthanc') response = { success: false, code: 'TEST_REJECTION', message: 'Server menolak klaim.' };
        if (response && state.success) window.setTimeout(function () { state.success(response); }, 0);
      };
    }});
  }
  Object.defineProperty(window.google.script, 'run', { get: function () { return makeRunner({}); } });
}());
</script>`;

const browserAssertions = `<script>
(function () {
  var result = document.createElement('div');
  result.id = 'browser-auth-smoke-result';
  result.textContent = 'PENDING';
  document.body.appendChild(result);
  function fail(error) { result.textContent = 'FAIL: ' + (error && error.message ? error.message : error); }
  window.setTimeout(function () {
    try {
      if (document.getElementById('login-view').classList.contains('hidden')) throw new Error('login form hidden');
      if (document.querySelector('#login-view h1').textContent !== 'Masuk ke Sistem Klaim USG BPJS') throw new Error('application title is stale');
      if (document.querySelector('#login-view > section > p').textContent !== 'Pengelolaan klaim USG, dokumen pendukung, dan data DICOM Orthanc secara terintegrasi.') throw new Error('application description is stale');
      var loginForm = document.getElementById('login-form');
      loginForm.elements.username.value = 'staff';
      loginForm.elements.password.value = 'admin123';
      loginForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      window.setTimeout(function () {
        try {
          var passwordView = document.getElementById('password-change-view');
          var passwordForm = document.getElementById('password-change-form');
          if (passwordView.classList.contains('hidden')) throw new Error('password-change form hidden');
          if (passwordForm.elements.new_password.disabled || passwordForm.elements.new_password.readOnly) throw new Error('new password is not editable');
          passwordForm.elements.new_password.value = 'new-password';
          passwordForm.elements.password_confirmation.value = 'new-password';
          passwordForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          window.setTimeout(function () {
            try {
              if (document.getElementById('app-shell').classList.contains('hidden')) throw new Error('application did not open');
              if (window.__authCalls.indexOf('getAppBootstrap') >= 0) throw new Error('redundant bootstrap call detected');
              var claimPhone = document.querySelector('#claim-form [name="patient_phone"]');
              var orthancPhone = document.querySelector('#orthanc-import-form [name="patient_phone"]');
              if (!claimPhone || claimPhone.type !== 'tel' || !claimPhone.required) throw new Error('claim No. HP field is not usable');
              if (!orthancPhone || orthancPhone.type !== 'tel' || !orthancPhone.required) throw new Error('Orthanc No. HP field is not usable');
              if (!document.getElementById('claim-detail-phone') || !document.getElementById('pdf-confirm-phone')) throw new Error('No. HP display fields are missing');
              document.getElementById('orthanc-import-dialog').showModal();
              var orthancForm = document.getElementById('orthanc-import-form');
              orthancForm.elements.patient_name.value = 'Pasien Test';
              orthancForm.elements.patient_nik.value = '1234567890123456';
              orthancForm.elements.patient_phone.value = '081234567890';
              orthancForm.elements.patient_birth_date.value = '2026-10-02';
              orthancForm.elements.examination_date.value = '2026-09-16';
              orthancForm.elements.facility_id.innerHTML = '<option value="FAC-1" selected>Fasilitas Test</option>';
              orthancForm.elements.confirmed_patient.checked = true;
              orthancForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
              var orthancMessage = document.getElementById('orthanc-import-message');
              if (orthancMessage.classList.contains('hidden')) throw new Error('Orthanc validation message hidden');
              if (orthancMessage.textContent !== 'Tanggal lahir tidak boleh setelah tanggal pemeriksaan USG.') throw new Error('wrong Orthanc date message');
              if (window.__authCalls.indexOf('createClaimFromOrthanc') >= 0) throw new Error('invalid Orthanc dates reached server');
              var selectedImage = document.createElement('input');
              selectedImage.type = 'checkbox';
              selectedImage.checked = true;
              selectedImage.dataset.orthancImageId = 'IMAGE-1';
              document.body.appendChild(selectedImage);
              orthancForm.elements.patient_birth_date.value = '1996-10-02';
              orthancForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
              if (orthancMessage.textContent !== 'Sedang membuat klaim serta menyalin gambar USG dan DICOM asli. Mohon tunggu...') throw new Error('Orthanc progress message missing');
              window.setTimeout(function () {
                try {
                  if (orthancMessage.textContent !== 'Server menolak klaim.') throw new Error('server error not shown in Orthanc dialog');
                  var importButton = document.getElementById('import-orthanc-button');
                  if (importButton.disabled) throw new Error('Orthanc import button stayed disabled');
                  if (importButton.textContent !== 'Buat Klaim dari Orthanc') throw new Error('Orthanc import button label not restored');
                  result.textContent = 'PASS';
                } catch (error) { fail(error); }
              }, 50);
            } catch (error) { fail(error); }
          }, 50);
        } catch (error) { fail(error); }
      }, 50);
    } catch (error) { fail(error); }
  }, 50);
}());
</script>`;

let html = read('Index.html')
  .replace('<?!= include_(\'Styles\'); ?>', read('Styles.html'))
  .replace('<?!= include_(\'Components\'); ?>', read('Components.html'))
  .replace('<?!= includeOptional_(\'VendorQrCode\'); ?>', read('VendorQrCode.html'))
  .replace('<?!= include_(\'Scripts\'); ?>', mockServer + read('Scripts.html') + browserAssertions)
  .replace(/<\?= initialView \?>/g, 'dashboard')
  .replace(/<\?= initialClaimId \?>/g, '')
  .replace(/<\?= initialMobileToken \?>/g, '');

const edgeCandidates = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);
const edgePath = edgeCandidates.find((candidate) => fs.existsSync(candidate));
assert(edgePath, 'Microsoft Edge was not found. Set EDGE_PATH to run the browser smoke test.');

async function main() {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bpjs-usg-edge-'));
  try {
    const child = spawn(edgePath, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--window-size=390,844', '--virtual-time-budget=3000', `--user-data-dir=${profilePath}`, '--dump-dom',
      `http://127.0.0.1:${port}/`
    ], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exitCode = await new Promise((resolve) => child.on('close', resolve));
    assert.strictEqual(exitCode, 0, `Edge exited with ${exitCode}: ${stderr}`);
    const resultMatch = stdout.match(/<div id="browser-auth-smoke-result">([^<]+)<\/div>/);
    assert(resultMatch, 'Browser result marker was not found in the rendered DOM.');
    assert.strictEqual(resultMatch[1], 'PASS', resultMatch[1]);
    console.log('Browser authentication smoke test passed in Microsoft Edge (headless).');
  } finally {
    server.close();
    fs.rmSync(profilePath, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
