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
  outcomeOptionFields,
  parseTypedDate,
  toIrisFields,
  toIrishLocalPhone,
  typeAutoAddress,
} from './lib.js';
import {
  DEFAULT_OCCUPATION_OPTIONS,
  guessContract,
  matchOption,
  occupationKey,
  suggestOccupations,
} from './occupations.js';

const $ = (id) => document.getElementById(id);
const COLUMNS = 'id, first_name, last_name, email, phone, address, eircode, dob, created_at';
const FIELD_NAMES = {
  first_name: 'First Name',
  last_name: 'Last Name',
  mobile: 'Mobile No.',
  email: 'Email',
  eircode: 'Eircode',
  dob: 'Date of Birth',
  registration: 'Date of Registration Meeting',
  cab: 'CAB/Lot',
  action: 'Action',
  staff: 'LDC Staff Member',
  intervention_type: 'Intervention Type',
  intervention_date: 'Date of Intervention',
  support_type: 'Support Type',
  case_notes: 'Case Notes',
  personal_plan: 'Personal Plan Agreed',
  status_change: 'Change of status or progression',
  economic_status: 'Current Economic Status',
  employment_start: 'Employment Start Date',
  occupation: 'Occupational group',
  contract: 'Contract Type',
};
const OUTCOME_COLUMNS = 'is_working, started_month, field_of_work, employment_type, last_responded_at';

let client = null;
let channel = null;
let students = [];
let selectedId = null;
// Earliest course registration per student id, fetched on selection.
const firstRegistered = new Map();
// The outcome survey answer per student id: a row, null for none, undefined when it could not be read.
const outcomes = new Map();
// The Occupational group and Contract Type lists, as last read from an IRIS form.
let irisLists = { occupation: null, contract: null };
// Earlier choices: { [occupationKey(answer)]: { option, text } } and { full_time | part_time: option }.
let occupationMemory = {};
let contractMemory = {};
// What "Fill job outcome" will send for the selected person.
let draft = null;
let searchSeq = 0;
let searchTimer = null;

function show(section) {
  for (const id of ['setup', 'login', 'main']) $(id).hidden = id !== section;
  $('logout').hidden = section !== 'main';
}

async function start() {
  const saved = await chrome.storage.local.get(['supabaseUrl', 'supabaseKey', 'irisLists', 'occupationMemory', 'contractMemory']);
  const { supabaseUrl, supabaseKey } = saved;
  irisLists = { ...irisLists, ...saved.irisLists };
  occupationMemory = saved.occupationMemory || {};
  contractMemory = saved.contractMemory || {};
  if (!supabaseUrl || !supabaseKey) return show('setup');

  client = supabase.createClient(supabaseUrl, supabaseKey);
  client.auth.onAuthStateChange((_event, session) => {
    if (session) enterMain();
    else leaveMain();
  });
  const { data } = await client.auth.getSession();
  if (!data.session) show('login');
}

function enterMain() {
  if (!$('main').hidden) return;
  show('main');
  $('search').focus();
  runSearch();
  // Live updates: any change to students in the CRM refreshes the list.
  channel = client
    .channel('iris-students')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'students' }, scheduleSearch)
    .subscribe();
}

function leaveMain() {
  if (channel) client.removeChannel(channel);
  channel = null;
  students = [];
  selectedId = null;
  draft = null;
  outcomes.clear();
  show('login');
}

$('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  await chrome.storage.local.set({
    supabaseUrl: String(form.get('url')).trim().replace(/\/+$/, ''),
    supabaseKey: String(form.get('key')).trim(),
  });
  start();
});

$('reset-setup').addEventListener('click', async () => {
  await chrome.storage.local.remove(['supabaseUrl', 'supabaseKey']);
  location.reload();
});

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const button = e.target.querySelector('button');
  button.disabled = true;
  $('login-error').hidden = true;
  const { error } = await client.auth.signInWithPassword({
    email: String(form.get('email')).trim(),
    password: String(form.get('password')),
  });
  button.disabled = false;
  if (error) {
    $('login-error').textContent = error.message;
    $('login-error').hidden = false;
  }
});

