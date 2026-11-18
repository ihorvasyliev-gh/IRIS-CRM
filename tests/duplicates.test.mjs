import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duplicateQuery, findIrisDuplicates, findIrisRegistrations, irisFormInfo, isStrongMatch, openIrisIntervention, phoneTail } from '../extension/lib.js';

// An individual's form in IRIS: labelled fields over contact attributes, and the contacts IRIS would return.
function fakeForm({ labels, rows = [], id = '', formType = 1 }) {
  const queries = [];
  const controls = labels.map(([label, name]) => ({
    getLabel: () => label,
    getAttribute: () => (name ? { getName: () => name } : null),
  }));
  const Xrm = {
    Page: {
      ui: { controls: { get: () => controls }, getFormType: () => formType },
      data: { entity: { getEntityName: () => 'contact', getId: () => id } },
      getAttribute: () => null,
    },
    Utility: {
      getEntityMetadata: async () => ({ PrimaryIdAttribute: 'contactid', PrimaryNameAttribute: 'fullname' }),
      getGlobalContext: () => ({ getClientUrl: () => 'https://sicap.crm4.dynamics.com' }),
    },
    WebApi: {
      retrieveMultipleRecords: async (entity, options) => {
        queries.push(`${entity}${options}`);
        return { entities: rows };
      },
    },
  };
  return { Xrm, queries };
}

async function inPage(Xrm, fn) {
  const saved = { window: globalThis.window, location: globalThis.location };
  globalThis.window = { Xrm };
  globalThis.location = { search: '?appid=app-1&pagetype=entityrecord', origin: 'https://sicap.crm4.dynamics.com' };
  try {
    return await fn();
  } finally {
    Object.assign(globalThis, saved);
  }
}

const INDIVIDUAL = [['First Name', 'firstname'], ['Last Name', 'lastname'], ['Email', 'emailaddress1'], ['Mobile No.', 'mobilephone'], ['Date of Birth', 'birthdate'], ['Timeline', null]];
const ANNA = { first_name: ' Anna ', last_name: 'Kowalska', email: 'anna@x.ie', phone: '+353 87 123 4567', dob: '1990-04-23' };

test('phone tail and the query from a student', () => {
  assert.equal(phoneTail('+353 87 123 4567'), '1234567');
  assert.equal(phoneTail('12'), '');
  assert.deepEqual(duplicateQuery(ANNA), { first: 'Anna', last: 'Kowalska', email: 'anna@x.ie', phoneTail: '1234567', dob: '1990-04-23' });
  assert.equal(duplicateQuery({ first_name: 'A', dob: 'junk' }).dob, '');
});

test('which form is open', async () => {
  assert.equal((await inPage(undefined, () => irisFormInfo())).kind, 'none');
  assert.deepEqual(await inPage(fakeForm({ labels: INDIVIDUAL }).Xrm, () => irisFormInfo()), { kind: 'individual', isNew: true, entity: 'contact' });
  const intervention = fakeForm({ labels: [['Action', 'a'], ['Intervention Type', 'b']], formType: 2 }).Xrm;
  assert.deepEqual(await inPage(intervention, () => irisFormInfo()), { kind: 'intervention', isNew: false, entity: 'contact' });
  assert.equal((await inPage(fakeForm({ labels: [['Name', 'n']] }).Xrm, () => irisFormInfo())).kind, 'other');
  const grid = fakeForm({ labels: [] }).Xrm;
  grid.Page = {};
  assert.deepEqual(await inPage(grid, () => irisFormInfo()), { kind: 'page' });
});

