import {
  autoAddressQuery,
  buildSearchFilter,
  duplicateQuery,
  findIrisDuplicates,
  fillIrisForm,
  formatDate,
  interventionFields,
  irisFormInfo,
  isStrongMatch,
  openIrisIntervention,
  isoDate,
  localDateParts,
  matchesSearch,
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
let outcomeChannel = null;
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
// When "Fill job outcome" last went through, per student id (an ISO time).
let outcomeFilled = {};
// The search lists only people who answered that they are working.
let workingOnly = false;
// The LDC Staff Member to put on interventions; '' is the signed-in IRIS user.
let staffName = '';
// The kind of IRIS form open in the active tab: { kind: 'individual' | 'intervention' | 'other' | 'none', isNew }.
let formInfo = { kind: 'none' };
// The table IRIS keeps interventions in, learnt from an intervention form or looked up once.
let interventionEntity = '';
// The IRIS duplicate check per student id: { state: 'checking' | 'done' | 'error', matches, error, confirmed, stopped }.
const dupChecks = new Map();
let searchSeq = 0;
let searchTimer = null;

function show(section) {
  for (const id of ['setup', 'login', 'main']) $(id).hidden = id !== section;
  $('logout').hidden = section !== 'main';
  $('open-settings').hidden = section !== 'main';
}

$('version').textContent = `v${chrome.runtime.getManifest().version}`;

// Installed with "Load unpacked", the extension reads its files from a folder (for example one synced by
// OneDrive), but the browser keeps running the version it loaded. When the folder holds a newer
// manifest, offer to reload.
async function checkForUpdate() {
  try {
    const onDisk = await (await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })).json();
    if (onDisk.version === chrome.runtime.getManifest().version) return;
    $('update-text').textContent = `Version ${onDisk.version} is ready.`;
    $('update-banner').hidden = false;
  } catch (error) {
    console.error(error);
  }
}
$('update-now').addEventListener('click', () => chrome.runtime.reload());
checkForUpdate();
setInterval(checkForUpdate, 10 * 60 * 1000);

async function start() {
  const saved = await chrome.storage.local.get([
    'supabaseUrl', 'supabaseKey', 'irisLists', 'occupationMemory', 'contractMemory', 'outcomeFilled', 'workingOnly', 'staffName', 'interventionEntity',
  ]);
  interventionEntity = saved.interventionEntity || '';
  // A connection baked into config.js wins over the one typed in the setup form.
  const preset = self.CRM_CONFIG || {};
  const baked = Boolean(preset.supabaseUrl && preset.supabaseKey);
  const supabaseUrl = baked ? preset.supabaseUrl.trim().replace(/\/+$/, '') : saved.supabaseUrl;
  const supabaseKey = baked ? preset.supabaseKey.trim() : saved.supabaseKey;
  $('reset-setup').hidden = baked;
  irisLists = { ...irisLists, ...saved.irisLists };
  occupationMemory = saved.occupationMemory || {};
  contractMemory = saved.contractMemory || {};
  outcomeFilled = saved.outcomeFilled || {};
  workingOnly = Boolean(saved.workingOnly);
  staffName = saved.staffName || '';
  $('working-only').checked = workingOnly;
  $('set-staff').value = staffName;
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
  refreshFormInfo();
  // Live updates: any change to students in the CRM refreshes the list.
  channel = client
    .channel('iris-students')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'students' }, scheduleSearch)
    .subscribe();
  // A new survey answer puts the person on the working list at once.
  outcomeChannel = client
    .channel('iris-outcomes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'employment_status' }, () => { if (workingOnly) scheduleSearch(); })
    .subscribe();
}

function leaveMain() {
  if (channel) client.removeChannel(channel);
  if (outcomeChannel) client.removeChannel(outcomeChannel);
  channel = null;
  outcomeChannel = null;
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

$('working-only').addEventListener('change', (e) => {
  workingOnly = e.target.checked;
  chrome.storage.local.set({ workingOnly });
  runSearch();
});

$('open-settings').addEventListener('click', (e) => {
  const open = $('settings').hidden;
  $('settings').hidden = !open;
  e.target.setAttribute('aria-expanded', String(open));
  if (open) $('set-staff').focus();
});

$('set-staff').addEventListener('change', (e) => {
  staffName = e.target.value.trim();
  e.target.value = staffName;
  chrome.storage.local.set({ staffName });
});

function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 250);
}

async function runSearch() {
  const seq = ++searchSeq;
  const query = $('search').value;
  const found = await (workingOnly ? findWorking(query) : findStudents(query));
  if (seq !== searchSeq) return;
  if (found.error) {
    $('search-state').textContent = `CRM error: ${found.error.message}`;
    return;
  }
  students = found.students;
  $('search-state').textContent = found.note;
  renderResults();
}

