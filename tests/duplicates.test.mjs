import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duplicateQuery, findIrisDuplicates, irisFormInfo, isStrongMatch, phoneTail } from '../extension/lib.js';

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
  assert.deepEqual(result.matches.map((m) => [m.name, m.why]), [
    ['Anna Kowalska', ['email', 'phone', 'name', 'date of birth']],
    ['Anna Kowalska', ['name']],
  ]);
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
