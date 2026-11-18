import {
  autoAddressQuery,
  buildSearchFilter,
  duplicateQuery,
  findIrisDuplicates,
  findIrisRegistrations,
  fillIrisForm,
  formatDate,
  interventionFields,
  irisFormInfo,
  isStrongMatch,
  openIrisIntervention,
  openIrisNewForm,
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
let formInfo = { kind: '' };
// The table IRIS keeps interventions in, learnt from an intervention form or looked up once.
let interventionEntity = '';
// The table IRIS keeps individuals in, learnt from an individual's form.
let individualEntity = '';
// The IRIS duplicate check per student id: { state: 'checking' | 'done' | 'error', matches, error, confirmed, stopped }.
const dupChecks = new Map();
// Field names learnt on IRIS forms, so the checks also work from any other IRIS page.
let individualSchema = null;
let registrationSchema = null;
// Registrations found in IRIS per student id: an array (maybe empty), absent when unknown.
const registrationsFound = new Map();
// What the panel filled in this session per student id: a Set of step keys.
const progress = new Map();
// Sections opened by hand; null lets the panel choose from the IRIS form and the next step.
let manualSections = null;
// The search result highlighted with the arrow keys.
let focusIndex = -1;
let searchSeq = 0;
let lastSearch = '';
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
    'supabaseUrl', 'supabaseKey', 'irisLists', 'occupationMemory', 'contractMemory', 'outcomeFilled', 'workingOnly', 'staffName', 'interventionEntity', 'individualEntity',
    'individualSchema', 'registrationSchema',
  ]);
  individualSchema = saved.individualSchema || null;
  registrationSchema = saved.registrationSchema || null;
  interventionEntity = saved.interventionEntity || '';
  individualEntity = saved.individualEntity || '';
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
  refreshFormInfo(true);
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
  lastSearch = '';
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
  e.currentTarget.setAttribute('aria-expanded', String(open));
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
  // The CRM changes all the time (live updates): repaint only when the list did.
  const signature = JSON.stringify([found.students, found.note, workingOnly]);
  if (signature === lastSearch) return;
  lastSearch = signature;
  students = found.students;
  // Arrow keys start from the picked person, else from the first match of a search.
  focusIndex = students.findIndex((x) => x.id === selectedId);
  if (focusIndex < 0 && query.trim()) focusIndex = 0;
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
    ...students.map((s, i) => {
      const li = document.createElement('li');
      const outcome = workingOnly ? outcomes.get(s.id) : null;
      const done = Boolean(outcome) && isFilled(s.id);
      li.className = [s.id === selectedId ? 'active' : '', done ? 'done' : '', i === focusIndex ? 'focus' : ''].filter(Boolean).join(' ');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(s.id === selectedId));
      const full = `${s.first_name || ''} ${s.last_name || ''}`.trim();
      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      avatar.textContent = initials(s);
      const who = document.createElement('div');
      who.className = 'who';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = full || '(no name)';
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
      who.append(name, sub);
      li.append(avatar, who);
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
  focusIndex = students.findIndex((x) => x.id === id);
  manualSections = null;
  // A fresh look in IRIS for every pick: the person may have been added since.
  dupChecks.delete(id);
  registrationsFound.delete(id);
  checkDuplicates(id);
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
  $('pick-hint').hidden = Boolean(s);
  if (!s) return;
  $('pick-hint').hidden = true;
  $('sel-name').textContent = `${s.first_name || ''} ${s.last_name || ''}`.trim() || '(no name)';
  $('sel-contact').textContent = [toIrishLocalPhone(s.phone), s.email].filter(Boolean).join(' · ');
  const registered = registeredText(s.id);
  $('sel-more').textContent = [
    s.dob ? `Born ${formatDate(s.dob)}` : '',
    [s.address, s.eircode && s.eircode.toUpperCase()].filter(Boolean).join(', '),
    /^\d/.test(registered) ? `Registered ${registered}` : '',
  ].filter(Boolean).join(' · ');
  // What the CRM lacks shows before filling, not in the report after.
  const missing = [
    !s.phone && 'No phone',
    !s.email && 'No email',
    !s.dob && 'No date of birth',
    !s.eircode && !s.address && 'No address',
    s.address && !s.eircode && 'No Eircode',
    firstRegistered.get(s.id) === null && 'No course registration',
  ].filter(Boolean);
  $('sel-missing').replaceChildren(...missing.map((text) => {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = text;
    return tag;
  }));
  renderDuplicates();
  renderOutcome();
  renderJourney();
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
  renderJourney();
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

// Fills always go to the active tab. Look-ups (`anyTab`) may use any IRIS tab,
// so "in IRIS or not" shows while you are on the CRM or anywhere else.
async function runInIris(func, args, { anyTab = false } = {}) {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (anyTab && !isIrisUrl(tab && tab.url)) {
    const iris = (await chrome.tabs.query({ url: 'https://*.dynamics.com/*' }))
      .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    if (iris.length) tab = iris[0];
  }
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

$('int-outcome').addEventListener('click', () => { if (draft) withBusy($('int-outcome'), 'Filling…', fillOutcome); });

async function fillOutcome() {
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
    }, 'outcome');
  } catch (e) {
    renderReport(report, { ok: false, error: String(e && e.message || e) });
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

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
// `precheck(student, report)` may stop the fill once the right form is open.
// `step` is marked done in the steps strip when the fill went through.
async function fillFromPanel(report, buildFields, after, intervention = false, precheck = null, step = '') {
  const s = students.find((x) => x.id === selectedId);
  if (!s) return;
  const buttons = document.querySelectorAll('#selected button');
  buttons.forEach((b) => { b.disabled = true; });
  try {
    if (intervention && !(await ensureInterventionForm(s, report))) return;
    if (precheck && !(await precheck(s, report))) return;
    if (!firstRegistered.has(s.id) || firstRegistered.get(s.id) === undefined) await loadFirstRegistration(s.id);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: fillIrisForm,
      args: [buildFields(s, firstRegistered.get(s.id))],
    });
    if (result && result.ok && after) await after(result, tab, s);
    if (step && result && result.ok && result.results.some((r) => r.status === 'filled')) markDone(s.id, step);
    renderReport(report, result, {}, step);
  } catch (e) {
    renderReport(report, { ok: false, error: String(e && e.message || e) });
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

let fillBusy = false;

$('fill').addEventListener('click', async () => {
  const id = selectedId;
  if (!id || fillBusy) return;
  fillBusy = true;
  // Nothing else may start while a new form opens: two fills would mix.
  const buttons = document.querySelectorAll('#selected button');
  buttons.forEach((b) => { b.disabled = true; });
  setBusy($('fill'), 'Filling…');
  try {
    await fillNewIndividual(id);
  } finally {
    fillBusy = false;
    clearBusy();
    buttons.forEach((b) => { b.disabled = false; });
  }
});

// The button at work shows a spinner and what it is doing.
let busyButton = null;
function setBusy(button, text) {
  clearBusy();
  busyButton = button;
  button.classList.add('busy');
  button.textContent = text;
}
function setBusyText(text) {
  if (busyButton) busyButton.textContent = text;
}
function clearBusy() {
  if (!busyButton) return;
  busyButton.classList.remove('busy');
  busyButton.textContent = busyButton.dataset.label;
  busyButton = null;
}
async function withBusy(button, text, run) {
  setBusy(button, text);
  try {
    await run();
  } finally {
    clearBusy();
  }
}

function isIrisUrl(url) {
  try {
    return new URL(url).hostname.endsWith('.dynamics.com');
  } catch (e) {
    return false;
  }
}

function markDone(id, step) {
  const steps = progress.get(id) || new Set();
  steps.add(step);
  progress.set(id, steps);
  if (id === selectedId) renderJourney();
}

// On a new individual's form fills it; on any other IRIS page opens one first.
// Either way it looks for the person in IRIS before filling anything.
async function fillNewIndividual(id) {
  // Already known to be in IRIS: stop before opening an empty form.
  const known = dupChecks.get(id);
  if (known && known.state === 'done' && !known.confirmed && known.matches.some(isStrongMatch)) {
    known.stopped = true;
    renderDuplicates();
    return;
  }
  if (!(await ensureNewIndividualForm($('fill-report')))) return;
  if (id !== selectedId) return;
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
}

async function ensureNewIndividualForm(report) {
  const info = await readFormInfo();
  if (info.kind === 'individual' && info.isNew) return true;
  if (!individualEntity) {
    say(report, 'Open any individual\'s form in IRIS once (anyone will do), so the panel learns where IRIS keeps individuals. After that this button works from any IRIS page.', 'error');
    return false;
  }
  say(report, 'Opening a new Individual form in IRIS…', 'progress');
  setBusyText('Opening form…');
  let opened;
  try {
    opened = await runInIris(openIrisNewForm, [individualEntity]);
  } catch (e) {
    opened = null;
  }
  if (!opened || !opened.ok) {
    say(report, 'Open IRIS in this tab first, then press the button again.', 'error');
    return false;
  }
  for (let waited = 0; waited < 20000; waited += 500) {
    await pause(500);
    const now = await readFormInfo();
    if (now.kind === 'individual' && now.isNew) {
      // Let IRIS finish loading the form and its Auto Address box.
      await pause(1500);
      report.replaceChildren();
      setBusyText('Filling…');
      formInfo = now;
      renderFormInfo();
      return true;
    }
  }
  say(report, 'The new Individual form did not open. Press New in IRIS, then press the button again.', 'error');
  return false;
}

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
  say(report, 'Opening a new Individual Intervention for this person…', 'progress');
  const was = busyButton ? busyButton.textContent : '';
  setBusyText('Opening form…');
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
      if (was) setBusyText(was);
      report.replaceChildren();
      return true;
    }
  }
  say(report, 'The new intervention form did not open. Open it by hand, then press the button again.', 'error');
  return false;
}