test('duplicates: searched by the form\'s own fields, matched and linked', async () => {
  const rows = [
    { contactid: 'c1', fullname: 'Anna Kowalska', firstname: 'Anna', lastname: 'Kowalska', emailaddress1: 'ANNA@x.ie', mobilephone: '087 123 4567', birthdate: '1990-04-23' },
    { contactid: 'c2', fullname: 'Anna Kowalska', firstname: 'Anna', lastname: 'Kowalska', emailaddress1: 'other@x.ie', mobilephone: '0861111111', birthdate: '1985-01-01' },
    { contactid: 'self', fullname: 'This form', firstname: 'Anna', lastname: 'Kowalska' },
    { contactid: 'c3', fullname: 'Phone lookalike', firstname: 'Bob', lastname: 'B', mobilephone: '0851234567999' },
  ];
  const { Xrm, queries } = fakeForm({ labels: INDIVIDUAL, rows, id: '{SELF}' });
  const result = await inPage(Xrm, () => findIrisDuplicates(duplicateQuery(ANNA)));
  assert.equal(result.ok, true);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /^contact\?\$select=contactid,fullname,firstname,lastname,emailaddress1,mobilephone,birthdate&/);
  assert.match(queries[0], /emailaddress1 eq 'anna@x\.ie' or contains\(mobilephone,'1234567'\) or contains\(mobilephone,'123 4567'\) or \(firstname eq 'Anna' and lastname eq 'Kowalska'\)/);
  // The record on the form itself counts too: a saved form may be this very person.
  assert.deepEqual(result.matches.map((m) => [m.id, m.why]), [
    ['c1', ['email', 'phone', 'name', 'date of birth']],
    ['c2', ['name']],
    ['self', ['name']],
  ]);
  assert.deepEqual(result.schema, { entity: 'contact', f: { first: 'firstname', last: 'lastname', email: 'emailaddress1', phone: 'mobilephone', dob: 'birthdate' } });

  // Away from the form, the learnt field names are used.
  const grid = fakeForm({ labels: [], rows });
  grid.Xrm.Page = {};
  const away = await inPage(grid.Xrm, () => findIrisDuplicates(duplicateQuery(ANNA), result.schema));
  assert.equal(away.matches.length, 3);
  assert.match(grid.queries[0], /^contact\?\$select=contactid,fullname,firstname,lastname,emailaddress1,mobilephone,birthdate&/);
  assert.deepEqual(await inPage(grid.Xrm, () => findIrisDuplicates(duplicateQuery(ANNA))), { ok: false, error: 'no-form' });
  assert.equal(result.matches[0].url, 'https://sicap.crm4.dynamics.com/main.aspx?appid=app-1&pagetype=entityrecord&etn=contact&id=c1');
  assert.equal(isStrongMatch(result.matches[0]), true);
  assert.equal(isStrongMatch(result.matches[1]), false);
  assert.equal(isStrongMatch({ why: ['name', 'date of birth'] }), true);
});

test('duplicates: quotes escaped, no form, not an individual form, IRIS error', async () => {
  const { Xrm, queries } = fakeForm({ labels: INDIVIDUAL });
  await inPage(Xrm, () => findIrisDuplicates({ first: "Ann'a", last: "O'Brien", email: '', phoneTail: '', dob: '' }));
  assert.match(queries[0], /firstname eq 'Ann''a' and lastname eq 'O''Brien'/);
  assert.deepEqual(await inPage(undefined, () => findIrisDuplicates(duplicateQuery(ANNA))), { ok: false, error: 'no-form' });
  const other = fakeForm({ labels: [['Action', 'a']] }).Xrm;
  assert.deepEqual(await inPage(other, () => findIrisDuplicates(duplicateQuery(ANNA))), { ok: false, error: 'not-individual' });
  const broken = fakeForm({ labels: INDIVIDUAL }).Xrm;
  broken.WebApi.retrieveMultipleRecords = async () => { throw new Error('Access denied'); };
  assert.deepEqual(await inPage(broken, () => findIrisDuplicates(duplicateQuery(ANNA))), { ok: false, error: 'Access denied' });
});

