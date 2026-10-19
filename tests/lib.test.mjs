import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  autoAddressQuery,
  buildSearchFilter,
  fillIrisForm,
  formatDate,
  localDateParts,
  parseIsoDate,
  toIrisFields,
  toIrishLocalPhone,
  typeAutoAddress,
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
  const byKey = Object.fromEntries(toIrisFields(student, '2024-02-01T10:00:00').map((f) => [f.key, f.value]));
  assert.deepEqual(byKey, {
    first_name: 'Anna',
    last_name: 'Kowalska',
    mobile: '0871234567',
    email: 'a@x.ie',
    eircode: 'T12 AB34',
    dob: [1990, 4, 23],
    registration: [2024, 2, 1],
    cab: 'Cork City (17-1)',
  });
  assert.equal(toIrisFields(student, null).find((f) => f.key === 'registration').value, null);
  assert.equal(autoAddressQuery(student), 'T12 AB34');
  assert.equal(autoAddressQuery({ address: '1 Main St' }), '1 Main St');
});


test('registration timestamps become local dates', () => {
  assert.deepEqual(localDateParts('2024-02-01T10:00:00'), [2024, 2, 1]);
  assert.equal(localDateParts(null), null);
  assert.equal(localDateParts('nonsense'), null);
});

function fakeIris(labels, lots) {
  const attrs = {};
  const controls = labels.map((label) => {
    const attr = {
      value: null,
      changed: 0,
      getValue() { return this.value; },
      setValue(v) { this.value = v; },
      fireOnChange() { this.changed++; },
    };
    attrs[label] = attr;
    return { getLabel: () => label, getAttribute: () => attr, getEntityTypes: () => ['sic_cablot'] };
  });
  // A control without an attribute, like a sub-grid.
  controls.push({ getLabel: () => 'Timeline', getAttribute: () => null });
  const queries = [];
  return {
    attrs,
    queries,
    Xrm: {
      Page: { ui: { controls: { get: () => controls } }, getAttribute: () => null },
      Utility: { getEntityMetadata: async () => ({ PrimaryIdAttribute: 'sic_cablotid', PrimaryNameAttribute: 'sic_name' }) },
      WebApi: {
        retrieveMultipleRecords: async (entity, options) => {
          queries.push(`${entity}${options}`);
          return { entities: lots };
        },
      },
    },
  };
}

class FakeInput {
  constructor(attrs = {}) {
    Object.assign(this, { placeholder: '', title: '', id: '', name: '', className: '', type: 'text', disabled: false, readOnly: false }, attrs);
    this.events = [];
    this.focused = false;
    this._v = '';
  }
  get value() { return this._v; }
  set value(v) { this._v = v; }
  getAttribute(name) { return name === 'aria-label' ? this.ariaLabel || null : null; }
  focus() { this.focused = true; }
  dispatchEvent(e) { this.events.push(e.type); }
}

function withPage({ Xrm, inputs = [] }, fn) {
  const keys = ['window', 'document', 'location', 'HTMLInputElement', 'KeyboardEvent'];
  const saved = Object.fromEntries(keys.map((k) => [k, globalThis[k]]));
  globalThis.HTMLInputElement = FakeInput;
  globalThis.KeyboardEvent = class extends Event {};
  globalThis.window = { Xrm };
  globalThis.location = { href: 'https://sicap.crm4.dynamics.com/main.aspx' };
  globalThis.document = {
    querySelectorAll: (sel) => (sel === 'input' ? inputs : sel === 'iframe' ? [{ src: '/WebResources/aa.html' }] : []),
  };
  const restore = () => keys.forEach((k) => { globalThis[k] = saved[k]; });
  return Promise.resolve().then(() => fn()).finally(restore);
}