$('logout').addEventListener('click', () => client.auth.signOut());

$('search').addEventListener('input', scheduleSearch);

function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 250);
}

async function runSearch() {
  const seq = ++searchSeq;
  const query = $('search').value;
  let request = client.from('students').select(COLUMNS);
  const filter = buildSearchFilter(query);
  if (filter) request = request.or(filter);
  request = request.order('created_at', { ascending: false }).limit(30);

  const { data, error } = await request;
  if (seq !== searchSeq) return;
  if (error) {
    $('search-state').textContent = `CRM error: ${error.message}`;
    return;
  }
  students = data || [];
  if (!students.length) {
    $('search-state').textContent = query.trim() ? 'Nobody found.' : 'No students yet. Your role may not allow viewing them.';
  } else {
    $('search-state').textContent = query.trim() ? '' : 'Newest students:';
  }
  renderResults();
}

function renderResults() {
  const list = $('results');
  list.replaceChildren(
    ...students.map((s) => {
      const li = document.createElement('li');
      li.className = s.id === selectedId ? 'active' : '';
      const name = document.createElement('div');
      name.textContent = `${s.first_name || ''} ${s.last_name || ''}`.trim() || '(no name)';
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = [s.email, toIrishLocalPhone(s.phone), formatDate(s.dob)].filter(Boolean).join(' · ');
      li.append(name, sub);
      li.addEventListener('click', () => select(s.id));
      return li;
    }),
  );
  renderSelected();
}

function select(id) {
  selectedId = id;
  draft = null;
  $('fill-report').replaceChildren();
  $('int-report').replaceChildren();
  $('outcome-report').replaceChildren();
  renderResults();
  loadFirstRegistration(id);
  loadOutcome(id);
}

async function loadOutcome(id) {
  const { data, error } = await client
    .from('employment_status')
    .select(OUTCOME_COLUMNS)
    .eq('student_id', id)
    .limit(1);
  outcomes.set(id, error ? undefined : (data[0] || null));
  if (id !== selectedId) return;
  draft = null;
  renderOutcome();
  // The real lists, when an IRIS form is already open.
  if (draft) refreshIrisLists();
}

async function loadFirstRegistration(id) {
  const { data, error } = await client
    .from('enrollments')
    .select('created_at')
    .eq('student_id', id)
    .order('created_at', { ascending: true })
    .limit(1);
  firstRegistered.set(id, error ? undefined : (data[0] ? data[0].created_at : null));
  if (id === selectedId) renderSelected();
}

function renderSelected() {
  const s = students.find((x) => x.id === selectedId);
  $('selected').hidden = !s;
  if (!s) return;
  $('sel-name').textContent = `${s.first_name || ''} ${s.last_name || ''}`.trim();
  const rows = [
    ['Mobile', toIrishLocalPhone(s.phone)],
    ['Email', s.email],
    ['Date of birth', formatDate(s.dob)],
    ['Address', s.address],
    ['Eircode', s.eircode],
    ['First registered', registeredText(s.id)],
  ];
  $('sel-fields').replaceChildren(
    ...rows.flatMap(([label, value]) => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value || '—';
      return [dt, dd];
    }),
  );
  renderOutcome();
}

const occupationList = () => (irisLists.occupation && irisLists.occupation.length ? irisLists.occupation : DEFAULT_OCCUPATION_OPTIONS);
const contractList = () => irisLists.contract || [];

// Works out the suggestions again; a choice made by hand stays while IRIS still has it.
function suggestInto(d) {
  d.suggestions = suggestOccupations(d.text, occupationList(), occupationMemory);
  d.occupation = d.occupationChosen
    ? matchOption(occupationList(), [d.occupation]) || ''
    : (d.suggestions[0] ? d.suggestions[0].option : '');
  d.contract = d.contractChosen
    ? matchOption(contractList(), [d.contract]) || ''
    : guessContract(d.employmentType, contractList(), contractMemory) || '';
}

