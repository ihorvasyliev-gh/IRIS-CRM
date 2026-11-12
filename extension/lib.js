// Pure helpers shared by the side panel and the tests.

/** Characters that would break a PostgREST `or=(...)` filter. */
const UNSAFE = /[,()%*\\"]/g;

/**
 * Turns the search box text into one PostgREST `or` filter (or '' for none).
 * Each word must match some field, so "anna kowal" finds Anna Kowalska.
 */
export function buildSearchFilter(query) {
  const words = String(query || '')
    .replace(UNSAFE, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const perWord = words.map((word) => {
    const parts = ['first_name', 'last_name', 'email', 'eircode'].map(
      (col) => `${col}.ilike.%${word}%`,
    );
    const digits = word.replace(/\D/g, '');
    if (digits.length >= 3 && digits.length === word.replace(/[\s+\-]/g, '').length) {
      // Phones are stored as +353..., people type 087...
      const national = digits.startsWith('0') ? '353' + digits.slice(1) : digits;
      parts.push(`phone.ilike.%${national}%`);
    }
    return parts.join(',');
  });
  if (perWord.length <= 1) return perWord[0] || '';
  // Inside or=(...): a single and() of one or() per word.
  return `and(${perWord.map((p) => `or(${p})`).join(',')})`;
}

/** +353871234567 → 0871234567. Foreign numbers stay as they are. */
export function toIrishLocalPhone(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('353') && digits.length >= 11) return '0' + digits.slice(3);
  return raw;
}

/** '1990-04-23' → [1990, 4, 23], or null. */
export function parseIsoDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** '1990-04-23' → '23/04/1990' for display. */
export function formatDate(value) {
  const parts = parseIsoDate(value);
  if (!parts) return '';
  const [y, mo, d] = parts;
  return `${String(d).padStart(2, '0')}/${String(mo).padStart(2, '0')}/${y}`;
}

/** A timestamp → [y, m, d] of that moment in the browser's own time zone, or null. */
export function localDateParts(timestamp) {
  if (!timestamp) return null;
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return null;
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()];
}

/** The CAB/Lot picked when IRIS offers more than one. */
export const DEFAULT_CAB_LOT = 'Cork City (17-1)';

/**
 * The IRIS fields this extension fills, found on the form by their label.
 * `names` are logical-name guesses tried when no label matches.
 * `firstRegisteredAt` is the student's earliest course registration in the CRM.
 */
export function toIrisFields(student, firstRegisteredAt) {
  return [
    { key: 'first_name', labels: ['First Name'], names: ['firstname'], type: 'text', value: (student.first_name || '').trim() },
    { key: 'last_name', labels: ['Last Name'], names: ['lastname'], type: 'text', value: (student.last_name || '').trim() },
    { key: 'mobile', labels: ['Mobile No.', 'Mobile No', 'Mobile Phone'], names: ['mobilephone'], type: 'text', value: toIrishLocalPhone(student.phone) },
    { key: 'email', labels: ['Email'], names: ['emailaddress1'], type: 'text', value: (student.email || '').trim() },
    { key: 'eircode', labels: ['Eircode'], names: [], type: 'text', value: (student.eircode || '').trim().toUpperCase() },
    { key: 'dob', labels: ['Date of Birth'], names: ['birthdate'], type: 'date', value: parseIsoDate(student.dob) },
    { key: 'registration', labels: ['Date of Registration Meeting'], names: [], type: 'date', value: localDateParts(firstRegisteredAt) },
    { key: 'cab', labels: ['CAB/Lot', 'CAB / Lot'], names: [], type: 'only-lookup', value: DEFAULT_CAB_LOT },
  ];
}

/** The Action both intervention buttons pick, for the year in question. */
export const NEW_ARRIVALS_ACTION = 'SUPPORTS TO NEW ARRIVALS';

const actionField = (year) => ({
  key: 'action', labels: ['Action'], names: [], type: 'lookup',
  value: { name: NEW_ARRIVALS_ACTION, match: 'contains', preferYear: year },
});
const staffField = () => ({ key: 'staff', labels: ['LDC Staff Member'], names: [], type: 'lookup-me', value: true, keepExisting: true });
const STATUS_CHANGE = ['Has there been a change of status or progression outcome for the individual?'];

