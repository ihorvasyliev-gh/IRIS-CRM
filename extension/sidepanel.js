import {
  autoAddressQuery,
  buildSearchFilter,
  fillIrisForm,
  formatDate,
  toIrisFields,
  toIrishLocalPhone,
} from './lib.js';

const $ = (id) => document.getElementById(id);
const COLUMNS = 'id, first_name, last_name, email, phone, address, eircode, dob, created_at';
const FIELD_NAMES = {
  first_name: 'First Name',
  last_name: 'Last Name',
  mobile: 'Mobile No.',
  email: 'Email',
  eircode: 'Eircode',
  dob: 'Date of Birth',
};

let client = null;
let channel = null;
let students = [];
let selectedId = null;
let searchSeq = 0;
let searchTimer = null;

function show(section) {
  for (const id of ['setup', 'login', 'main']) $(id).hidden = id !== section;
  $('logout').hidden = section !== 'main';
}

async function start() {
  const { supabaseUrl, supabaseKey } = await chrome.storage.local.get(['supabaseUrl', 'supabaseKey']);
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
  $('fill-report').replaceChildren();
  renderResults();
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
}

$('fill').addEventListener('click', async () => {
  const s = students.find((x) => x.id === selectedId);
  if (!s) return;
  const button = $('fill');
  button.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: fillIrisForm,
      args: [toIrisFields(s), autoAddressQuery(s)],
    });
    renderReport(result);
  } catch (e) {
    renderReport({ ok: false, error: String(e && e.message || e) });
  } finally {
    button.disabled = false;
  }
});

function renderReport(result) {
  const item = (text, cls) => {
    const li = document.createElement('li');
    li.textContent = text;
    li.className = cls;
    return li;
  };
  if (!result || !result.ok) {
    const message = result && result.error === 'no-form'
      ? 'Open the New Individual form in IRIS first, then press Fill.'
      : `Could not fill: ${(result && result.error) || 'unknown error'}. Is the IRIS tab active?`;
    $('fill-report').replaceChildren(item(message, 'error'));
    return;
  }
  const text = {
    filled: 'filled',
    empty: 'nothing in the CRM',
    'not-found': 'field not found on the form',
    error: 'IRIS refused the value',
  };
  const lines = result.results.map((r) =>
    item(`${FIELD_NAMES[r.key]}: ${text[r.status]}${r.message ? ` (${r.message})` : ''}`, r.status),
  );
  if (result.address === 'typed') lines.push(item('Auto Address: typed, pick the address from the IRIS list', 'filled'));
  if (result.address === 'not-found') lines.push(item('Auto Address: box not found, fill the address by hand', 'not-found'));
  lines.push(item('Check the form, finish the rest and save in IRIS.', ''));
  $('fill-report').replaceChildren(...lines);
}

start();
