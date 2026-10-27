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
      features: { mobile_qr_upload: false, orthanc_bridge: true },
      user: { user_id: 'USER-1', google_email: 'staff@example.test', full_name: 'Staff Test',
        role: 'STAFF', facility_id: 'FAC-1', facility_name: 'Puskesmas Test',
        can_create_claim: true, can_view_all_claims: false, can_generate_pdf: false,
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
        if (property === 'listOrthancInbox') response = { success: true, data: [{
          inbox_id: 'INBOX-1', updated_at: '2026-10-10T10:00:00Z', patient_name: '',
          patient_nik_candidate: '', doctor_name_candidate: '', study_date: '2026-10-06',
          received_images: 1, skipped_images: 0, status: 'READY'
        }] };
        if (property === 'listClaimFacilities') response = { success: true, data: [
          { facility_id: 'FAC-1', facility_name: 'Puskesmas Test' }
        ] };
        if (property === 'getOrthancInboxDetail') response = { success: true, data: {
          inbox_id: 'INBOX-1', patient_name: '', patient_id: '', patient_comments: '',
          patient_nik_candidate: '', doctor_name_candidate: 'dr. Test', metadata_warning: '',
          patient_birth_date: '', study_date: '2026-10-06', received_dicoms: 1,
          expected_dicoms: 1, skipped_images: 0, skipped_dicoms: 0,
          images: [{ image_id: '11111111-1111-4111-8111-111111111111', image_width: 1024, image_height: 768, imported: false }]
        } };
        if (property === 'getOrthancInboxThumbnail' || property === 'getOrthancInboxPreview') response = {
          success: true, data: { mime_type: 'image/jpeg', base64: '/9j/2Q==' }
        };
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
              var claimDoctor = document.querySelector('#claim-form [name="doctor_name"]');
              var orthancDoctor = document.querySelector('#orthanc-import-form [name="doctor_name"]');
              if (!claimPhone || claimPhone.type !== 'tel' || !claimPhone.required) throw new Error('claim No. HP field is not usable');
              if (!orthancPhone || orthancPhone.type !== 'tel' || !orthancPhone.required) throw new Error('Orthanc No. HP field is not usable');
              if (!claimDoctor || !claimDoctor.required) throw new Error('claim doctor field is not usable');
              if (!orthancDoctor || !orthancDoctor.required) throw new Error('Orthanc doctor field is not usable');
              var orthancHeaders = Array.from(document.querySelectorAll('.orthanc-table th')).map(function (cell) { return cell.textContent; });
              if (orthancHeaders.indexOf('NIK terdeteksi') < 0 || orthancHeaders.indexOf('Dokter terdeteksi') < 0) throw new Error('flexible DICOM metadata columns are missing');
              var orthancNikHelp = document.querySelector('#orthanc-import-form [name="patient_nik"] + .muted');
              if (!orthancNikHelp || orthancNikHelp.textContent.indexOf('ID atau Comment DICOM') < 0) throw new Error('flexible NIK source guidance is missing');
              if (!document.getElementById('claim-detail-phone') || !document.getElementById('pdf-confirm-phone')) throw new Error('No. HP display fields are missing');
              if (!document.getElementById('claim-detail-doctor') || !document.getElementById('pdf-confirm-doctor')) throw new Error('doctor display fields are missing');
              document.getElementById('orthanc-nav-button').click();
              window.setTimeout(function () {
                try {
                  var reviewButton = Array.from(document.querySelectorAll('#orthanc-inbox-body button')).find(function (button) { return button.textContent === 'Tinjau'; });
                  if (!reviewButton) throw new Error('Orthanc review action was not rendered');
                  reviewButton.click();
                  window.setTimeout(function () {
                    try {
                      var orthancForm = document.getElementById('orthanc-import-form');
                      if (!document.getElementById('orthanc-import-dialog').open) throw new Error('Orthanc review dialog did not open');
                      if (orthancForm.elements.doctor_name.value !== 'dr. Test') throw new Error('Orthanc doctor candidate was not prefilled');
                      orthancForm.elements.patient_name.value = 'Pasien Test';
                      orthancForm.elements.patient_nik.value = '1234567890123456';
                      orthancForm.elements.patient_phone.value = '081234567890';
                      orthancForm.elements.patient_birth_date.value = '2026-10-02';
                      orthancForm.elements.examination_date.value = '2026-09-16';
                      orthancForm.elements.confirmed_patient.checked = true;
                      orthancForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                      var orthancMessage = document.getElementById('orthanc-import-message');
                      if (orthancMessage.classList.contains('hidden')) throw new Error('Orthanc validation message hidden');
                      if (orthancMessage.textContent !== 'Tanggal lahir tidak boleh setelah tanggal pemeriksaan USG.') throw new Error('wrong Orthanc date message');
                      if (window.__authCalls.indexOf('createClaimFromOrthanc') >= 0) throw new Error('invalid Orthanc dates reached server');
                      orthancForm.elements.patient_birth_date.value = '1996-10-02';
                      orthancForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                      if (orthancMessage.textContent !== 'Sedang membuat klaim serta menyalin gambar USG dan DICOM asli. Mohon tunggu...') throw new Error('Orthanc progress message missing');
                      window.setTimeout(function () {
                        try {
                          if (orthancMessage.textContent !== 'Server menolak klaim.') throw new Error('server error not shown in Orthanc dialog');
                          var importButton = document.getElementById('import-orthanc-button');
                          if (importButton.disabled) throw new Error('Orthanc import button stayed disabled');
                          if (importButton.textContent !== 'Buat Klaim dari Orthanc') throw new Error('Orthanc import button label not restored');
                          var previewButton = document.querySelector('.orthanc-preview-button');
                          var orthancCheckbox = document.querySelector('#orthanc-image-grid [data-orthanc-image-id]');
                          if (!previewButton || previewButton.type !== 'button') throw new Error('Orthanc preview button is missing');
                          if (!orthancCheckbox || !orthancCheckbox.checked) throw new Error('Orthanc image selection did not initialize');
                          previewButton.click();
                          if (!orthancCheckbox.checked) throw new Error('opening preview changed Orthanc image selection');
                          window.setTimeout(function () {
                            try {
                              var previewDialog = document.getElementById('preview-dialog');
                              var previewImage = document.getElementById('preview-image');
                              if (!previewDialog.open) throw new Error('Orthanc full-image preview did not open');
                              if (document.getElementById('preview-title').textContent !== 'Gambar USG 1') throw new Error('Orthanc preview title is wrong');
                              if (!previewImage.src.startsWith('data:image/jpeg;base64,')) throw new Error('Orthanc full-image preview was not loaded');
                              if (window.__authCalls.indexOf('getOrthancInboxPreview') < 0) throw new Error('Orthanc full-image endpoint was not called');
                              document.getElementById('close-preview-dialog').click();
                              if (previewDialog.open) throw new Error('Orthanc full-image preview did not close');
                              result.textContent = 'PASS';
                            } catch (error) { fail(error); }
                          }, 50);
                        } catch (error) { fail(error); }
                      }, 50);
                    } catch (error) { fail(error); }
                  }, 50);
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

function waitForBrowser(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (child.stdout) child.stdout.destroy();
      if (child.stderr) child.stderr.destroy();
      child.kill('SIGKILL');
      reject(new Error(`Microsoft Edge did not finish within ${timeoutMs / 1000} seconds.`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

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
    const exitCode = await waitForBrowser(child, 60000);
    assert.strictEqual(exitCode, 0, `Edge exited with ${exitCode}: ${stderr}`);
    const resultMatch = stdout.match(/<div id="browser-auth-smoke-result">([^<]+)<\/div>/);
    assert(resultMatch, 'Browser result marker was not found in the rendered DOM.');
    assert.strictEqual(resultMatch[1], 'PASS', resultMatch[1]);
    console.log('Browser authentication smoke test passed in Microsoft Edge (headless).');
  } finally {
    server.close();
    fs.rmSync(profilePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