/**
 * Fields for the IRIS "New Individual Intervention" form.
 * 'registration': the one-to-one registration meeting, dated on the student's
 * first course registration. 'course': only the start of a course intervention.
 */
export function interventionFields(kind, firstRegisteredAt, today = new Date()) {
  const date = localDateParts(firstRegisteredAt);
  const action = actionField(kind === 'registration' && date ? date[0] : today.getFullYear());
  const staff = staffField();
  const type = (text) => ({ key: 'intervention_type', labels: ['Intervention Type'], names: [], type: 'option', value: text });

  if (kind === 'course') return [action, staff, type('Labour market related course')];
  return [
    action,
    staff,
    type('One-to-one meeting'),
    { key: 'intervention_date', labels: ['Date of Intervention'], names: [], type: 'date', value: date },
    { key: 'support_type', labels: ['Support Type'], names: [], type: 'lookup', value: { name: 'Career guidance', match: 'exact' } },
    { key: 'case_notes', labels: ['Case Notes'], names: [], type: 'text', value: 'Reg' },
    { key: 'personal_plan', labels: ['Personal Plan Agreed'], names: [], type: 'boolean', value: true },
    { key: 'status_change', labels: STATUS_CHANGE, names: [], type: 'option', value: 'No' },
  ];
}

/** The "Current Economic Status" record for a CRM employment type. */
export const ECONOMIC_STATUS = { full_time: 'Employed - Full-Time', part_time: 'Employed - Part-Time' };

/** The two lists of the outcome that the panel shows and IRIS decides. */
const occupationField = (value) => ({ key: 'occupation', labels: ['Occupational group'], names: [], type: 'option', value, recheck: true });
const contractField = (value) => ({ key: 'contract', labels: ['Contract Type'], names: [], type: 'option', value, recheck: true });

/** Fields whose option lists the panel reads from the open form (see `fillIrisForm`, `readOnly`). */
export function outcomeOptionFields() {
  return [occupationField(null), contractField(null)];
}

/** '2026-03' (the month a job started, as the CRM keeps it) → '2026-03-01'. */
export function monthStart(month) {
  return /^\d{4}-\d{2}$/.test(String(month || '')) ? `${month}-01` : '';
}

/** [2026, 3, 1] → '2026-03-01', the value of a date box. */
export function isoDate(parts) {
  return parts ? `${parts[0]}-${String(parts[1]).padStart(2, '0')}-${String(parts[2]).padStart(2, '0')}` : '';
}