function fillIndividual() {
  return fillFromPanel($('fill-report'), (s, at) => toIrisFields(s, at, staffName), async (result, tab, s) => {
    result.address = await typeAddress(tab.id, autoAddressQuery(s));
  }, false, null, 'individual');
}

// Which IRIS form is open. The buttons for another kind of form turn into outlines.
let pendingInfo = null;

// `settle`: take what is seen at once (after the panel itself opened a form or the tab changed).
async function refreshFormInfo(settle = false) {
  let info = { kind: 'none' };
  try {
    const result = await runInIris(irisFormInfo, []);
    if (result && result.kind) info = result;
  } catch (e) {
    // Not an IRIS tab, or a page the extension may not touch.
  }
  if (info.kind === 'none') {
    // Look-ups still work while IRIS sits in another tab.
    const others = await chrome.tabs.query({ url: 'https://*.dynamics.com/*' });
    if (others.length) info = { kind: 'elsewhere' };
  }
  if (info.kind === 'intervention' && info.entity && info.entity !== interventionEntity) {
    interventionEntity = info.entity;
    chrome.storage.local.set({ interventionEntity });
  }
  if (info.kind === 'individual' && info.entity && info.entity !== individualEntity) {
    individualEntity = info.entity;
    chrome.storage.local.set({ individualEntity });
  }
  // IRIS reloads parts of itself now and then; a form that seems to vanish for one
  // look must not flip the panel back and forth. A change counts when seen twice.
  let changed = info.kind !== formInfo.kind || info.isNew !== formInfo.isNew;
  if (changed && !settle) {
    const same = pendingInfo && pendingInfo.kind === info.kind && pendingInfo.isNew === info.isNew;
    pendingInfo = info;
    if (!same) return;
  }
  pendingInfo = null;
  formInfo = info;
  if (changed) renderFormInfo();
  // The first IRIS page seen after a pick (or one that can search now): look for the person.
  if (info.kind !== 'none' && selectedId && !dupChecks.has(selectedId)) checkDuplicates(selectedId);
  if (changed && manualSections) {
    manualSections = null;
    renderJourney();
  }
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
    el.textContent = {
      other: 'IRIS: another form is open',
      page: 'IRIS is open, no form',
      elsewhere: 'IRIS is open in another tab',
    }[formInfo.kind] || 'IRIS is not open';
  }
  renderJourney();
  renderDuplicates();
}