function newDraft(studentId, outcome) {
  const d = {
    studentId,
    text: (outcome.field_of_work || '').trim(),
    employmentType: outcome.employment_type,
    // The CRM keeps the month only: the 1st, to be corrected when the day is known.
    start: typedDate(monthStart(outcome.started_month)),
    // The day the outcome was learned: when the survey was answered.
    intervention: typedDate(isoDate(localDateParts(outcome.last_responded_at) || localDateParts(Date.now()))),
    occupation: '',
    contract: '',
    occupationChosen: false,
    contractChosen: false,
    suggestions: [],
  };
  suggestInto(d);
  return d;
}

function setOptions(select, options, value, placeholder) {
  const option = (v, text) => {
    const el = document.createElement('option');
    el.value = v;
    el.textContent = text;
    return el;
  };
  // The list is rebuilt only when it changed, so a refresh never closes an open list.
  const wanted = ['', ...options];
  const shown = Array.from(select.options, (el) => el.value);
  if (shown.length !== wanted.length || shown.some((v, i) => v !== wanted[i]) || select.options[0].textContent !== placeholder) {
    select.replaceChildren(option('', placeholder), ...options.map((text) => option(text, text)));
  }
  select.value = value;
}

// Dates are typed and shown as IRIS shows them, dd/mm/yyyy, whatever the language of Chrome.
// One being typed is left alone; one that is not a real day stays as typed, marked.
function setDate(input, date) {
  if (document.activeElement !== input) input.value = date.typed;
  input.classList.toggle('bad', Boolean(date.typed.trim()) && !date.iso);
}

const typedDate = (iso) => ({ iso, typed: formatDate(iso) });

function readDate(input) {
  const iso = parseTypedDate(input.value);
  return iso ? typedDate(iso) : { iso: '', typed: input.value };
}

/** The day the survey was answered, '12/10/2026'. */
const answeredOn = (outcome) => formatDate(isoDate(localDateParts(outcome.last_responded_at)));

function whyText() {
  const hit = draft.suggestions.find((x) => x.option === draft.occupation);
  if (hit && hit.why.kind === 'remembered') return 'Remembered: you chose it for this answer.';
  if (hit && hit.why.kind === 'similar') return `You chose it for “${hit.why.text}” before.`;
  if (hit) return `A guess from “${hit.why.text}”. If it is wrong, change it: your choice is remembered.`;
  if (draft.occupation) return draft.text ? 'Your choice. It will be remembered for this answer.' : 'Your choice.';
  if (!draft.text) return 'The CRM has no answer about where they work. Choose the group.';
  return draft.suggestions.length
    ? 'Choose the group.'
    : 'No guess for this answer. Choose the group once: it is remembered for everyone who writes the same.';
}

function renderOutcome() {
  const s = students.find((x) => x.id === selectedId);
  if (!s) return;
  const outcome = outcomes.get(s.id);
  const working = Boolean(outcome && outcome.is_working);
  $('outcome-form').hidden = !working;
  $('outcome-state').hidden = working;
  if (!working) {
    draft = null;
    const answered = outcome && outcome.last_responded_at ? ` (answered ${answeredOn(outcome)})` : '';
    $('outcome-state').textContent = !outcomes.has(s.id) ? '…'
      : outcome === undefined ? 'Could not load the outcome from the CRM.'
        : outcome && outcome.is_working === false ? `Not working${answered}: nothing to enter.`
          : 'No answer to the outcome survey yet.';
    return;
  }
  if (!draft || draft.studentId !== s.id) draft = newDraft(s.id, outcome);

  const quote = document.createElement('span');
  quote.className = 'quote';
  quote.textContent = draft.text ? `“${draft.text}”` : 'Did not say where';
  const facts = document.createElement('span');
  facts.className = 'facts';
  const since = monthName(monthStart(outcome.started_month));
  facts.textContent = [
    { full_time: 'Full-time', part_time: 'Part-time' }[outcome.employment_type],
    since ? `since ${since}` : '',
    outcome.last_responded_at ? `answered ${answeredOn(outcome)}` : '',
  ].filter(Boolean).join(' · ');
  $('outcome-said').replaceChildren(quote, facts);

  setOptions($('out-occupation'), occupationList(), draft.occupation, 'Choose…');
  // One tap for the runners-up; with a single guess the list above already shows it.
  const chips = draft.suggestions.length > 1 ? draft.suggestions.slice(0, 3) : [];
  $('out-chips').replaceChildren(
    ...chips.map((suggestion) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = suggestion.option === draft.occupation ? 'chip on' : 'chip';
      chip.textContent = suggestion.option;
      chip.addEventListener('click', () => {
        draft.occupation = suggestion.option;
        draft.occupationChosen = true;
        renderOutcome();
      });
      return chip;
    }),
  );
  $('out-why').textContent = whyText();

  const contracts = contractList();
  setOptions($('out-contract'), contracts, draft.contract, contracts.length ? 'Choose…' : 'Open the IRIS form');
  $('out-contract').disabled = !contracts.length;
  setDate($('out-start'), draft.start);
  setDate($('out-date'), draft.intervention);
}