async function findStudents(query) {
  let request = client.from('students').select(COLUMNS);
  const filter = buildSearchFilter(query);
  if (filter) request = request.or(filter);
  const { data, error } = await request.order('created_at', { ascending: false }).limit(30);
  if (error) return { error };
  const found = data || [];
  const note = found.length
    ? (query.trim() ? '' : 'Newest students:')
    : (query.trim() ? 'Nobody found.' : 'No students yet. Your role may not allow viewing them.');
  return { students: found, note };
}

// Everyone who answered the outcome survey as working, the newest answers
// first and the people already filled in IRIS last. The search box narrows it.
async function findWorking(query) {
  const { data, error } = await client
    .from('employment_status')
    .select(`${OUTCOME_COLUMNS}, students(${COLUMNS})`)
    .eq('is_working', true)
    .order('last_responded_at', { ascending: false, nullsFirst: false })
    .limit(500);
  if (error) return { error };
  const found = [];
  for (const { students: person, ...outcome } of data || []) {
    const student = Array.isArray(person) ? person[0] : person;
    if (!student || !matchesSearch(student, query)) continue;
    outcomes.set(student.id, outcome);
    found.push(student);
  }
  found.sort((a, b) => Number(isFilled(a.id)) - Number(isFilled(b.id)));
  const done = found.filter((student) => isFilled(student.id)).length;
  const note = found.length
    ? `${found.length} working${done ? `, ${done} already filled in IRIS` : ''}:`
    : (query.trim() ? 'Nobody working matches the search.' : 'Nobody has answered that they are working yet.');
  return { students: found, note };
}

// Filled into an IRIS form from this browser, and the person has not answered again since.
function isFilled(id) {
  const at = Date.parse(outcomeFilled[id] || '');
  if (Number.isNaN(at)) return false;
  const outcome = outcomes.get(id);
  const answered = Date.parse((outcome && outcome.last_responded_at) || '');
  return Number.isNaN(answered) || at >= answered;
}