setInterval(() => {
  if (document.visibilityState === 'visible' && !$('main').hidden) refreshFormInfo();
}, 2000);
chrome.tabs.onActivated.addListener(() => { if (!$('main').hidden) refreshFormInfo(true); });
chrome.tabs.onUpdated.addListener((_tabId, change) => { if (change.status === 'complete' && !$('main').hidden) refreshFormInfo(true); });

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
    result = await runInIris(findIrisDuplicates, [duplicateQuery(s), individualSchema], { anyTab: true });
  } catch (e) {
    result = { ok: false, error: String(e && e.message || e) };
  }
  if (result && result.ok) {
    dupChecks.set(id, { state: 'done', matches: result.matches, confirmed });
    if (result.schema && JSON.stringify(result.schema) !== JSON.stringify(individualSchema)) {
      individualSchema = result.schema;
      chrome.storage.local.set({ individualSchema });
    }
    // One record that is clearly this person: see whether they are registered too.
    const ids = [...new Set(result.matches.filter(isStrongMatch).map((m) => m.id))];
    if (ids.length === 1) lookUpRegistrations(id, ids[0]);
  }
  else if (!result || result.error === 'no-form') dupChecks.delete(id);
  // The form has no name fields to search by: nothing to show, and no point asking again.
  else if (result.error === 'not-individual') dupChecks.set(id, { state: 'skip', confirmed });
  else dupChecks.set(id, { state: 'error', error: result.error, confirmed });
  if (id === selectedId) renderDuplicates();
}

