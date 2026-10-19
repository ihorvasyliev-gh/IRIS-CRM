import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  autoAddressQuery,
  buildSearchFilter,
  fillIrisForm,
  formatDate,
  parseIsoDate,
  toIrisFields,
  toIrishLocalPhone,
} from '../extension/lib.js';

test('search: every word must match some field, unsafe characters dropped', () => {
  assert.equal(buildSearchFilter('  '), '');
  assert.equal(
    buildSearchFilter('anna'),
    'first_name.ilike.%anna%,last_name.ilike.%anna%,email.ilike.%anna%,eircode.ilike.%anna%',
  );
  const filter = buildSearchFilter('Anna, (Kowal)');
  assert.match(filter, /^and\(or\(first_name\.ilike\.%Anna%,.*\),or\(first_name\.ilike\.%Kowal%,.*\)\)$/);
  assert.doesNotMatch(filter, /Anna,%|\(Kowal|Kowal\)%/);
});

test('search: a local phone number also matches the +353 form', () => {
  const filter = buildSearchFilter('0871234567');
  assert.match(filter, /phone\.ilike\.%353871234567%/);
  assert.doesNotMatch(buildSearchFilter('anna'), /phone/);
});

test('phone: Irish numbers become local, others stay', () => {
  assert.equal(toIrishLocalPhone('+353871234567'), '0871234567');
  assert.equal(toIrishLocalPhone('+48 600 100 200'), '+48 600 100 200');
  assert.equal(toIrishLocalPhone(null), '');
});

test('dates', () => {
  assert.deepEqual(parseIsoDate('1990-04-23'), [1990, 4, 23]);
  assert.equal(parseIsoDate('23/04/1990'), null);
  assert.equal(formatDate('1990-04-03'), '03/04/1990');
});

test('IRIS fields and Auto Address query from a student', () => {
  const student = { first_name: ' Anna ', last_name: 'Kowalska', email: 'a@x.ie', phone: '+353871234567', eircode: 't12 ab34', dob: '1990-04-23', address: '1 Main St' };
  const byKey = Object.fromEntries(toIrisFields(student).map((f) => [f.key, f.value]));
  assert.deepEqual(byKey, {
    first_name: 'Anna',
    last_name: 'Kowalska',
    mobile: '0871234567',
    email: 'a@x.ie',
    eircode: 'T12 AB34',
    dob: [1990, 4, 23],
  });
  assert.equal(autoAddressQuery(student), 'T12 AB34');
  assert.equal(autoAddressQuery({ address: '1 Main St' }), '1 Main St');
});

function fakeIris(labels) {
  const attrs = {};
  const controls = labels.map((label) => {
    const attr = {
      value: null,
      changed: 0,
      setValue(v) { this.value = v; },
      fireOnChange() { this.changed++; },
    };
    attrs[label] = attr;
    return { getLabel: () => label, getAttribute: () => attr };
  });
  // A control without an attribute, like a sub-grid.
  controls.push({ getLabel: () => 'Timeline', getAttribute: () => null });
  return {
    attrs,
    Xrm: { Page: { ui: { controls: { get: () => controls } }, getAttribute: () => null } },
  };
}

function withPage(Xrm, input, fn) {
  const saved = { window: globalThis.window, document: globalThis.document, HTMLInputElement: globalThis.HTMLInputElement, KeyboardEvent: globalThis.KeyboardEvent };
  class FakeInput {
    constructor() { this.events = []; this.focused = false; this._v = ''; }
    get value() { return this._v; }
    set value(v) { this._v = v; }
    focus() { this.focused = true; }
    dispatchEvent(e) { this.events.push(e.type); }
  }
  globalThis.HTMLInputElement = FakeInput;
  globalThis.KeyboardEvent = class extends Event {};
  globalThis.window = { Xrm };
  const el = input ? new FakeInput() : null;
  globalThis.document = { querySelector: () => el };
  try {
    return fn(el);
  } finally {
    Object.assign(globalThis, saved);
  }
}

test('fill: sets fields found by label, reports the rest, types Auto Address', () => {
  const { attrs, Xrm } = fakeIris(['First Name', 'Last Name', 'Mobile No.', 'Email', 'Date of Birth']);
  const student = { first_name: 'Anna', last_name: 'Kowalska', email: '', phone: '+353871234567', eircode: 'T12AB34', dob: '1990-04-23' };
  withPage(Xrm, true, (input) => {
    const result = fillIrisForm(toIrisFields(student), autoAddressQuery(student));
    assert.equal(result.ok, true);
    const status = Object.fromEntries(result.results.map((r) => [r.key, r.status]));
    assert.deepEqual(status, { first_name: 'filled', last_name: 'filled', mobile: 'filled', email: 'empty', eircode: 'not-found', dob: 'filled' });
    assert.equal(attrs['Mobile No.'].value, '0871234567');
    assert.equal(attrs['First Name'].changed, 1);
    const dob = attrs['Date of Birth'].value;
    assert.deepEqual([dob.getFullYear(), dob.getMonth(), dob.getDate()], [1990, 3, 23]);
    assert.equal(result.address, 'typed');
    assert.equal(input.value, 'T12AB34');
    assert.ok(input.focused);
    assert.ok(input.events.includes('input'));
  });
});

test('fill: says so when the page is not an IRIS form', () => {
  withPage(undefined, false, () => {
    assert.deepEqual(fillIrisForm([], ''), { ok: false, error: 'no-form' });
  });
});