// A saved individual's form that can open other forms.
function individualForm({ first = 'Anna', last = 'Kowalska', id = '{C1}', relationships = [] } = {}) {
  const opened = [];
  const values = { 'First Name': first, 'Last Name': last };
  const controls = Object.entries(values).map(([label, v]) => ({ getLabel: () => label, getAttribute: () => ({ getValue: () => v }) }));
  const Xrm = {
    Page: {
      ui: { controls: { get: () => controls } },
      data: { entity: { getEntityName: () => 'contact', getId: () => id, getPrimaryAttributeValue: () => `${first} ${last}` } },
    },
    Utility: { getGlobalContext: () => ({ getClientUrl: () => 'https://sicap.crm4.dynamics.com' }) },
    Navigation: { openForm: (options) => { opened.push(options); return new Promise(() => {}); } },
  };
  const fetches = [];
  const fetch = async (url) => { fetches.push(url); return { json: async () => ({ value: relationships.map((e) => ({ ReferencingEntity: e })) }) }; };
  return { Xrm, opened, fetches, fetch };
}

async function withFetch(fetch, fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = saved;
  }
}

test('new intervention from an individual: the known table, linked to the individual', async () => {
  const form = individualForm();
  const result = await inPage(form.Xrm, () => openIrisIntervention('sic_intervention', { first: 'anna', last: 'KOWALSKA' }));
  assert.deepEqual(result, { ok: true, entity: 'sic_intervention', name: 'Anna Kowalska' });
  assert.deepEqual(form.opened, [{ entityName: 'sic_intervention', createFromEntity: { entityType: 'contact', id: 'C1', name: 'Anna Kowalska' } }]);
});

test('new intervention: the table looked up among those pointing at individuals', async () => {
  const form = individualForm({ relationships: ['annotation', 'sic_individualintervention', 'sic_interventionnote', 'sic_individualintervention'] });
  const result = await withFetch(form.fetch, () => inPage(form.Xrm, () => openIrisIntervention(null, null)));
  assert.equal(result.entity, 'sic_individualintervention');
  assert.match(form.fetches[0], /EntityDefinitions\(LogicalName='contact'\)\/OneToManyRelationships/);
  const unclear = individualForm({ relationships: ['a_intervention', 'b_intervention'] });
  assert.deepEqual(await withFetch(unclear.fetch, () => inPage(unclear.Xrm, () => openIrisIntervention(null, null))), { ok: false, error: 'unknown-entity' });
  assert.equal(unclear.opened.length, 0);
});

test('new intervention: refused for another person, an unsaved form, no form', async () => {
  const zoe = individualForm({ first: 'Zoë', last: "O'Neill" });
  assert.equal((await inPage(zoe.Xrm, () => openIrisIntervention('x', { first: 'Zoe', last: 'ONeill' }))).ok, true);
  const other = individualForm();
  assert.deepEqual(await inPage(other.Xrm, () => openIrisIntervention('x', { first: 'Olena', last: 'Kowalska' })), { ok: false, error: 'other-person', name: 'Anna Kowalska' });
  assert.equal(other.opened.length, 0);
  const unsaved = individualForm({ id: '' });
  assert.deepEqual(await inPage(unsaved.Xrm, () => openIrisIntervention('x', null)), { ok: false, error: 'unsaved' });
  assert.deepEqual(await inPage(undefined, () => openIrisIntervention('x', null)), { ok: false, error: 'no-form' });
});