function renderResults() {
  const list = $('results');
  list.replaceChildren(
    ...students.map((s) => {
      const li = document.createElement('li');
      const outcome = workingOnly ? outcomes.get(s.id) : null;
      const done = Boolean(outcome) && isFilled(s.id);
      li.className = [s.id === selectedId ? 'active' : '', done ? 'done' : ''].filter(Boolean).join(' ');
      const name = document.createElement('div');
      name.textContent = `${s.first_name || ''} ${s.last_name || ''}`.trim() || '(no name)';
      const sub = document.createElement('div');
      sub.className = 'sub';
      // On the working list the job says more than the contact details.
      sub.textContent = (outcome
        ? [
          done ? `filled in IRIS ${filledOn(s.id)}` : '',
          outcome.field_of_work ? `“${outcome.field_of_work.trim()}”` : '',
          outcome.last_responded_at ? `answered ${answeredOn(outcome)}` : '',
        ]
        : [s.email, toIrishLocalPhone(s.phone), formatDate(s.dob)]).filter(Boolean).join(' · ');
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
  // A fresh look in IRIS for every pick: the person may have been added since.
  dupChecks.delete(id);
  if (formInfo.kind === 'individual') checkDuplicates(id);
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
  renderDuplicates();
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
    // The day the outcome was learned: when the survey was answered. Its year picks the Action.
    answeredAt: outcome.last_responded_at,
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

/** The day "Fill job outcome" went through for a person, '12/11/2026'. */
const filledOn = (id) => formatDate(isoDate(localDateParts(outcomeFilled[id])));

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
    $('outcome-done').hidden = true;
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
  $('outcome-done').hidden = !isFilled(s.id);
  $('outcome-done-text').textContent = isFilled(s.id) ? `Filled in IRIS on ${filledOn(s.id)}.` : '';
}

// The tick was a mistake (the form was not saved, or it was another person's).
$('outcome-undo').addEventListener('click', () => {
  if (!draft) return;
  const { [draft.studentId]: _gone, ...rest } = outcomeFilled;
  outcomeFilled = rest;
  chrome.storage.local.set({ outcomeFilled });
  renderResults();
});

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
    const s = students.find((x) => x.id === draft.studentId);
    if (!s || !(await ensureInterventionForm(s, report))) return;
    // The form may have been opened since the person was picked: guess again from its own lists.
    await refreshIrisLists();
    if (!draft) return;
    const sent = { ...draft, startDate: draft.start.iso, interventionDate: draft.intervention.iso, staffName };
    const result = await runInIris(fillIrisForm, [outcomeFields(sent)]);
    if (result && result.ok) {
      takeLists(result.results);
      remember(sent, result.results);
      // The outcome itself reached the form: tick the person on the working list.
      if (result.results.some((r) => ['economic_status', 'employment_start', 'occupation'].includes(r.key) && r.status === 'filled')) {
        outcomeFilled = { ...outcomeFilled, [sent.studentId]: new Date().toISOString() };
        chrome.storage.local.set({ outcomeFilled });
        renderResults();
      }
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
// With `intervention`, an individual's form first gets a new intervention opened from it.
async function fillFromPanel(report, buildFields, after, intervention = false) {
  const s = students.find((x) => x.id === selectedId);
  if (!s) return;
  const buttons = document.querySelectorAll('#selected button');
  buttons.forEach((b) => { b.disabled = true; });
  try {
    if (intervention && !(await ensureInterventionForm(s, report))) return;
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

$('fill').addEventListener('click', async () => {
  const id = selectedId;
  if (!id) return;
  const prior = dupChecks.get(id);
  if (!(prior && prior.confirmed)) {
    // Look in IRIS right before creating anyone; stop when the person seems to be there already.
    await checkDuplicates(id);
    const check = dupChecks.get(id);
    if (id !== selectedId) return;
    if (check && check.state === 'done' && check.matches.some(isStrongMatch)) {
      check.stopped = true;
      renderDuplicates();
      return;
    }
  }
  fillIndividual();
});

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readFormInfo() {
  try {
    const result = await runInIris(irisFormInfo, []);
    return result && result.kind ? result : { kind: 'none' };
  } catch (e) {
    return { kind: 'none' };
  }
}

function say(report, text, cls = '') {
  const li = document.createElement('li');
  li.textContent = text;
  li.className = cls;
  report.replaceChildren(li);
}

// On an individual's form, opens a new Individual Intervention for them and waits
// for it. On any other page does nothing, and the fill goes ahead as before.
// Returns false, with the reason in `report`, when the fill should not go on.
async function ensureInterventionForm(s, report) {
  const info = await readFormInfo();
  if (info.kind !== 'individual') return true;
  say(report, 'Opening a new Individual Intervention for this person…');
  const opened = await runInIris(openIrisIntervention, [
    interventionEntity || null,
    { first: (s.first_name || '').trim(), last: (s.last_name || '').trim() },
  ]);
  if (!opened || !opened.ok) {
    const why = {
      unsaved: 'Save the individual in IRIS first, then press the button again.',
      'other-person': `The IRIS form is for ${opened && opened.name ? opened.name : 'someone else'}, not the person picked here. Pick the same person, or open their form.`,
      'unknown-entity': 'Could not work out where IRIS keeps interventions. Open any New Individual Intervention form once, then this button works from the individual\'s form.',
    }[opened && opened.error] || `Could not open a new intervention (${(opened && opened.error) || 'unknown error'}).`;
    say(report, why, 'error');
    return false;
  }
  if (opened.entity !== interventionEntity) {
    interventionEntity = opened.entity;
    chrome.storage.local.set({ interventionEntity });
  }
  for (let waited = 0; waited < 20000; waited += 500) {
    await pause(500);
    const now = await readFormInfo();
    if (now.kind === 'intervention') {
      // Let IRIS finish loading the form and copying the individual into it.
      await pause(1500);
      return true;
    }
  }
  say(report, 'The new intervention form did not open. Open it by hand, then press the button again.', 'error');
  return false;
}

function fillIndividual() {
  fillFromPanel($('fill-report'), (s, at) => toIrisFields(s, at, staffName), async (result, tab, s) => {
    result.address = await typeAddress(tab.id, autoAddressQuery(s));
  });
}

// Which IRIS form is open. The buttons for another kind of form turn into outlines.
async function refreshFormInfo() {
  let info = { kind: 'none' };
  try {
    const result = await runInIris(irisFormInfo, []);
    if (result && result.kind) info = result;
  } catch (e) {
    // Not an IRIS tab, or a page the extension may not touch.
  }
  if (info.kind === 'intervention' && info.entity && info.entity !== interventionEntity) {
    interventionEntity = info.entity;
    chrome.storage.local.set({ interventionEntity });
  }
  const changed = info.kind !== formInfo.kind || info.isNew !== formInfo.isNew;
  formInfo = info;
  if (changed) renderFormInfo();
  if (info.kind === 'individual' && selectedId && !dupChecks.has(selectedId)) checkDuplicates(selectedId);
}

function renderFormInfo() {
  const el = $('iris-form');
  const known = formInfo.kind === 'individual' || formInfo.kind === 'intervention';
  el.hidden = false;
  el.classList.toggle('on', known);
  if (known) {
    const name = document.createElement('strong');
    name.textContent = `${formInfo.isNew ? 'New ' : ''}${formInfo.kind === 'individual' ? 'Individual' : 'Individual Intervention'}`;
    el.replaceChildren('IRIS: ', name, ' form is open');
  } else {
    el.textContent = formInfo.kind === 'other' ? 'IRIS: another form is open' : 'No IRIS form in this tab';
  }
  for (const button of document.querySelectorAll('button[data-form]')) {
    // The intervention buttons work from an individual's form too: they open a new intervention first.
    const fits = button.dataset.form === formInfo.kind || (button.dataset.form === 'intervention' && formInfo.kind === 'individual');
    button.classList.toggle('other-form', known && !fits);
  }
  renderDuplicates();
}

setInterval(() => {
  if (document.visibilityState === 'visible' && !$('main').hidden) refreshFormInfo();
}, 2000);
chrome.tabs.onActivated.addListener(() => { if (!$('main').hidden) refreshFormInfo(); });
chrome.tabs.onUpdated.addListener((_tabId, change) => { if (change.status === 'complete' && !$('main').hidden) refreshFormInfo(); });

// Looks in IRIS for the selected person. Needs an individual's form open in the tab;
// without one the check is simply not shown.
async function checkDuplicates(id) {
  const s = students.find((x) => x.id === id);
  if (!s) return;
  const confirmed = Boolean(dupChecks.get(id) && dupChecks.get(id).confirmed);
  dupChecks.set(id, { state: 'checking', confirmed });
  if (id === selectedId) renderDuplicates();
  let result;
  try {
    result = await runInIris(findIrisDuplicates, [duplicateQuery(s)]);
  } catch (e) {
    result = { ok: false, error: String(e && e.message || e) };
  }
  if (result && result.ok) dupChecks.set(id, { state: 'done', matches: result.matches, confirmed });
  else if (!result || result.error === 'no-form') dupChecks.delete(id);
  // The form has no name fields to search by: nothing to show, and no point asking again.
  else if (result.error === 'not-individual') dupChecks.set(id, { state: 'skip', confirmed });
  else dupChecks.set(id, { state: 'error', error: result.error, confirmed });
  if (id === selectedId) renderDuplicates();
}

const WHY_TEXT = { email: 'email', phone: 'phone', name: 'name', 'date of birth': 'date of birth' };

function renderDuplicates() {
  const box = $('dup');
  const found = selectedId ? dupChecks.get(selectedId) : null;
  // Only on an individual's form (or while the form is not known yet), where it matters.
  const elsewhere = formInfo.kind === 'intervention' || formInfo.kind === 'other';
  const check = found && found.state !== 'skip' && !elsewhere ? found : null;
  box.hidden = !check;
  if (!check) {
    box.replaceChildren();
    return;
  }
  if (check.state === 'checking') {
    box.className = 'dup info';
    box.textContent = 'Looking for this person in IRIS…';
    return;
  }
  if (check.state === 'error') {
    box.className = 'dup info';
    box.textContent = `Could not look in IRIS for duplicates (${check.error}).`;
    return;
  }
  if (!check.matches.length) {
    box.className = 'dup ok';
    box.textContent = '✓ Not in IRIS yet: no one with this email, phone or name.';
    return;
  }
  const strong = check.matches.some(isStrongMatch);
  box.className = strong ? 'dup warn' : 'dup info';
  const head = document.createElement(strong ? 'strong' : 'span');
  head.textContent = strong
    ? (check.matches.length > 1 ? 'Already in IRIS? These records look like this person:' : 'Already in IRIS? This record looks like this person:')
    : 'IRIS has someone with the same name, with other details:';
  const list = document.createElement('ul');
  for (const m of check.matches) {
    const li = document.createElement('li');
    const link = document.createElement('a');
    link.href = m.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = m.name || '(no name)';
    const details = [m.email, m.phone, formatDate(m.dob)].filter(Boolean).join(' · ');
    li.append(link, `${details ? ` · ${details}` : ''} (same ${m.why.map((w) => WHY_TEXT[w] || w).join(', ')})`);
    list.append(li);
  }
  box.replaceChildren(head, list);
  if (!strong) return;
  const note = document.createElement('p');
  note.className = 'hint';
  if (check.confirmed) {
    note.textContent = 'You chose to fill the form anyway.';
  } else {
    note.append(check.stopped ? 'Nothing was filled. Open the record above, or ' : 'Open the record above instead of making a new one, or ');
    const anyway = document.createElement('button');
    anyway.type = 'button';
    anyway.className = 'link';
    anyway.textContent = 'fill anyway';
    anyway.addEventListener('click', () => {
      check.confirmed = true;
      renderDuplicates();
      fillIndividual();
    });
    note.append(anyway, '.');
  }
  box.append(note);
}

$('int-registration').addEventListener('click', () =>
  fillFromPanel($('int-report'), (_s, at) => interventionFields('registration', at, new Date(), staffName), null, true));

$('int-course').addEventListener('click', () =>
  fillFromPanel($('int-report'), (_s, at) => interventionFields('course', at, new Date(), staffName), null, true));

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