const WHY_TEXT = { email: 'email', phone: 'phone', name: 'name', 'date of birth': 'date of birth' };

let lastDuplicates = '';

function renderDuplicates() {
  const box = $('dup');
  const found = selectedId ? dupChecks.get(selectedId) : null;
  const check = found && found.state !== 'skip' ? found : null;
  const signature = JSON.stringify([selectedId, check]);
  if (signature === lastDuplicates) return;
  lastDuplicates = signature;
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
    renderJourney();
    return;
  }
  if (!check.matches.length) {
    box.className = 'dup ok';
    box.textContent = '✓ Not in IRIS yet: no one with this email, phone or name.';
    renderJourney();
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
  renderJourney();
  if (!strong) return;
  const note = document.createElement('p');
  note.className = 'hint';
  if (check.confirmed) {
    note.textContent = 'You chose to fill the form anyway.';
  } else {
    note.append(check.stopped ? 'Nothing was filled. Open the record above, or ' : 'Open the record above instead of making a new one. If it is someone else, ');
    const anyway = document.createElement('button');
    anyway.type = 'button';
    anyway.className = 'link';
    anyway.textContent = 'fill anyway';
    anyway.addEventListener('click', () => {
      check.confirmed = true;
      renderDuplicates();
      $('fill').click();
    });
    note.append(anyway, '.');
  }
  box.append(note);
}

$('int-registration').addEventListener('click', () =>
  withBusy($('int-registration'), 'Filling…', () =>
    fillFromPanel($('int-report'), (_s, at) => interventionFields('registration', at, new Date(), staffName), null, true, checkRegistration, 'registration')));

// People for whom "fill anyway" was pressed after a registration was found in IRIS.
const registrationConfirmed = new Set();