// A new intervention form opened from an individual, and the interventions IRIS already has.
function registrationForm({ individual = { id: '{C1}', name: 'Anna Kowalska', entityType: 'contact' }, rows = [] } = {}) {
  const attr = (name, value, options) => ({ getName: () => name, getValue: () => value, getOptions: () => options || [] });
  const controls = [
    ['Action', attr('sic_actionid', [{ id: 'a', name: '(2026) 09', entityType: 'sic_action' }])],
    ['Individual', attr('sic_individualid', individual ? [individual] : null)],
    ['Intervention Type', attr('sic_type', null, [{ value: 7, text: 'One-to-one meeting' }, { value: 8, text: 'Labour market related course' }])],
    ['Date of Intervention', attr('sic_date', null)],
    ['Case Notes', attr('sic_notes', null)],
  ].map(([label, a]) => ({ getLabel: () => label, getAttribute: () => a }));
  const queries = [];
  const Xrm = {
    Page: { ui: { controls: { get: () => controls } }, data: { entity: { getEntityName: () => 'sic_intervention', getId: () => '' } } },
    Utility: {
      getEntityMetadata: async () => ({ PrimaryIdAttribute: 'sic_interventionid', PrimaryNameAttribute: 'sic_name' }),
      getGlobalContext: () => ({ getClientUrl: () => 'https://sicap.crm4.dynamics.com' }),
    },
    WebApi: { retrieveMultipleRecords: async (entity, options) => { queries.push(`${entity}${options}`); return { entities: rows }; } },
  };
  return { Xrm, queries };
}

test('registrations: an earlier "Reg" one-to-one of the same individual is found', async () => {
  const rows = [
    { sic_interventionid: 'i1', sic_notes: 'Reg', sic_date: '2026-03-12' },
    { sic_interventionid: 'i2', sic_notes: 'Outcome: working', sic_date: '2026-06-01' },
    { sic_interventionid: 'i3', sic_notes: ' registration meeting', sic_date: '2026-04-01T23:00:00Z' },
  ];
  const { Xrm, queries } = registrationForm({ rows });
  const result = await inPage(Xrm, () => findIrisRegistrations('contact'));
  assert.equal(result.ok, true);
  assert.equal(result.name, 'Anna Kowalska');
  assert.equal(queries[0], 'sic_intervention?$select=sic_interventionid,sic_type,sic_notes,sic_date&$filter=_sic_individualid_value eq C1 and sic_type eq 7&$top=20');
  assert.deepEqual(result.matches.map((m) => m.notes), ['Reg', 'registration meeting']);
  assert.equal(result.matches[0].date, '2026-03-12');
  assert.match(result.matches[0].url, /etn=sic_intervention&id=i1$/);
});

test('registrations: no individual on the form, unknown table, not an intervention', async () => {
  assert.deepEqual(await inPage(registrationForm({ individual: null }).Xrm, () => findIrisRegistrations('contact')), { ok: false, error: 'no-individual' });
  assert.deepEqual(await inPage(registrationForm().Xrm, () => findIrisRegistrations(null)), { ok: false, error: 'no-individual' });
  assert.deepEqual(await inPage(fakeForm({ labels: INDIVIDUAL }).Xrm, () => findIrisRegistrations('contact')), { ok: false, error: 'not-intervention' });
});

test('registrations: away from the form, by the learnt fields and the individual id', async () => {
  const rows = [{ sic_interventionid: 'i1', sic_notes: 'Reg', sic_date: '2026-03-12' }];
  const { Xrm } = registrationForm({ rows });
  const first = await inPage(Xrm, () => findIrisRegistrations('contact'));
  assert.deepEqual(first.schema, { entity: 'sic_intervention', individual: 'sic_individualid', type: 'sic_type', oneToOne: 7, notes: 'sic_notes', date: 'sic_date' });
  const grid = registrationForm({ rows });
  grid.Xrm.Page = {};
  const away = await inPage(grid.Xrm, () => findIrisRegistrations('contact', first.schema, '{C9}'));
  assert.equal(grid.queries[0], 'sic_intervention?$select=sic_interventionid,sic_type,sic_notes,sic_date&$filter=_sic_individualid_value eq C9 and sic_type eq 7&$top=20');
  assert.equal(away.matches.length, 1);
  assert.deepEqual(await inPage(grid.Xrm, () => findIrisRegistrations('contact', null, 'C9')), { ok: false, error: 'no-form' });
});
