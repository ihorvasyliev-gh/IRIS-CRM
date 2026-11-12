import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  autoAddressQuery,
  buildSearchFilter,
  fillIrisForm,
  formatDate,
  interventionFields,
  isoDate,
  localDateParts,
  monthName,
  monthStart,
  outcomeFields,
  outcomeNote,
  outcomeOptionFields,
  parseIsoDate,
  parseTypedDate,
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
  await withPage({ inputs: [county, box] }, async () => {
    assert.equal(await typeAutoAddress('P51X768', 0), 'typed');
    assert.equal(box.value, 'P51X768');
    assert.ok(box.focused);
    assert.ok(box.events.includes('input'));
    assert.equal(county.value, '');
  });
  await withPage({ inputs: [county] }, async () => {
    assert.equal(await typeAutoAddress('P51X768', 0), 'not-found');
  });
});

test('intervention fields: registration and course', () => {
  const reg = Object.fromEntries(interventionFields('registration', '2025-03-12T09:00:00').map((f) => [f.key, f.value]));
  assert.deepEqual(reg, {
    action: { name: 'SUPPORTS TO NEW ARRIVALS', match: 'contains', preferYear: 2025 },
    staff: true,
    intervention_type: 'One-to-one meeting',
    intervention_date: [2025, 3, 12],
    support_type: { name: 'Career guidance', match: 'exact' },
    case_notes: 'Reg',
    personal_plan: true,
    status_change: 'No',
  });
  const course = interventionFields('course', '2025-03-12T09:00:00', new Date(2026, 9, 19));
  assert.deepEqual(course.map((f) => f.key), ['action', 'staff', 'intervention_type']);
  assert.equal(course[0].value.preferYear, 2026);
  assert.equal(course[2].value, 'Labour market related course');
});

// An intervention form: lookups answer OData filters from `tables`.
function fakeInterventionForm(tables, { staffSet = false } = {}) {
  const attrs = {};
  const make = (label, entity, options) => {
    const attr = {
      value: null,
      getValue() { return this.value; },
      setValue(v) { this.value = v; },
      fireOnChange() {},
      getOptions: () => options || [],
    };
    attrs[label] = attr;
    return { getLabel: () => label, getAttribute: () => attr, getEntityTypes: () => (entity ? [entity] : []) };
  };
  const controls = [
    make('Action', 'sic_action'),
    make('LDC Staff Member', 'sic_staff'),
    make('Date of Intervention'),
    make('Case Notes'),
    make('Personal Plan Agreed'),
    make('Intervention Type', null, [{ value: 1, text: 'One-to-one meeting' }, { value: 2, text: 'Labour market related course' }]),
    make('Support Type', 'sic_support'),
    make('Has there been a change of status or progression outcome for the individual?', null, [{ value: 10, text: 'Yes' }, { value: 11, text: 'No' }]),
  ];
  if (staffSet) attrs['LDC Staff Member'].value = [{ id: 'other', name: 'Someone', entityType: 'sic_staff' }];
  const queries = [];
  const Xrm = {
    Page: { ui: { controls: { get: () => controls } }, getAttribute: () => null },
    Utility: {
      getEntityMetadata: async () => ({ PrimaryIdAttribute: 'id', PrimaryNameAttribute: 'name' }),
      getGlobalContext: () => ({ userSettings: { userName: 'Ihor Vasyliev' } }),
    },
    WebApi: {
      retrieveMultipleRecords: async (entity, options) => {
        queries.push(`${entity}${options}`);
        const filter = decodeURIComponent(options);
        const contains = /contains\(name,'(.*?)'\)/.exec(filter);
        const eq = /name eq '(.*?)'/.exec(filter);
        return {
          entities: (tables[entity] || []).filter((r) =>
            contains ? r.name.includes(contains[1]) : eq ? r.name === eq[1] : true),
        };
      },
    },
  };
  return { attrs, queries, Xrm };
}

const TABLES = {
  sic_action: [
    { id: 'a25', name: '(2025) 09 SUPPORTS TO NEW ARRIVALS' },
    { id: 'a26', name: '(2026) 09 SUPPORTS TO NEW ARRIVALS' },
    { id: 'x', name: '(2026) 01 SOMETHING ELSE' },
  ],
  sic_staff: [{ id: 'me', name: 'Ihor Vasyliev' }, { id: 'other', name: 'Someone' }],
  sic_support: [{ id: 'cg', name: 'Career guidance' }, { id: 'cg2', name: 'Career guidance extra' }],
};