$('out-occupation').addEventListener('change', (e) => {
  if (!draft) return;
  draft.occupation = e.target.value;
  draft.occupationChosen = true;
  renderOutcome();
});
$('out-contract').addEventListener('change', (e) => {
  if (!draft) return;
  draft.contract = e.target.value;
  draft.contractChosen = true;
});
$('out-start').addEventListener('change', (e) => {
  if (!draft) return;
  draft.start = readDate(e.target);
  renderOutcome();
});
$('out-date').addEventListener('change', (e) => {
  if (!draft) return;
  draft.intervention = readDate(e.target);
  renderOutcome();
});

async function runInIris(func, args) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return { ok: false, error: 'no-form' };
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func, args });
  return result;
}

// Keeps the two lists as IRIS has them; they come back with every read and fill.
function takeLists(results) {
  let changed = false;
  for (const r of results) {
    if (!(r.key in irisLists) || !r.options || !r.options.length) continue;
    if (JSON.stringify(r.options) === JSON.stringify(irisLists[r.key])) continue;
    irisLists = { ...irisLists, [r.key]: r.options };
    changed = true;
  }
  if (!changed) return;
  chrome.storage.local.set({ irisLists });
  if (draft) suggestInto(draft);
  renderOutcome();
}

// Reads the lists from the IRIS form in the active tab; quietly does nothing when there is none.
async function refreshIrisLists() {
  try {
    const result = await runInIris(fillIrisForm, [outcomeOptionFields(), true]);
    if (result && result.ok) takeLists(result.results);
  } catch (e) {
    // Not an IRIS tab.
  }
}

// The form is often opened after the person was picked: look again when the panel is used.
window.addEventListener('focus', () => { if (draft) refreshIrisLists(); });

// What was sent and landed on the form is what to suggest next time.
function remember(sent, results) {
  const filled = (key) => results.some((r) => r.key === key && r.status === 'filled');
  if (sent.text && sent.occupation && filled('occupation')) {
    occupationMemory = { ...occupationMemory, [occupationKey(sent.text)]: { option: sent.occupation, text: sent.text } };
  }
  if (sent.contract && filled('contract')) {
    contractMemory = { ...contractMemory, [sent.employmentType || 'unknown']: sent.contract };
  }
  chrome.storage.local.set({ occupationMemory, contractMemory });
  if (draft) suggestInto(draft);
  renderOutcome();
}

