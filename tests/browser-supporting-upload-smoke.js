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
window.google = { script: {} };
window.__uploadedPayloads = [];
window.pdfjsLib = {
  getDocument: function (options) {
    var signature = String.fromCharCode.apply(null, Array.prototype.slice.call(options.data, 0, 4));
    if (signature !== '%PDF') return { promise: Promise.reject(new Error('invalid test PDF')) };
    return { promise: Promise.resolve({
      numPages: 1,
      getPage: function () { return Promise.resolve({
        getViewport: function (options) { return { width: 595 * options.scale, height: 842 * options.scale }; },
        render: function (options) {
          options.canvasContext.fillStyle = '#ffffff';
          options.canvasContext.fillRect(0, 0, options.viewport.width, options.viewport.height);
          options.canvasContext.fillStyle = '#111111';
          options.canvasContext.fillText('Berkas BPJS', 20, 40);
          return { promise: Promise.resolve() };
        },
        cleanup: function () {}
      }); },
      cleanup: function () {},
      destroy: function () { return Promise.resolve(); }
    }) };
  },
  GlobalWorkerOptions: {}
};
(function () {
  function makeRunner(state) {
    return new Proxy({}, { get: function (_, property) {
      if (property === 'withSuccessHandler') return function (handler) { return makeRunner({ success: handler, failure: state.failure }); };
      if (property === 'withFailureHandler') return function (handler) { return makeRunner({ success: state.success, failure: handler }); };
      return function () {
        var args = Array.prototype.slice.call(arguments);
        if (property === 'getAppBootstrap' && state.success) {
          window.setTimeout(function () { state.success({ success: false, code: 'SESSION_REQUIRED', message: 'Masuk.' }); }, 0);
        }
        if (property === 'uploadMobileDocument') {
          window.__uploadedPayloads.push(args[2]);
          if (state.success) window.setTimeout(function () { state.success({ success: true, data: {} }); }, 0);
        }
        if (property === 'listMobileDocuments' && state.success) {
          window.setTimeout(function () { state.success({ success: true, data: [] }); }, 0);
        }
      };
    }});
  }
  Object.defineProperty(window.google.script, 'run', { get: function () { return makeRunner({}); } });
}());
</script>`;

const browserAssertions = `<script>
(function () {
  var result = document.createElement('div');
  result.id = 'browser-supporting-upload-result';
  result.textContent = 'PENDING';
  document.body.appendChild(result);

  function fail(error) { result.textContent = 'FAIL: ' + (error && error.message ? error.message : error); }
  function minimalPdfBytes() {
    var stream = 'BT /F1 18 Tf 30 100 Td (Berkas BPJS) Tj ET';
    var objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      '<< /Length ' + stream.length + ' >>\\nstream\\n' + stream + '\\nendstream'
    ];
    var pdf = '%PDF-1.4\\n';
    var offsets = [0];
    objects.forEach(function (object, index) {
      offsets.push(pdf.length);
      pdf += (index + 1) + ' 0 obj\\n' + object + '\\nendobj\\n';
    });
    var xrefOffset = pdf.length;
    pdf += 'xref\\n0 ' + (objects.length + 1) + '\\n0000000000 65535 f \\n';
    offsets.slice(1).forEach(function (offset) { pdf += String(offset).padStart(10, '0') + ' 00000 n \\n'; });
    pdf += 'trailer\\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\\nstartxref\\n' + xrefOffset + '\\n%%EOF';
    return new TextEncoder().encode(pdf);
  }

  window.setTimeout(function () {
    try {
      var inputs = Array.prototype.slice.call(document.querySelectorAll('[data-claim-document-type], [data-mobile-type]'));
      if (inputs.length !== 8) throw new Error('supporting-document inputs are incomplete');
      inputs.forEach(function (input) {
        if (input.hasAttribute('capture')) throw new Error('camera capture is still forced');
        if (input.accept !== 'application/pdf,image/jpeg,image/png') throw new Error('PDF/photo accept list is wrong');
      });
      var file = new File([minimalPdfBytes()], 'berkas-uji.pdf', { type: 'application/pdf' });
      var transfer = new DataTransfer();
      transfer.items.add(file);
      var mobileInput = document.querySelector('[data-mobile-type="KTP"]');
      mobileInput.files = transfer.files;
      mobileInput.dispatchEvent(new Event('change', { bubbles: true }));
      var attempts = 0;
      var checkUpload = window.setInterval(function () {
        attempts += 1;
        if (!window.__uploadedPayloads.length && attempts < 100) return;
        window.clearInterval(checkUpload);
        try {
          if (window.__uploadedPayloads.length !== 1) throw new Error('one-page PDF did not produce one upload: ' + document.getElementById('mobile-upload-progress').textContent);
          var payload = window.__uploadedPayloads[0];
          if (payload.mime_type !== 'image/jpeg' || !payload.base64 || !payload.thumbnail_base64) throw new Error('PDF page payload is incomplete');
          if (payload.width > 720 || payload.height > 1280) throw new Error('portrait PDF exceeds HD limits');
          if (payload.original_filename !== 'berkas-uji.pdf - halaman 1') throw new Error('PDF page filename is wrong');
          result.textContent = 'PASS';
        } catch (error) { fail(error); }
      }, 100);
    } catch (error) { fail(error); }
  }, 100);
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
  const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bpjs-usg-edge-supporting-'));
  try {
    const child = spawn(edgePath, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--window-size=390,844', '--virtual-time-budget=15000', `--user-data-dir=${profilePath}`, '--dump-dom',
      `http://127.0.0.1:${port}/`
    ], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exitCode = await new Promise((resolve) => child.on('close', resolve));
    assert.strictEqual(exitCode, 0, `Edge exited with ${exitCode}: ${stderr}`);
    const resultMatch = stdout.match(/<div id="browser-supporting-upload-result">([^<]+)<\/div>/);
    assert(resultMatch, 'Browser result marker was not found in the rendered DOM.');
    assert.strictEqual(resultMatch[1], 'PASS', resultMatch[1]);
    console.log('Supporting PDF/photo picker and PDF-page processing passed in Microsoft Edge (headless).');
  } finally {
    server.close();
    fs.rmSync(profilePath, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