test('fill: registration intervention', async () => {
  const { attrs, Xrm } = fakeInterventionForm(TABLES);
  await withPage({ Xrm }, async () => {
    const result = await fillIrisForm(interventionFields('registration', '2026-03-12T09:00:00'));
    assert.ok(result.results.every((r) => r.status === 'filled'), JSON.stringify(result.results));
    assert.equal(attrs.Action.value[0].id, 'a26');
    assert.deepEqual(attrs['LDC Staff Member'].value, [{ id: 'me', name: 'Ihor Vasyliev', entityType: 'sic_staff' }]);
    assert.equal(attrs['Intervention Type'].value, 1);
    const d = attrs['Date of Intervention'].value;
    assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate()], [2026, 2, 12]);
    assert.equal(attrs['Support Type'].value[0].id, 'cg');
    assert.equal(attrs['Case Notes'].value, 'Reg');
    assert.equal(attrs['Personal Plan Agreed'].value, true);
    assert.equal(attrs['Has there been a change of status or progression outcome for the individual?'].value, 11);
  });
});

test('fill: course intervention keeps a chosen staff member and picks the year', async () => {
  const { attrs, Xrm } = fakeInterventionForm(TABLES, { staffSet: true });
  await withPage({ Xrm }, async () => {
    const result = await fillIrisForm(interventionFields('course', null, new Date(2025, 5, 1)));
    const status = Object.fromEntries(result.results.map((r) => [r.key, r.status]));
    assert.deepEqual(status, { action: 'filled', staff: 'kept', intervention_type: 'filled' });
    assert.equal(attrs.Action.value[0].id, 'a25');
    assert.equal(attrs['Intervention Type'].value, 2);
    assert.equal(attrs['Date of Intervention'].value, null);
  });
});

test('fill: says when IRIS has no such option or record', async () => {
  const { Xrm } = fakeInterventionForm({ sic_action: [], sic_staff: [], sic_support: [] });
  await withPage({ Xrm }, async () => {
    const result = await fillIrisForm([
      ...interventionFields('course', null),
      { key: 'x', labels: ['Intervention Type'], names: [], type: 'option', value: 'Nope' },
    ]);
    const status = result.results.map((r) => r.status);
    assert.deepEqual(status, ['no-match', 'no-match', 'filled', 'no-match']);
  });
});

// The form with its Employment block and Status/Progress fields.
const OCCUPATIONS = ['Army occupations', 'Communication', 'Sales occupations'];
const CONTRACTS = ['Full-time', 'Part-time'];
function fakeOutcomeForm() {
  const form = fakeInterventionForm({
    ...TABLES,
    sic_status: [
      { id: 'ft', name: 'Employed - Full-Time' },
      { id: 'pt', name: 'Employed – Part-time' },
      { id: 'un', name: 'Unemployed - on Live Register' },
      { id: 'se', name: 'Self-Employed' },
    ],
  });
  const controls = form.Xrm.Page.ui.controls.get();
  const add = (label, entity, texts) => {
    const attr = {
      value: null,
      getValue() { return this.value; },
      setValue(v) { this.value = v; },
      fireOnChange() {},
      getOptions: () => (texts || []).map((text, i) => ({ value: 100 + i, text })),
    };
    form.attrs[label] = attr;
    controls.push({ getLabel: () => label, getAttribute: () => attr, getEntityTypes: () => (entity ? [entity] : []) });
  };
  add('Current Economic Status', 'sic_status');
  add('Employment Start Date');
  add('Occupational group', null, ['--Select--', ...OCCUPATIONS]);
  add('Contract Type', null, CONTRACTS);
  form.Xrm.Page.ui.controls.get = () => controls;
  // Tests don't wait for IRIS rules.
  form.quick = (fields) => fields.map((f) => ({ ...f, pauseMs: 0 }));
  return form;
}

const OUTCOME = { interventionDate: '2026-10-12', startDate: '2026-03-01', occupation: 'Sales occupations', contract: 'Part-time', employmentType: 'part_time', text: ' Lidl, Douglas ' };

