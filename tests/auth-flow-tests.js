const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const scriptsHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'Scripts.html'), 'utf8');
const scriptMatch = scriptsHtml.match(/<script>([\s\S]*)<\/script>/);
assert(scriptMatch, 'Scripts.html must contain a script block.');

function makeClassList(initial) {
  const values = new Set(initial || []);
  return {
    add(value) { values.add(value); },
    remove(value) { values.delete(value); },
    contains(value) { return values.has(value); },
    toggle(value, force) {
      if (force === undefined) force = !values.has(value);
      if (force) values.add(value); else values.delete(value);
      return force;
    }
  };
}

function makeElement(id) {
  const fields = {};
  const element = {
    id,
    classList: makeClassList(id === 'login-view' || id === 'password-change-view' || id === 'app-shell' ? ['hidden'] : []),
    dataset: {},
    disabled: false,
    readOnly: false,
    textContent: id === 'login-button' ? 'Masuk' : (id === 'password-change-button' ? 'Simpan Kata Sandi Baru' : ''),
    value: '',
    focused: false,
    listeners: {},
    addEventListener(name, handler) { this.listeners[name] = handler; },
    focus() { this.focused = true; },
    reset() { Object.values(fields).forEach((field) => { field.value = ''; }); },
    appendChild() {},
    removeChild() {},
    setAttribute() {},
    showModal() {},
    close() {}
  };
  element.elements = new Proxy(fields, {
    get(target, property) {
      if (!target[property]) target[property] = makeElement(`${id}-${String(property)}`);
      return target[property];
    }
  });
  return element;
}

function createHarness(initialToken) {
  const elements = {};
  const calls = [];
  const storageValues = {};
  if (initialToken) storageValues.bpjs_app_session = initialToken;
  const storage = {
    getItem(key) { return storageValues[key] || null; },
    setItem(key, value) { storageValues[key] = String(value); },
    removeItem(key) { delete storageValues[key]; }
  };
  const document = {
    body: { dataset: { initialView: 'dashboard', initialClaimId: '', initialMobileToken: '' }, classList: makeClassList() },
    getElementById(id) {
      if (!elements[id]) elements[id] = makeElement(id);
      return elements[id];
    },
    querySelectorAll() { return []; },
    createElement(tag) { return makeElement(tag); }
  };
  const bootstrap = (mustChangePassword) => ({
    appVersion: 'test',
    authMode: 'USERNAME_PASSWORD',
    mustChangePassword,
    features: { mobile_qr_upload: false, orthanc_bridge: false },
    user: {
      user_id: 'USER-1', google_email: 'staff@example.test', full_name: 'Staff Test',
      role: 'STAFF', facility_id: 'FAC-1', facility_name: 'Puskesmas Test',
      can_create_claim: false, can_view_all_claims: false,
      can_generate_pdf: false, can_download_pdf: false, can_manage_users: false
    }
  });
  const responses = {
    loginWithPassword: () => ({ success: true, data: { sessionToken: 'temporary-token', bootstrap: bootstrap(true) } }),
    changeOwnPassword: () => ({ success: true, data: { sessionToken: 'regular-token', bootstrap: bootstrap(false) } }),
    getAppBootstrap: () => ({ success: true, data: bootstrap(true) })
  };
  function runner(state) {
    return new Proxy({}, {
      get(target, property) {
        if (property === 'withSuccessHandler') return (handler) => runner({ ...state, success: handler });
        if (property === 'withFailureHandler') return (handler) => runner({ ...state, failure: handler });
        return (...args) => {
          calls.push({ name: property, args });
          if (responses[property] && state.success) state.success(responses[property](args));
        };
      }
    });
  }
  const context = {
    console,
    document,
    localStorage: storage,
    sessionStorage: storage,
    google: { script: { get run() { return runner({}); } } },
    window: { setTimeout(handler) { handler(); }, location: { href: '' } },
    URL: { revokeObjectURL() {}, createObjectURL() { return 'blob:test'; } },
    Blob: function Blob() {},
    navigator: {}
  };
  vm.runInNewContext(scriptMatch[1], context, { filename: 'Scripts.html' });
  return { elements, calls, storageValues };
}

const fresh = createHarness('');
assert.deepStrictEqual(fresh.calls, [], 'A page without a stored session must not call the server before login.');
assert(!fresh.elements['login-view'].classList.contains('hidden'), 'Login form must be visible without a session.');
assert(fresh.elements['login-form'].elements.username.focused, 'Username field must receive focus.');

fresh.elements['login-form'].elements.username.value = 'staff';
fresh.elements['login-form'].elements.password.value = 'admin123';
fresh.elements['login-form'].listeners.submit({ preventDefault() {}, currentTarget: fresh.elements['login-form'] });
assert.deepStrictEqual(fresh.calls.map((call) => call.name), ['loginWithPassword'], 'Initial-password login must complete in one server call.');
assert(!fresh.elements['password-change-view'].classList.contains('hidden'), 'Password-change form must be visible.');
assert(!fresh.elements['password-change-form'].elements.new_password.disabled, 'New-password field must be enabled.');
assert(!fresh.elements['password-change-form'].elements.new_password.readOnly, 'New-password field must be editable.');
assert(fresh.elements['password-change-form'].elements.new_password.focused, 'New-password field must receive focus.');

fresh.elements['password-change-form'].elements.new_password.value = 'new-password';
fresh.elements['password-change-form'].elements.password_confirmation.value = 'new-password';
fresh.elements['password-change-form'].listeners.submit({ preventDefault() {}, currentTarget: fresh.elements['password-change-form'] });
assert(!fresh.calls.some((call) => call.name === 'getAppBootstrap'), 'Password change must use the bootstrap returned by the same call.');
assert.strictEqual(fresh.storageValues.bpjs_app_session, 'regular-token', 'Replacement session must be stored.');
assert(!fresh.elements['app-shell'].classList.contains('hidden'), 'Application must open after password change.');

const returning = createHarness('stored-token');
assert.strictEqual(returning.calls[0].name, 'getAppBootstrap', 'A stored session must be restored with one bootstrap call.');
assert(!returning.elements['password-change-view'].classList.contains('hidden'), 'Stored temporary session must open password change.');

console.log('Authentication responsiveness and password-change UI checks passed.');