// Stops a second registration: looks for the individual's earlier one-to-one
// meetings noted "Reg". When IRIS can't be asked, the fill goes ahead as before.
async function checkRegistration(s, report) {
  // "fill anyway" lets one fill through; the next registration is checked again.
  if (registrationConfirmed.delete(s.id)) return true;
  let found;
  try {
    found = await runInIris(findIrisRegistrations, [individualEntity || null]);
  } catch (e) {
    found = null;
  }
  if (found && found.ok) {
    if (found.schema && JSON.stringify(found.schema) !== JSON.stringify(registrationSchema)) {
      registrationSchema = found.schema;
      chrome.storage.local.set({ registrationSchema });
    }
    registrationsFound.set(s.id, found.matches);
    renderJourney();
  }
  if (!found || !found.ok || !found.matches.length) return true;
  const li = document.createElement('li');
  li.className = 'error';
  const dates = found.matches.map((m) => formatDate(m.date) || 'no date');
  li.append(`${found.name || 'This person'} already has ${found.matches.length > 1 ? 'registrations' : 'a registration'} in IRIS (${dates.join(', ')}). Nothing was filled: close this form without saving. `);
  found.matches.forEach((m, i) => {
    const link = document.createElement('a');
    link.href = m.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = found.matches.length > 1 ? `Open ${i + 1}` : 'Open it';
    li.append(link, ' · ');
  });
  const anyway = document.createElement('button');
  anyway.type = 'button';
  anyway.className = 'link';
  anyway.textContent = 'fill anyway';
  anyway.addEventListener('click', () => {
    registrationConfirmed.add(s.id);
    $('int-registration').click();
  });
  li.append(anyway);
  report.replaceChildren(li);
  return false;
}

$('int-course').addEventListener('click', () =>
  withBusy($('int-course'), 'Filling…', () =>
    fillFromPanel($('int-report'), (_s, at) => interventionFields('course', at, new Date(), staffName), null, true, null, 'course')));

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
const STATUS_TEXT = {
  filled: 'filled',
  empty: 'nothing in the CRM',
  'not-found': 'field not found on the form',
  error: 'IRIS refused the value',
  kept: 'already filled, left as is',
  choose: 'more than one option, choose by hand',
  'no-match': 'no such option in IRIS, choose by hand',
  'other-year': 'filled with another year, check it',
  cleared: 'IRIS cleared the value, fill it by hand',
};

// What to do once a step went through.
const AFTER_TEXT = {
  individual: 'Check the form and save it in IRIS. Then: Registration.',
  registration: 'Check the form and save it in IRIS.',
  course: 'Choose the course details on the form and save it in IRIS.',
  outcome: 'Check the form and save it in IRIS.',
};

// A short report: one line with the counts, then only what needs a look.
// The full list opens on request.
function renderReport(list, result, emptyText = {}, step = '') {
  const item = (text, cls) => {
    const li = document.createElement('li');
    li.textContent = text;
    li.className = cls;
    return li;
  };
  if (!result || !result.ok) {
    const message = result && result.error === 'no-form'
      ? 'Open IRIS in this tab first, then press the button again.'
      : `Could not fill: ${(result && result.error) || 'unknown error'}. Is the IRIS tab active?`;
    list.replaceChildren(item(message, 'error'));
    return;
  }
  const lines = result.results.map((r) => ({
    status: r.status,
    text: `${FIELD_NAMES[r.key]}: ${(r.status === 'empty' && emptyText[r.key]) || STATUS_TEXT[r.status]}${r.message ? ` (${r.message})` : ''}`,
  }));
  if (result.address === 'picked') lines.push({ status: 'filled', text: 'Auto Address: the only suggestion was picked, check the address lines' });
  if (result.address === 'typed') lines.push({ status: 'choose', text: 'Auto Address: pick the address from the IRIS list' });
  if (result.address === 'not-found') lines.push({ status: 'not-found', text: 'Auto Address: box not found, type the Eircode there by hand' });

  const filled = lines.filter((l) => l.status === 'filled').length;
  const issues = lines.filter((l) => l.status !== 'filled' && l.status !== 'kept');
  const summary = document.createElement('li');
  summary.className = issues.length ? 'summary has-issues' : 'summary';
  const ok = document.createElement('span');
  ok.className = 'ok';
  ok.textContent = `✓ ${filled} filled`;
  summary.append(ok);
  if (issues.length) {
    const warn = document.createElement('span');
    warn.className = 'warn';
    warn.textContent = `⚠ ${issues.length} to check`;
    summary.append(warn);
  }
  const out = [summary, ...issues.map((l) => item(l.text, 'issue'))];

  const details = document.createElement('details');
  const label = document.createElement('summary');
  label.textContent = 'All fields';
  const all = document.createElement('ul');
  all.append(...lines.map((l) => item(l.text, l.status)));
  if (result.address === 'not-found' && result.frames && result.frames.length) all.append(item(`Frames on the page: ${result.frames.join(', ')}`, 'hint'));
  details.append(label, all);
  const more = document.createElement('li');
  more.append(details);
  out.push(more, item(AFTER_TEXT[step] || 'Check the form, finish the rest and save in IRIS.', 'next-hint'));
  list.replaceChildren(...out);
}