/** '1/3/2026' or '01.03.2026', as people type a date → '2026-03-01'; '' when it is not a real day. */
export function parseTypedDate(text) {
  const m = /^\s*(\d{1,2})[./-](\d{1,2})[./-](\d{4})\s*$/.exec(String(text || ''));
  if (!m) return '';
  const [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(year, month - 1, day);
  const real = date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  return real ? isoDate([year, month, day]) : '';
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** '2026-03-01' → 'March 2026'. */
export function monthName(value) {
  const parts = parseIsoDate(value);
  return parts && MONTH_NAMES[parts[1] - 1] ? `${MONTH_NAMES[parts[1] - 1]} ${parts[0]}` : '';
}

/**
 * The Case Notes line of a job outcome. It keeps the person's own words,
 * which the Occupational group cannot:
 * 'Outcome: working part-time since March 2026 (“Lidl warehouse”)'.
 */
export function outcomeNote({ text, startDate, employmentType }) {
  const hours = { full_time: ' full-time', part_time: ' part-time' }[employmentType] || '';
  const since = monthName(startDate);
  const where = String(text || '').trim();
  return `Outcome: working${hours}${since ? ` since ${since}` : ''}${where ? ` (“${where}”)` : ''}`;
}

/**
 * Fields for an intervention that records a job outcome: status change "Yes",
 * the economic status, then the Employment block that IRIS opens for it.
 * Dates are 'YYYY-MM-DD'; `occupation` and `contract` are option texts chosen
 * in the panel ('' leaves the field for the person); `text` is the person's
 * own answer about where they work.
 */
export function outcomeFields({ interventionDate, startDate, occupation, contract, employmentType, text }, today = new Date()) {
  const date = parseIsoDate(interventionDate);
  const status = ECONOMIC_STATUS[employmentType];
  return [
    actionField(date ? date[0] : today.getFullYear()),
    staffField(),
    { key: 'intervention_date', labels: ['Date of Intervention'], names: [], type: 'date', value: date },
    // Notes already typed on the form are not replaced.
    { key: 'case_notes', labels: ['Case Notes'], names: [], type: 'text', value: outcomeNote({ text, startDate, employmentType }), keepExisting: true },
    { key: 'status_change', labels: STATUS_CHANGE, names: [], type: 'option', value: 'Yes' },
    // IRIS shows the Employment block once the status says "employed": give its rules a moment.
    {
      key: 'economic_status', labels: ['Current Economic Status'], names: [], type: 'lookup',
      value: status ? { name: status, match: 'same', search: 'Employed' } : null, pauseMs: 400,
    },
    { key: 'employment_start', labels: ['Employment Start Date'], names: [], type: 'date', value: parseIsoDate(startDate), recheck: true },
    occupationField(occupation || null),
    contractField(contract || null),
  ];
}

/** What to type into the IRIS "Auto Address" box: the Eircode, else the address. */
export function autoAddressQuery(student) {
  return (student.eircode || '').trim().toUpperCase() || (student.address || '').trim();
}

/**
 * Runs inside the IRIS page (main world) via chrome.scripting.executeScript,
 * so it must not use anything from outside its own body.
 * Fills fields through the Dynamics client API and never saves the form.
 * With `readOnly` it changes nothing and only reports which fields the form
 * has, with the option list of each 'option' field.
 */
export async function fillIrisForm(fields, readOnly = false) {
  const Xrm = window.Xrm;
  const page = Xrm && Xrm.Page;
  if (!page || !page.ui || !page.ui.controls || typeof page.getAttribute !== 'function') {
    return { ok: false, error: 'no-form' };
  }
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const controls = page.ui.controls.get() || [];
  const withAttr = controls.filter((c) =>
    typeof c.getAttribute === 'function' && typeof c.getLabel === 'function' && c.getAttribute());
  const controlByLabel = (labels) => {
    const wanted = labels.map(norm);
    const exact = withAttr.find((c) => wanted.includes(norm(c.getLabel())));
    if (exact) return exact;
    // Long labels get reworded or cut: let them match by their start.
    return withAttr.find((c) => {
      const label = norm(c.getLabel());
      return wanted.some((w) => w.length >= 20 && label.length >= 20 && (w.startsWith(label) || label.startsWith(w)));
    }) || null;
  };

  const lookupMeta = async (control) => {
    const entity = (control && control.getEntityTypes && control.getEntityTypes()[0]) || null;
    if (!entity || !Xrm.WebApi || !Xrm.Utility) throw new Error('lookup not readable');
    const meta = await Xrm.Utility.getEntityMetadata(entity, []);
    return { entity, id: meta.PrimaryIdAttribute, name: meta.PrimaryNameAttribute };
  };
  // Active records first; some tables have no statecode, so retry without it.
  const fetchRows = async (m, filter) => {
    const select = `?$select=${m.id},${m.name}&$top=50`;
    const both = (f) => [f, 'statecode eq 0'].filter(Boolean).join(' and ');
    try {
      return (await Xrm.WebApi.retrieveMultipleRecords(m.entity, `${select}&$filter=${both(filter)}`)).entities;
    } catch (e) {
      return (await Xrm.WebApi.retrieveMultipleRecords(m.entity, filter ? `${select}&$filter=${filter}` : select)).entities;
    }
  };
  const odata = (text) => `'${String(text).replace(/'/g, "''")}'`;
  const asLookup = (m, row) => [{ id: row[m.id], name: row[m.name], entityType: m.entity }];

  // A lookup with a single sensible choice (CAB/Lot): take the only active
  // record, or the one named `preferred` when there are several.
  const onlyLookupValue = async (control, preferred) => {
    const m = await lookupMeta(control);
    const rows = await fetchRows(m, '');
    const pick = rows.length === 1 ? rows[0] : rows.find((r) => norm(r[m.name]) === norm(preferred));
    return pick ? asLookup(m, pick) : null;
  };

  // A lookup by record name. With several matches, the one carrying
  // "(preferYear)" wins, else the newest-looking name.
  // 'same' finds the records containing `search` and takes the one whose name
  // is `name` whatever its dashes, spaces and capitals.
  const namedLookupValue = async (control, { name, match, preferYear, search }) => {
    const m = await lookupMeta(control);
    const filter = match === 'exact' ? `${m.name} eq ${odata(name)}` : `contains(${m.name},${odata(search || name)})`;
    let rows = await fetchRows(m, filter);
    if (match === 'same') rows = rows.filter((r) => norm(r[m.name]) === norm(name));
    if (!rows.length) return null;
    const byYear = preferYear && rows.find((r) => String(r[m.name]).includes(`(${preferYear})`));
    const newest = rows.slice().sort((a, b) => String(b[m.name]).localeCompare(String(a[m.name])))[0];
    return asLookup(m, byYear || newest);
  };

  const userName = () => {
    const ctx = Xrm.Utility && Xrm.Utility.getGlobalContext && Xrm.Utility.getGlobalContext();
    return ctx && ctx.userSettings ? ctx.userSettings.userName : '';
  };
  const hasValue = (attr) => {
    const v = attr.getValue();
    return v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length);
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const optionTexts = (attr) =>
    (typeof attr.getOptions === 'function' ? attr.getOptions() || [] : [])
      .map((o) => String(o.text || '').trim())
      .filter((text) => text && !/^-+\s*select\s*-+$/i.test(text));
  // The option with this text; IRIS may have a shorter or longer wording of it.
  const findOption = (attr, text) => {
    const options = attr.getOptions() || [];
    const want = norm(text);
    return options.find((o) => norm(o.text) === want)
      || options.find((o) => {
        const have = norm(o.text);
        return Math.min(have.length, want.length) >= 6 && (have.startsWith(want) || want.startsWith(have));
      });
  };

  const results = [];
  // Fields to look at again once IRIS has run its rules.
  const recheck = [];
  for (const field of fields) {
    // Chrome drops null properties on the way into the page, so "no value" arrives as undefined.
    const empty = field.value === null || field.value === undefined || field.value === '';
    if (empty && !readOnly && field.type !== 'option') {
      results.push({ key: field.key, status: 'empty' });
      continue;
    }
    let attr = null;
    const control = controlByLabel(field.labels);
    if (control) attr = control.getAttribute();
    for (const name of field.names) {
      if (attr) break;
      attr = page.getAttribute(name);
    }
    if (!attr) {
      results.push({ key: field.key, status: 'not-found' });
      continue;
    }
    // The panel keeps its lists in step with IRIS from these.
    const options = field.type === 'option' ? optionTexts(attr) : undefined;
    if (readOnly || empty) {
      results.push({ key: field.key, status: readOnly ? 'found' : 'empty', options });
      continue;
    }
    if ((field.keepExisting || field.type === 'only-lookup') && hasValue(attr)) {
      results.push({ key: field.key, status: 'kept' });
      continue;
    }
    try {
      let value;
      if (field.type === 'date') {
        value = new Date(field.value[0], field.value[1] - 1, field.value[2]);
      } else if (field.type === 'only-lookup') {
        value = await onlyLookupValue(control, field.value);
        if (!value) {
          results.push({ key: field.key, status: 'choose' });
          continue;
        }
      } else if (field.type === 'lookup' || field.type === 'lookup-me') {
        const wanted = field.type === 'lookup-me' ? { name: userName(), match: 'exact' } : field.value;
        value = wanted.name ? await namedLookupValue(control, wanted) : null;
        if (!value) {
          results.push({ key: field.key, status: 'no-match', message: wanted.name });
          continue;
        }
      } else if (field.type === 'option') {
        const option = findOption(attr, field.value);
        if (!option) {
          results.push({ key: field.key, status: 'no-match', message: field.value, options });
          continue;
        }
        value = option.value;
      } else {
        value = field.value;
      }
      attr.setValue(value);
      // Lets IRIS run its own rules, e.g. working out the Age Band.
      if (typeof attr.fireOnChange === 'function') attr.fireOnChange();
      const result = { key: field.key, status: 'filled', options };
      results.push(result);
      if (field.recheck) recheck.push({ attr, value, result });
      if (field.pauseMs) await sleep(field.pauseMs);
    } catch (e) {
      results.push({ key: field.key, status: 'error', message: String(e && e.message || e) });
    }
  }

  // A rule of the form may wipe a field it has just revealed. Put the value
  // back once; if IRIS wipes it again, say so instead of "filled".
  if (recheck.length) {
    await sleep(300);
    for (const { attr, value, result } of recheck) {
      if (hasValue(attr)) continue;
      attr.setValue(value);
      if (typeof attr.fireOnChange === 'function') attr.fireOnChange();
      await sleep(150);
      if (!hasValue(attr)) result.status = 'cleared';
    }
  }

  // Where the frames point, shown when the Auto Address box can't be found.
  const frames = Array.from(document.querySelectorAll('iframe'))
    .map((f) => {
      try {
        const u = new URL(f.src, location.href);
        return u.protocol.startsWith('http') ? u.host + u.pathname.slice(0, 80) : '';
      } catch (e) {
        return '';
      }
    })
    .filter(Boolean);

  return { ok: true, results, frames };
}

/**
 * Runs in every frame of the IRIS tab: the Auto Address box lives in its own
 * frame. Types the query so IRIS shows its suggestions, then picks the
 * suggestion when there is exactly one. With several, the person picks.
 * Returns 'picked', 'typed' or 'not-found'.
 */
export async function typeAutoAddress(query, waitMs = 6000) {
  const usable = (el) => !el.disabled && !el.readOnly && el.type !== 'hidden';
  // The placeholder first; other attributes only as a fallback, without
  // "postcode", so the form's own "County / Dublin Postcode" field never matches.
  const tests = [
    (el) => /full address|postcode/i.test(el.placeholder || ''),
    (el) => /full address|autoaddress/i.test([el.getAttribute('aria-label'), el.title, el.id, el.name, el.className].join(' ')),
  ];
  const find = (root, test) => {
    for (const el of root.querySelectorAll('input')) {
      if (usable(el) && test(el)) return el;
    }
    // Some custom controls keep their input inside an open shadow root.
    for (const host of root.querySelectorAll('*')) {
      if (host.shadowRoot) {
        const el = find(host.shadowRoot, test);
        if (el) return el;
      }
    }
    return null;
  };
  const input = find(document, tests[0]) || find(document, tests[1]);
  if (!input) return 'not-found';

  // Suggestion lines: visible blocks with text and no blocks inside them.
  const lines = () => {
    const out = [];
    for (const el of document.body ? document.body.querySelectorAll('*') : []) {
      if (el === input || el.contains(input) || /^(SCRIPT|STYLE|INPUT|LABEL)$/.test(el.tagName)) continue;
      const style = getComputedStyle(el);
      if (style.display === 'inline' || style.display === 'none' || style.visibility === 'hidden') continue;
      if (!el.getClientRects().length || !el.textContent.trim()) continue;
      const hasBlockInside = Array.from(el.querySelectorAll('*')).some((child) => {
        const d = getComputedStyle(child).display;
        return d !== 'inline' && d !== 'none' && child.textContent.trim();
      });
      if (!hasBlockInside) out.push(el);
    }
    return out;
  };
  const before = waitMs > 0 ? new Set(lines()) : null;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  input.focus();
  setter.call(input, query);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Unidentified' }));
  input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));
  if (!before) return 'typed';

  // Wait for the suggestions to arrive and stop changing.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let last = '';
  let stable = 0;
  for (let waited = 0; waited < waitMs; waited += 250) {
    await sleep(250);
    const fresh = lines().filter((el) => !before.has(el));
    const key = fresh.map((el) => el.textContent.trim()).join('\n');
    stable = key && key === last ? stable + 1 : 0;
    last = key;
    if (stable < 2) continue;
    if (fresh.length !== 1) return 'typed';
    const choice = fresh[0];
    for (const type of ['mouseover', 'mousedown', 'mouseup']) {
      choice.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    choice.click();
    return 'picked';
  }
  return 'typed';
}
