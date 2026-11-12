import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_OCCUPATION_OPTIONS,
  guessContract,
  matchOption,
  occupationKey,
  suggestOccupations,
  words,
} from '../extension/occupations.js';

// The list as IRIS shows it: "Communication" is shortened there.
const IRIS = DEFAULT_OCCUPATION_OPTIONS.map((name) => (name.startsWith('Communication') ? 'Communication' : name));
const top = (text, memory) => {
  const first = suggestOccupations(text, IRIS, memory)[0];
  return first ? first.option : null;
};

test('words: lower case, no accents or apostrophes, Cyrillic kept', () => {
  assert.deepEqual(words("McDonald's, Crèche & Co."), ['mcdonalds', 'creche', 'co']);
  assert.deepEqual(words('Прибирання в готелі'), ['прибирання', 'в', 'готелі']);
  assert.deepEqual(words(null), []);
});

test('the built-in list is the 25 census groups', () => {
  assert.equal(DEFAULT_OCCUPATION_OPTIONS.length, 25);
  assert.equal(new Set(DEFAULT_OCCUPATION_OPTIONS).size, 25);
  for (const name of ['Army occupations', 'Electrical trades workers', 'Engineering and allied trades workers']) {
    assert.ok(DEFAULT_OCCUPATION_OPTIONS.includes(name), name);
  }
});

test('matchOption: the IRIS wording of a name, exact before shortened', () => {
  assert.equal(matchOption(IRIS, ['Communication, warehouse and transport workers']), 'Communication');
  assert.equal(matchOption(IRIS, ['sales OCCUPATIONS']), 'Sales occupations');
  assert.equal(matchOption(['Other manufacturing', 'Other professional workers'], ['Other manufacturing workers']), 'Other manufacturing');
  assert.equal(matchOption(['Other', 'Teachers'], ['Other gainful occupations']), null);
  assert.equal(matchOption([], ['Teachers']), null);
});

test('suggest: plain sectors and jobs', () => {
  const expected = {
    Retail: 'Sales occupations',
    IT: 'Computer software occupations',
    'Software engineer': 'Computer software occupations',
    'Civil engineer': 'Scientific and technical occupations',
    Hospitality: 'Personal service and childcare workers',
    'Cleaner in a hotel': 'Personal service and childcare workers',
    'Kitchen porter': 'Personal service and childcare workers',
    'Healthcare assistant': 'Health and related workers',
    'Nursing home': 'Health and related workers',
    'Creche / nursery': 'Personal service and childcare workers',
    Construction: 'Building and construction workers',
    'Warehouse operative': 'Communication',
    'Delivery driver': 'Communication',
    'Office administrator': 'Clerical and office workers',
    'Hotel receptionist': 'Clerical and office workers',
    Accountant: 'Business and commerce occupations',
    'Shop manager': 'Managers and executives',
    'Primary school teacher': 'Teachers',
    'Meat factory': 'Food, drink and tobacco production workers',
    'Factory, production line': 'Other manufacturing workers',
    Electrician: 'Electrical trades workers',
    Welder: 'Engineering and allied trades workers',
    Farm: 'Farming, fishing and forestry workers',
    'Sewing alterations': 'Textile, clothing and leather workers',
    'City Council': 'Central and local government workers',
    Translator: 'Other professional workers',
    'Social care worker': 'Social workers and related occupations',
  };
  for (const [text, option] of Object.entries(expected)) assert.equal(top(text), option, text);
});

test('suggest: employers, Ukrainian and Russian, and whole words only where it matters', () => {
  assert.equal(top('Dunnes Stores'), 'Sales occupations');
  assert.equal(top('Lidl warehouse'), 'Communication');
  assert.equal(top('прибирання в готелі'), 'Personal service and childcare workers');
  assert.equal(top('будівництво'), 'Building and construction workers');
  assert.equal(top('Водитель'), 'Communication');
  assert.equal(top('медсестра'), 'Health and related workers');
  // "deli" is not "delivery", "nurse" is not "nursery", "pharma" is not "pharmacy".
  assert.equal(top('Deli counter'), 'Sales occupations');
  assert.equal(top('Nursery'), null);
  assert.equal(top('Pharmacy'), 'Health and related workers');
  assert.equal(top('Pharma'), 'Chemical, paper, wood, rubber, plastics, and printing workers');
});

test('suggest: runners-up come with the reason, nothing for an unknown answer', () => {
  const list = suggestOccupations('Hotel receptionist', IRIS);
  assert.deepEqual(list.map((x) => x.option), ['Clerical and office workers', 'Personal service and childcare workers']);
  assert.deepEqual(list[0].why, { kind: 'word', text: 'receptionist' });
  assert.deepEqual(suggestOccupations('Musgrave', IRIS), []);
  assert.deepEqual(suggestOccupations('', IRIS), []);
  // A group IRIS does not offer is never suggested.
  assert.deepEqual(suggestOccupations('Retail', ['Teachers']), []);
});

test('memory: the same answer wins outright, a longer answer gets it as a hint', () => {
  const memory = {
    [occupationKey('Musgrave')]: { option: 'Communication', text: 'Musgrave' },
    [occupationKey('Working in a hotel')]: { option: 'Clerical and office workers', text: 'Working in a hotel' },
  };
  assert.equal(occupationKey(' Working at MUSGRAVE, Cork '), 'musgrave');
  const same = suggestOccupations('working at Musgrave', IRIS, memory);
  assert.equal(same[0].option, 'Communication');
  assert.deepEqual(same[0].why, { kind: 'remembered', text: 'Musgrave' });

  const longer = suggestOccupations('Musgrave Ballycurreen', IRIS, memory);
  assert.equal(longer[0].option, 'Communication');
  assert.deepEqual(longer[0].why, { kind: 'similar', text: 'Musgrave' });

  // A choice made for this answer beats the built-in guess, which stays as the runner-up.
  const hotel = suggestOccupations('Hotel', IRIS, memory);
  assert.deepEqual(hotel.map((x) => x.option), ['Clerical and office workers', 'Personal service and childcare workers']);
  // A remembered group that IRIS no longer has is ignored.
  assert.equal(top('Musgrave', { musgrave: { option: 'Gone', text: 'Musgrave' } }), null);
});

test('memory: a remembered employer does not outweigh the job named next to it', () => {
  const memory = { lidl: { option: 'Sales occupations', text: 'Lidl' } };
  assert.equal(top('Lidl', memory), 'Sales occupations');
  assert.equal(top('Lidl warehouse', memory), 'Communication');
});

test('key: an answer made only of filler words is kept as it is', () => {
  assert.equal(occupationKey('Work in Cork'), 'work in cork');
  assert.equal(occupationKey(''), '');
});

test('contract: the last choice, else the only full or part time option', () => {
  const options = ['Full-time', 'Part time (under 30 hours)', 'Seasonal'];
  assert.equal(guessContract('full_time', options), 'Full-time');
  assert.equal(guessContract('part_time', options), 'Part time (under 30 hours)');
  assert.equal(guessContract(null, options), null);
  assert.equal(guessContract('full_time', ['Permanent', 'Temporary']), null);
  assert.equal(guessContract('full_time', ['Permanent', 'Temporary'], { full_time: 'Permanent' }), 'Permanent');
  assert.equal(guessContract('part_time', options, { part_time: 'Seasonal' }), 'Seasonal');
  assert.equal(guessContract('full_time', ['Full-time permanent', 'Full-time temporary']), null);
});