test('outcome fields: dates, the year of the Action, and what is left for the person', () => {
  assert.equal(monthStart('2026-03'), '2026-03-01');
  assert.equal(monthStart('March'), '');
  assert.equal(monthStart(null), '');
  assert.equal(isoDate([2026, 3, 1]), '2026-03-01');
  assert.equal(isoDate(null), '');
  assert.equal(parseTypedDate('1/3/2026'), '2026-03-01');
  assert.equal(parseTypedDate(' 01.03.2026 '), '2026-03-01');
  assert.equal(parseTypedDate('31/02/2026'), '');
  assert.equal(parseTypedDate('2026-03-01'), '');
  assert.equal(parseTypedDate(''), '');

  const byKey = Object.fromEntries(outcomeFields(OUTCOME).map((f) => [f.key, f.value]));
  assert.deepEqual(byKey, {
    action: { name: 'SUPPORTS TO NEW ARRIVALS', match: 'contains', preferYear: 2026 },
    staff: true,
    intervention_date: [2026, 10, 12],
    case_notes: 'Outcome: working part-time since March 2026 (“Lidl, Douglas”)',
    status_change: 'Yes',
    economic_status: { name: 'Employed - Part-Time', match: 'same', search: 'Employed' },
    employment_start: [2026, 3, 1],
    occupation: 'Sales occupations',
    contract: 'Part-time',
  });
  const bare = Object.fromEntries(
    outcomeFields({ interventionDate: '', startDate: '', occupation: '', contract: '', employmentType: null }, new Date(2027, 0, 5))
      .map((f) => [f.key, f.value]),
  );
  assert.equal(bare.action.preferYear, 2027);
  assert.equal(bare.case_notes, 'Outcome: working');
  assert.equal(monthName('2026-12-01'), 'December 2026');
  assert.equal(monthName(''), '');
  assert.equal(outcomeNote({ text: '', startDate: '2025-11-01', employmentType: 'full_time' }), 'Outcome: working full-time since November 2025');
  assert.deepEqual(
    [bare.intervention_date, bare.economic_status, bare.employment_start, bare.occupation, bare.contract],
    [null, null, null, null, null],
  );
});

test('fill: job outcome', async () => {
  const { attrs, Xrm, quick } = fakeOutcomeForm();
  await withPage({ Xrm }, async () => {
    const result = await fillIrisForm(quick(outcomeFields(OUTCOME)));
    assert.ok(result.results.every((r) => r.status === 'filled'), JSON.stringify(result.results));
    assert.equal(attrs.Action.value[0].id, 'a26');
    const d = attrs['Date of Intervention'].value;
    assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate()], [2026, 9, 12]);
    assert.equal(attrs['Case Notes'].value, 'Outcome: working part-time since March 2026 (“Lidl, Douglas”)');
    assert.equal(attrs['Has there been a change of status or progression outcome for the individual?'].value, 10);
    // Found whatever the dash and the capitals; never "Unemployed" or "Self-Employed".
    assert.equal(attrs['Current Economic Status'].value[0].id, 'pt');
    const start = attrs['Employment Start Date'].value;
    assert.deepEqual([start.getFullYear(), start.getMonth(), start.getDate()], [2026, 2, 1]);
    assert.equal(attrs['Occupational group'].value, 103);
    assert.equal(attrs['Contract Type'].value, 101);
    // The lists come back with the fill, without the "--Select--" line.
    assert.deepEqual(result.results.find((r) => r.key === 'occupation').options, OCCUPATIONS);
    assert.deepEqual(result.results.find((r) => r.key === 'contract').options, CONTRACTS);
  });
});

test('fill: an option under a longer name, one IRIS lacks, and one not chosen', async () => {
  const { attrs, Xrm, quick } = fakeOutcomeForm();
  await withPage({ Xrm }, async () => {
    const result = await fillIrisForm(quick(outcomeFields({
      ...OUTCOME, occupation: 'Communication, warehouse and transport workers', contract: '', employmentType: 'full_time',
    })));
    const byKey = Object.fromEntries(result.results.map((r) => [r.key, r]));
    assert.equal(byKey.occupation.status, 'filled');
    assert.equal(attrs['Occupational group'].value, 102);
    assert.equal(attrs['Current Economic Status'].value[0].id, 'ft');
    assert.equal(byKey.contract.status, 'empty');
    assert.deepEqual(byKey.contract.options, CONTRACTS);
    assert.equal(attrs['Contract Type'].value, null);

    const missing = await fillIrisForm(quick(outcomeFields({ ...OUTCOME, occupation: 'Teachers', employmentType: null })));
    const status = Object.fromEntries(missing.results.map((r) => [r.key, r.status]));
    assert.equal(status.occupation, 'no-match');
    assert.equal(status.economic_status, 'empty');
    // Notes are on the form from the first fill: they stay.
    assert.equal(status.case_notes, 'kept');
    assert.deepEqual(missing.results.find((r) => r.key === 'occupation').options, OCCUPATIONS);
  });
});