/** "Anna Kowalska" → "AK". */
function initials(s) {
  const letters = [s.first_name, s.last_name].map((n) => String(n || '').trim().charAt(0)).join('');
  return letters.toUpperCase() || '?';
}

// ---------- The steps strip and the sections ----------

let lastJourney = '';

const STEP_BUTTON = { individual: 'fill', registration: 'int-registration', course: 'int-course', outcome: 'int-outcome' };
const STEP_SECTION = { individual: 'sec-individual', registration: 'sec-interventions', course: 'sec-interventions', outcome: 'sec-outcome' };

// What the panel knows of the selected person's way through IRIS.
function journey(s) {
  const done = progress.get(s.id) || new Set();
  const check = dupChecks.get(s.id);
  const inIris = Boolean(check && check.state === 'done' && check.matches.some(isStrongMatch));
  const regs = registrationsFound.get(s.id);
  const outcome = outcomes.get(s.id);
  const working = Boolean(outcome && outcome.is_working);
  const steps = [
    { key: 'individual', label: 'Individual', done: inIris || done.has('individual') },
    { key: 'registration', label: 'Registration', done: Boolean(regs && regs.length) || done.has('registration') },
    { key: 'course', label: 'Course', done: done.has('course') },
    { key: 'outcome', label: 'Job outcome', done: working && isFilled(s.id), na: !working },
  ];
  const next = steps.find((x) => !x.done && !x.na);
  return { steps, next: next ? next.key : '', inIris, check, regs, outcome, working };
}

// Which sections stand open: the one for the IRIS form in the tab, else the next step's.
function autoSections(next) {
  if (formInfo.kind === 'individual' && formInfo.isNew) return new Set(['sec-individual']);
  if (formInfo.kind === 'intervention') return new Set([next === 'outcome' ? 'sec-outcome' : 'sec-interventions']);
  return new Set([STEP_SECTION[next] || 'sec-individual']);
}

