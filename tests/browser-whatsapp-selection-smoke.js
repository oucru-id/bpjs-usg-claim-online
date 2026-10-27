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
localStorage.setItem('bpjs_app_session', 'whatsapp-test-token');
window.__whatsappSendArgs = null;
window.confirm = function () { return true; };
window.google = { script: {} };
(function () {
  var study = {
    study_key: 'study-selection-test', patient_name: 'PASIEN UJI', patient_nik: '0000000000000000',
    patient_phone: '081234567890', doctor_name: 'DOKTER UJI', study_date: '2026-10-25',
    whatsapp_ready: true, image_count: 3, delivery_state: 'PARTIAL',
    sent_object_keys: ['image-001'], pending_object_keys: [],
    images: [
      { object_key: 'image-001', sequence_number: 1, frame_index: 0 },
      { object_key: 'image-002', sequence_number: 2, frame_index: 0 },
      { object_key: 'image-003', sequence_number: 3, frame_index: 0 }
    ]
  };
  function makeRunner(state) {
    return new Proxy({}, { get: function (_, property) {
      if (property === 'withSuccessHandler') return function (handler) { return makeRunner({ success: handler, failure: state.failure }); };
      if (property === 'withFailureHandler') return function (handler) { return makeRunner({ success: state.success, failure: handler }); };
      return function () {
        var args = Array.prototype.slice.call(arguments);
        var response = null;
        if (property === 'getAppBootstrap') response = { success: true, data: {
          appVersion: 'selection-test', authMode: 'USERNAME_PASSWORD', mustChangePassword: false,
          features: { mobile_qr_upload: false, orthanc_bridge: false, whatsapp_delivery: true },
          user: { user_id: 'USER-1', google_email: 'staff@example.test', full_name: 'Staff Test',
            role: 'STAFF', facility_id: 'FAC-1', facility_name: 'Puskesmas Test',
            can_create_claim: false, can_view_all_claims: false, can_generate_pdf: false,
            can_download_pdf: false, can_send_whatsapp: true, can_manage_users: false }
        } };
        if (property === 'listWhatsAppPatients') response = { success: true, data: {
          items: [study], summary: { total: 1, not_sent: 0, pending: 0, partial: 1, sent: 0 }
        } };
        if (property === 'getWhatsAppImagePreview') response = {
          success: true, data: { mime_type: 'image/jpeg', base64: '/9j/2Q==' }
        };
        if (property === 'sendWhatsAppImages') {
          window.__whatsappSendArgs = args;
          response = { success: true, data: study };
        }
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
  result.id = 'browser-whatsapp-selection-result';
  result.textContent = 'PENDING';
  document.body.appendChild(result);
  function fail(error) { result.textContent = 'FAIL: ' + (error && error.message ? error.message : error); }
  window.setTimeout(function () {
    try {
      var checkboxes = Array.from(document.querySelectorAll('.whatsapp-image-select input'));
      if (checkboxes.length !== 3) throw new Error('three photo selectors were not rendered');
      if (!checkboxes[0].disabled) throw new Error('already-sent photo can still be selected');
      if (checkboxes[1].disabled || checkboxes[2].disabled) throw new Error('unsent photos cannot be selected');
      var send = document.querySelector('.whatsapp-study-footer .primary');
      if (!send || !send.disabled || send.textContent !== 'Pilih Foto') throw new Error('send button did not require a selection');
      checkboxes[1].click();
      if (send.disabled || send.textContent !== 'Kirim 1 Foto Terpilih') throw new Error('one-photo selection did not enable sending');
      send.click();
      window.setTimeout(function () {
        try {
          if (!window.__whatsappSendArgs) throw new Error('send endpoint was not called');
          var selected = window.__whatsappSendArgs[2];
          if (!Array.isArray(selected) || selected.length !== 1 || selected[0] !== 'image-002') {
            throw new Error('endpoint did not receive exactly the checked photo');
          }
          result.textContent = 'PASS';
        } catch (error) { fail(error); }
      }, 100);
    } catch (error) { fail(error); }
  }, 300);
}());
</script>`;

let html = read('Index.html')
  .replace('<?!= include_(\'Styles\'); ?>', read('Styles.html'))
  .replace('<?!= include_(\'Components\'); ?>', read('Components.html'))
  .replace('<?!= includeOptional_(\'VendorQrCode\'); ?>', read('VendorQrCode.html'))
  .replace('<?!= include_(\'Scripts\'); ?>', mockServer + read('Scripts.html') + browserAssertions)
  .replace(/<\?= initialView \?>/g, 'whatsapp')
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
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bpjs-usg-whatsapp-edge-'));
  try {
    const child = spawn(edgePath, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--window-size=1280,900', '--virtual-time-budget=2500', `--user-data-dir=${profilePath}`, '--dump-dom',
      `http://127.0.0.1:${port}/`
    ], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Edge timeout')); }, 20000);
      child.once('error', reject);
      child.once('close', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
    });
    assert.strictEqual(code, 0, stderr);
    const match = stdout.match(/id="browser-whatsapp-selection-result"[^>]*>([^<]*)</);
    assert(match, 'Browser result marker was not found.');
    assert.strictEqual(match[1], 'PASS', match[1]);
    console.log('WhatsApp per-photo selection passed in Microsoft Edge (headless).');
  } finally {
    server.close();
    fs.rmSync(profilePath, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