$('int-outcome').addEventListener('click', async () => {
  if (!draft) return;
  const report = $('outcome-report');
  const buttons = document.querySelectorAll('#selected button');
  buttons.forEach((b) => { b.disabled = true; });
  try {
    // The form may have been opened since the person was picked: guess again from its own lists.
    await refreshIrisLists();
    if (!draft) return;
    const sent = { ...draft, startDate: draft.start.iso, interventionDate: draft.intervention.iso };
    const result = await runInIris(fillIrisForm, [outcomeFields(sent)]);
    if (result && result.ok) {
      takeLists(result.results);
      remember(sent, result.results);
    }
    renderReport(report, result, {
      intervention_date: 'no date: type it above as dd/mm/yyyy',
      economic_status: 'the CRM does not say full-time or part-time, choose by hand',
      employment_start: 'no date: type it above as dd/mm/yyyy',
      occupation: 'not chosen: choose it above or on the form',
      contract: 'not chosen: choose it above or on the form',
    });
  } catch (e) {
    renderReport(report, { ok: false, error: String(e && e.message || e) });
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
});

function registeredText(id) {
  if (!firstRegistered.has(id)) return '…';
  const at = firstRegistered.get(id);
  if (at === undefined) return 'could not load';
  const parts = localDateParts(at);
  return parts ? parts.reverse().map((n) => String(n).padStart(2, '0')).join('/') : 'no course registrations';
}

// Fills the open IRIS form with `buildFields(student, firstRegisteredAt)`.
// `after` may add to the result, e.g. the Auto Address step.
async function fillFromPanel(report, buildFields, after) {
  const s = students.find((x) => x.id === selectedId);
  if (!s) return;
  const buttons = document.querySelectorAll('#selected button');
  buttons.forEach((b) => { b.disabled = true; });
  try {
    if (!firstRegistered.has(s.id) || firstRegistered.get(s.id) === undefined) await loadFirstRegistration(s.id);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: fillIrisForm,
      args: [buildFields(s, firstRegistered.get(s.id))],
    });
    if (result && result.ok && after) await after(result, tab, s);
    renderReport(report, result);
  } catch (e) {
    renderReport(report, { ok: false, error: String(e && e.message || e) });
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

$('fill').addEventListener('click', () =>
  fillFromPanel($('fill-report'), toIrisFields, async (result, tab, s) => {
    result.address = await typeAddress(tab.id, autoAddressQuery(s));
  }));

$('int-registration').addEventListener('click', () =>
  fillFromPanel($('int-report'), (_s, at) => interventionFields('registration', at)));

$('int-course').addEventListener('click', () =>
  fillFromPanel($('int-report'), (_s, at) => interventionFields('course', at)));

// The Auto Address box sits in its own frame, so look in all of them.
async function typeAddress(tabId, query) {
  if (!query) return 'skipped';
  try {
    const frames = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: typeAutoAddress,
      args: [query],
    });
    const found = frames.map((f) => f.result);
    return found.includes('picked') ? 'picked' : found.includes('typed') ? 'typed' : 'not-found';
  } catch (e) {
    return 'not-found';
  }
}

// `emptyText` words an empty field better than "nothing in the CRM", by field key.
function renderReport(list, result, emptyText = {}) {
  const item = (text, cls) => {
    const li = document.createElement('li');
    li.textContent = text;
    li.className = cls;
    return li;
  };
  if (!result || !result.ok) {
    const message = result && result.error === 'no-form'
      ? 'Open the IRIS form first, then press the button again.'
      : `Could not fill: ${(result && result.error) || 'unknown error'}. Is the IRIS tab active?`;
    list.replaceChildren(item(message, 'error'));
    return;
  }
  const text = {
    filled: 'filled',
    empty: 'nothing in the CRM',
    'not-found': 'field not found on the form',
    error: 'IRIS refused the value',
    kept: 'already filled, left as is',
    choose: 'more than one option, choose by hand',
    'no-match': 'no such option in IRIS, choose by hand',
    cleared: 'IRIS cleared the value, fill it by hand',
  };
  const lines = result.results.map((r) => {
    const said = (r.status === 'empty' && emptyText[r.key]) || text[r.status];
    return item(`${FIELD_NAMES[r.key]}: ${said}${r.message ? ` (${r.message})` : ''}`, r.status);
  });
  if (result.address === 'picked') lines.push(item('Auto Address: the only suggestion was picked, check the address lines', 'filled'));
  if (result.address === 'typed') lines.push(item('Auto Address: typed, pick the address from the IRIS list', 'filled'));
  if (result.address === 'not-found') {
    lines.push(item('Auto Address: box not found, type the Eircode there by hand', 'not-found'));
    if (result.frames && result.frames.length) lines.push(item(`Frames on the page: ${result.frames.join(', ')}`, 'hint'));
  }
  lines.push(item('Check the form, finish the rest and save in IRIS.', ''));
  list.replaceChildren(...lines);
}

start();