function renderJourney() {
  const s = students.find((x) => x.id === selectedId);
  if (!s) return;
  const j = journey(s);
  const open = manualSections || autoSections(j.next);
  // Nothing changed since the last paint: leave the page alone, so nothing twitches.
  const signature = JSON.stringify([s.id, j.steps, j.next, [...open], [...(progress.get(s.id) || [])],
    j.check && j.check.state, j.regs && j.regs.length, j.outcome, isFilled(s.id), outcomes.has(s.id)]);
  if (signature === lastJourney) return;
  lastJourney = signature;

  $('steps').replaceChildren(...j.steps.map((step, i) => {
    const li = document.createElement('li');
    li.className = [step.done ? 'done' : '', step.key === j.next ? 'next' : '', step.na ? 'na' : '', open.has(STEP_SECTION[step.key]) ? 'open' : ''].filter(Boolean).join(' ');
    const button = document.createElement('button');
    button.type = 'button';
    button.title = step.na ? `${step.label}: not working, nothing to enter` : `${step.label}${step.done ? ': done' : ''}`;
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.textContent = step.done ? '✓' : step.na ? '–' : String(i + 1);
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = step.label;
    button.append(dot, label);
    button.addEventListener('click', () => {
      manualSections = new Set([STEP_SECTION[step.key]]);
      renderJourney();
      $(STEP_SECTION[step.key]).scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    li.append(button);
    return li;
  }));

  for (const id of ['sec-individual', 'sec-interventions', 'sec-outcome']) {
    $(id).querySelector('.block-head').setAttribute('aria-expanded', String(open.has(id)));
  }

  // The state of each section, on its header.
  const state = (id, text, cls = '') => {
    const el = $(id).querySelector('.state');
    el.textContent = text;
    el.className = `state ${cls}`.trim();
  };
  const done = progress.get(s.id) || new Set();
  state('sec-individual',
    j.inIris ? 'In IRIS ✓' : done.has('individual') ? 'Filled ✓' : j.check && j.check.state === 'checking' ? 'Looking in IRIS…'
      : j.check && j.check.state === 'done' ? 'Not in IRIS yet' : '',
    j.inIris || done.has('individual') ? 'ok' : '');
  const interventionsText = [
    (j.regs && j.regs.length) || done.has('registration') ? 'Registration ✓' : '',
    done.has('course') ? 'Course ✓' : '',
  ].filter(Boolean).join(' · ');
  state('sec-interventions', interventionsText, interventionsText ? 'ok' : '');
  state('sec-outcome',
    !outcomes.has(s.id) ? '' : j.outcome === undefined ? 'Could not load' : !j.outcome ? 'No answer yet'
      : !j.working ? 'Not working' : isFilled(s.id) ? 'Filled ✓' : 'To fill',
    j.working ? (isFilled(s.id) ? 'ok' : 'warn') : '');

  // One big button: the next step's.
  for (const [key, id] of Object.entries(STEP_BUTTON)) $(id).classList.toggle('primary', key === j.next);
}

// Sections open and close by hand too; the choice stands until another person or form.
for (const id of ['sec-individual', 'sec-interventions', 'sec-outcome']) {
  $(id).querySelector('.block-head').addEventListener('click', () => {
    const s = students.find((x) => x.id === selectedId);
    if (!s) return;
    const open = new Set(manualSections || autoSections(journey(s).next));
    if (open.has(id)) open.delete(id);
    else open.add(id);
    manualSections = open;
    renderJourney();
  });
}

// Registrations of a person already in IRIS, looked up with the field names learnt
// on an intervention form. Unknown until such a form was used once.
async function lookUpRegistrations(studentId, individualRecordId) {
  if (!registrationSchema || !individualEntity) return;
  let found;
  try {
    found = await runInIris(findIrisRegistrations, [individualEntity, registrationSchema, individualRecordId], { anyTab: true });
  } catch (e) {
    return;
  }
  if (!found || !found.ok) return;
  registrationsFound.set(studentId, found.matches);
  if (studentId === selectedId) renderJourney();
}

// ---------- Keyboard ----------

// In the search box: arrows move through the people, Enter picks one.
$('search').addEventListener('keydown', (e) => {
  if (!students.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    focusIndex = Math.max(0, Math.min(students.length - 1, (focusIndex < 0 && step < 0 ? 0 : focusIndex + step)));
    renderResults();
    const li = $('results').children[focusIndex];
    if (li) li.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    const s = students[focusIndex >= 0 ? focusIndex : 0];
    if (s) select(s.id);
  }
});

// Ctrl+Enter anywhere: run the highlighted step.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || $('main').hidden || !selectedId) return;
  const button = document.querySelector('#selected button.primary');
  if (button && !button.disabled) {
    e.preventDefault();
    button.click();
  }
});

start();