test('fill: read-only returns the lists and changes nothing', async () => {
  const { attrs, Xrm } = fakeOutcomeForm();
  await withPage({ Xrm }, async () => {
    const result = await fillIrisForm(outcomeOptionFields(), true);
    assert.deepEqual(result.results, [
      { key: 'occupation', status: 'found', options: OCCUPATIONS },
      { key: 'contract', status: 'found', options: CONTRACTS },
    ]);
    assert.equal(attrs['Occupational group'].value, null);
  });
  // A form without the Employment block.
  const other = fakeInterventionForm(TABLES);
  await withPage({ Xrm: other.Xrm }, async () => {
    const result = await fillIrisForm(outcomeOptionFields(), true);
    assert.deepEqual(result.results.map((r) => r.status), ['not-found', 'not-found']);
  });
});

test('fill: a value IRIS wipes is put back once, and reported when wiped again', async () => {
  const { attrs, Xrm, quick } = fakeOutcomeForm();
  // A rule that clears the start date the first time it is set.
  const start = attrs['Employment Start Date'];
  let wipes = 1;
  start.fireOnChange = () => { if (wipes-- > 0) start.value = null; };
  // And one that never lets the contract stay.
  const contract = attrs['Contract Type'];
  contract.fireOnChange = () => { contract.value = null; };
  await withPage({ Xrm }, async () => {
    const result = await fillIrisForm(quick(outcomeFields(OUTCOME)));
    const status = Object.fromEntries(result.results.map((r) => [r.key, r.status]));
    assert.equal(status.employment_start, 'filled');
    assert.ok(start.value instanceof Date);
    assert.equal(status.contract, 'cleared');
    assert.equal(status.occupation, 'filled');
  });
});

test('the functions sent into the IRIS page use nothing from outside their own body', async () => {
  // chrome.scripting.executeScript sends the source text: rebuild them from it, as the page gets them.
  const rebuilt = (fn) => new Function(`return (${fn.toString()})`)();
  // Chrome also drops every null property of the arguments.
  const asChromeSends = (fields) => JSON.parse(JSON.stringify(fields), (_key, value) => (value === null ? undefined : value));
  const { attrs, Xrm, quick } = fakeOutcomeForm();
  await withPage({ Xrm }, async () => {
    const result = await rebuilt(fillIrisForm)(asChromeSends(quick(outcomeFields(OUTCOME))));
    assert.ok(result.results.every((r) => r.status === 'filled'), JSON.stringify(result.results));
    assert.equal(attrs['Occupational group'].value, 103);

    const bare = await rebuilt(fillIrisForm)(asChromeSends(quick(outcomeFields({ ...OUTCOME, startDate: '', occupation: '', employmentType: null }))));
    const status = Object.fromEntries(bare.results.map((r) => [r.key, r.status]));
    assert.deepEqual([status.employment_start, status.occupation, status.economic_status], ['empty', 'empty', 'empty']);

    const lists = await rebuilt(fillIrisForm)(asChromeSends(outcomeOptionFields()), true);
    assert.deepEqual(lists.results.map((r) => r.status), ['found', 'found']);
  });
  // A student without a date of birth: "nothing in the CRM", not an error.
  const student = fakeIris(LABELS, []);
  await withPage({ Xrm: student.Xrm }, async () => {
    const result = await rebuilt(fillIrisForm)(asChromeSends(toIrisFields({ ...ANNA, dob: null }, null)));
    assert.equal(result.results.find((r) => r.key === 'dob').status, 'empty');
  });
  const box = new FakeInput({ placeholder: 'Enter Full Address or Postcode' });
  await withPage({ inputs: [box] }, async () => {
    assert.equal(await rebuilt(typeAutoAddress)('P51X768', 0), 'typed');
  });
});