const ANNA = { first_name: 'Anna', last_name: 'Kowalska', email: '', phone: '+353871234567', eircode: 'T12AB34', dob: '1990-04-23' };
const LABELS = ['CAB/Lot', 'First Name', 'Last Name', 'Mobile No.', 'Email', 'Date of Birth', 'Date of Registration Meeting'];

test('fill: sets fields found by label and reports the rest', async () => {
  const lot = { sic_cablotid: 'lot-1', sic_name: 'Cork City (17-1)' };
  const { attrs, queries, Xrm } = fakeIris(LABELS, [lot]);
  await withPage({ Xrm }, async () => {
    const result = await fillIrisForm(toIrisFields(ANNA, '2024-02-01T10:00:00'));
    assert.equal(result.ok, true);
    const status = Object.fromEntries(result.results.map((r) => [r.key, r.status]));
    assert.deepEqual(status, {
      first_name: 'filled', last_name: 'filled', mobile: 'filled', email: 'empty',
      eircode: 'not-found', dob: 'filled', registration: 'filled', cab: 'filled',
    });
    assert.equal(attrs['Mobile No.'].value, '0871234567');
    assert.equal(attrs['First Name'].changed, 1);
    const dob = attrs['Date of Birth'].value;
    assert.deepEqual([dob.getFullYear(), dob.getMonth(), dob.getDate()], [1990, 3, 23]);
    const reg = attrs['Date of Registration Meeting'].value;
    assert.deepEqual([reg.getFullYear(), reg.getMonth(), reg.getDate()], [2024, 1, 1]);
    assert.deepEqual(attrs['CAB/Lot'].value, [{ id: 'lot-1', name: 'Cork City (17-1)', entityType: 'sic_cablot' }]);
    assert.match(queries[0], /^sic_cablot\?\$select=sic_cablotid,sic_name/);
    assert.deepEqual(result.frames, ['sicap.crm4.dynamics.com/WebResources/aa.html']);
  });
});

test('fill: CAB/Lot picks the Cork City lot among several, keeps a chosen one, asks when unsure', async () => {
  const lots = [{ sic_cablotid: 'a', sic_name: 'Kerry (5-1)' }, { sic_cablotid: 'b', sic_name: 'Cork City (17-1)' }];
  let iris = fakeIris(['CAB/Lot'], lots);
  await withPage({ Xrm: iris.Xrm }, async () => {
    await fillIrisForm(toIrisFields(ANNA, null));
    assert.equal(iris.attrs['CAB/Lot'].value[0].id, 'b');
    const again = await fillIrisForm(toIrisFields(ANNA, null));
    assert.equal(again.results.find((r) => r.key === 'cab').status, 'kept');
  });
  iris = fakeIris(['CAB/Lot'], [lots[0], { sic_cablotid: 'c', sic_name: 'Dublin (1-1)' }]);
  await withPage({ Xrm: iris.Xrm }, async () => {
    const result = await fillIrisForm(toIrisFields(ANNA, null));
    assert.equal(result.results.find((r) => r.key === 'cab').status, 'choose');
    assert.equal(iris.attrs['CAB/Lot'].value, null);
  });
});

test('fill: says so when the page is not an IRIS form', async () => {
  await withPage({}, async () => {
    assert.deepEqual(await fillIrisForm([]), { ok: false, error: 'no-form' });
  });
});

test('Auto Address: types into the box, never into the County / Dublin Postcode field', async () => {
  const county = new FakeInput({ ariaLabel: 'County / Dublin Postcode' });
  const box = new FakeInput({ placeholder: 'Enter Full Address or Postcode' });
  await withPage({ inputs: [county, box] }, () => {
    assert.equal(typeAutoAddress('P51X768'), 'typed');
    assert.equal(box.value, 'P51X768');
    assert.ok(box.focused);
    assert.ok(box.events.includes('input'));
    assert.equal(county.value, '');
  });
  await withPage({ inputs: [county] }, () => {
    assert.equal(typeAutoAddress('P51X768'), 'not-found');
  });
});
