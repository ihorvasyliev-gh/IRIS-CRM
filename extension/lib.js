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

/**
 * The search box applied to people already loaded (the "working" list):
 * the same rule as `buildSearchFilter`, every word must be in some field.
 */
export function matchesSearch(student, query) {
  const words = String(query || '').replace(UNSAFE, ' ').toLowerCase().trim().split(/\s+/).filter(Boolean);
  const fields = ['first_name', 'last_name', 'email', 'eircode'].map((col) => String(student[col] || '').toLowerCase());
  const phone = String(student.phone || '').replace(/\D/g, '');
  return words.every((word) => {
    if (fields.some((field) => field.includes(word))) return true;
    const digits = word.replace(/\D/g, '');
    if (digits.length < 3 || digits.length !== word.replace(/[\s+\-]/g, '').length) return false;
    return phone.includes(digits.startsWith('0') ? '353' + digits.slice(1) : digits);
  });
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
export function toIrisFields(student, firstRegisteredAt, staffName = '') {
  const fields = [
    { key: 'first_name', labels: ['First Name'], names: ['firstname'], type: 'text', value: (student.first_name || '').trim() },
    { key: 'last_name', labels: ['Last Name'], names: ['lastname'], type: 'text', value: (student.last_name || '').trim() },
    { key: 'mobile', labels: ['Mobile No.', 'Mobile No', 'Mobile Phone'], names: ['mobilephone'], type: 'text', value: toIrishLocalPhone(student.phone) },
    { key: 'email', labels: ['Email'], names: ['emailaddress1'], type: 'text', value: (student.email || '').trim() },
    { key: 'eircode', labels: ['Eircode'], names: [], type: 'text', value: (student.eircode || '').trim().toUpperCase() },
    { key: 'dob', labels: ['Date of Birth'], names: ['birthdate'], type: 'date', value: parseIsoDate(student.dob) },
    { key: 'registration', labels: ['Date of Registration Meeting'], names: [], type: 'date', value: localDateParts(firstRegisteredAt) },
    { key: 'cab', labels: ['CAB/Lot', 'CAB / Lot'], names: [], type: 'only-lookup', value: DEFAULT_CAB_LOT },
  ];
  // IRIS already puts the signed-in user on a new individual, so only a name from the settings changes it.
  if (String(staffName || '').trim()) fields.push(staffField(staffName));
  return fields;
}

/** The Action both intervention buttons pick, for the year in question. */
export const NEW_ARRIVALS_ACTION = 'SUPPORTS TO NEW ARRIVALS';

const actionField = (year) => ({
  key: 'action', labels: ['Action'], names: [], type: 'lookup',
  value: { name: NEW_ARRIVALS_ACTION, match: 'contains', preferYear: year },
});
// The staff member named in the panel's settings; with no name, the signed-in
// IRIS user, and then one already chosen on the form is left alone.
const staffField = (name) => (String(name || '').trim()
  ? { key: 'staff', labels: ['LDC Staff Member'], names: [], type: 'lookup', value: { name: String(name).trim(), match: 'one' } }
  : { key: 'staff', labels: ['LDC Staff Member'], names: [], type: 'lookup-me', value: true, keepExisting: true });
const typeField = (text) => ({ key: 'intervention_type', labels: ['Intervention Type'], names: [], type: 'option', value: text });
const supportField = (name) => ({ key: 'support_type', labels: ['Support Type'], names: [], type: 'lookup', value: { name, match: 'exact' } });
const STATUS_CHANGE = ['Has there been a change of status or progression outcome for the individual?'];

/**
 * Fields for the IRIS "New Individual Intervention" form.
 * 'registration': the one-to-one registration meeting, dated on the student's
 * first course registration. 'course': only the start of a course intervention.
 */
export function interventionFields(kind, firstRegisteredAt, today = new Date(), staffName = '') {
  const date = localDateParts(firstRegisteredAt);
  const action = actionField(kind === 'registration' && date ? date[0] : today.getFullYear());
  const staff = staffField(staffName);

  if (kind === 'course') return [action, staff, typeField('Labour market related course')];
  return [
    action,
    staff,
    typeField('One-to-one meeting'),
    { key: 'intervention_date', labels: ['Date of Intervention'], names: [], type: 'date', value: date },
    supportField('Career guidance'),
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
 * Fields for an intervention that records a job outcome: a one-to-one career
 * guidance meeting, status change "Yes", the economic status, then the
 * Employment block that IRIS opens for it.
 * Dates are 'YYYY-MM-DD'; `occupation` and `contract` are option texts chosen
 * in the panel ('' leaves the field for the person); `text` is the person's
 * own answer about where they work and `answeredAt` when they gave it: the
 * Action is the one of that year.
 */
export function outcomeFields({ interventionDate, startDate, occupation, contract, employmentType, text, answeredAt, staffName }, today = new Date()) {
  const date = parseIsoDate(interventionDate);
  const answered = localDateParts(answeredAt);
  const status = ECONOMIC_STATUS[employmentType];
  return [
    actionField((answered || date || [today.getFullYear()])[0]),
    staffField(staffName),
    typeField('One-to-one meeting'),
    supportField('Career guidance'),
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
  // 'one' is for a name a person typed: the record called exactly that, else
  // the only record containing it; with several it answers 'several'.
  const namedLookupValue = async (control, { name, match, preferYear, search }) => {
    const m = await lookupMeta(control);
    const filter = match === 'exact' ? `${m.name} eq ${odata(name)}` : `contains(${m.name},${odata(search || name)})`;
    let rows = await fetchRows(m, filter);
    const called = rows.filter((r) => norm(r[m.name]) === norm(name));
    if (match === 'same') rows = called;
    if (match === 'one') {
      if (called.length) rows = [called[0]];
      else if (rows.length > 1) return 'several';
    }
    if (!rows.length) return null;
    const byYear = preferYear && rows.find((r) => String(r[m.name]).includes(`(${preferYear})`));
    const newest = rows.slice().sort((a, b) => String(b[m.name]).localeCompare(String(a[m.name])))[0];
    const lookup = asLookup(m, byYear || newest);
    // No record for the wanted year: the newest is put, and the report says so.
    if (preferYear && !byYear) lookup.otherYear = { year: preferYear, name: newest[m.name] };
    return lookup;
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
        const wanted = field.type === 'lookup-me' ? { name: userName(), match: 'one' } : field.value;
        value = wanted.name ? await namedLookupValue(control, wanted) : null;
        if (value === 'several') {
          results.push({ key: field.key, status: 'choose', message: wanted.name });
          continue;
        }
        if (!value) {
          results.push({ key: field.key, status: 'no-match', message: wanted.name });
          continue;
        }
        if (value.otherYear) {
          const { year, name } = value.otherYear;
          delete value.otherYear;
          attr.setValue(value);
          if (typeof attr.fireOnChange === 'function') attr.fireOnChange();
          results.push({ key: field.key, status: 'other-year', message: `IRIS has none for ${year}, “${name}” was put` });
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

/** The last 7 digits of a phone number, which IRIS and the CRM write in different ways. */
export function phoneTail(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 7 ? digits.slice(-7) : '';
}

/** Who to look for in IRIS before a new individual is filled in. */
export function duplicateQuery(student) {
  return {
    first: (student.first_name || '').trim(),
    last: (student.last_name || '').trim(),
    email: (student.email || '').trim(),
    phoneTail: phoneTail(student.phone),
    dob: parseIsoDate(student.dob) ? String(student.dob).slice(0, 10) : '',
  };
}

/**
 * A match deserves a stop before filling when it shares the email, the phone,
 * or the name together with the date of birth. A namesake alone is only shown.
 */
export function isStrongMatch(match) {
  const why = match.why || [];
  return why.includes('email') || why.includes('phone') || (why.includes('name') && why.includes('date of birth'));
}

/**
 * Runs inside the IRIS page (main world). Says which kind of form is open:
 * 'individual' (has First Name and Last Name), 'intervention' (has Intervention
 * Type), 'other' for any other form, 'none' when no form is open.
 */
export function irisFormInfo() {
  const Xrm = window.Xrm;
  const page = Xrm && Xrm.Page;
  if (!page || !page.ui || !page.ui.controls || !page.data || !page.data.entity) return { kind: 'none' };
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const labels = new Set((page.ui.controls.get() || [])
    .filter((c) => typeof c.getLabel === 'function')
    .map((c) => norm(c.getLabel())));
  let kind = 'other';
  if (labels.has('interventiontype')) kind = 'intervention';
  else if (labels.has('firstname') && labels.has('lastname')) kind = 'individual';
  const isNew = typeof page.ui.getFormType === 'function' && page.ui.getFormType() === 1;
  return { kind, isNew, entity: page.data.entity.getEntityName() };
}

/**
 * Runs inside the IRIS page (main world), on an individual's form. Looks for
 * other individuals with the same email, the same phone (its last 7 digits) or
 * the same first and last name. The fields are found by their labels on the
 * open form, so their names never have to be guessed.
 */
export async function findIrisDuplicates(person) {
  const Xrm = window.Xrm;
  const page = Xrm && Xrm.Page;
  if (!page || !page.ui || !page.ui.controls || !page.data || !page.data.entity || !Xrm.WebApi || !Xrm.Utility) {
    return { ok: false, error: 'no-form' };
  }
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const controls = (page.ui.controls.get() || []).filter((c) =>
    typeof c.getAttribute === 'function' && typeof c.getLabel === 'function' && c.getAttribute());
  const attrName = (labels) => {
    const wanted = labels.map(norm);
    const control = controls.find((c) => wanted.includes(norm(c.getLabel())));
    return control ? control.getAttribute().getName() : null;
  };
  const f = {
    first: attrName(['First Name']),
    last: attrName(['Last Name']),
    email: attrName(['Email']),
    phone: attrName(['Mobile No.', 'Mobile No', 'Mobile Phone']),
    dob: attrName(['Date of Birth']),
  };
  if (!f.first || !f.last) return { ok: false, error: 'not-individual' };
  try {
    const entity = page.data.entity.getEntityName();
    const meta = await Xrm.Utility.getEntityMetadata(entity, []);
    const odata = (text) => `'${String(text).replace(/'/g, "''")}'`;
    const ors = [];
    if (person.email && f.email) ors.push(`${f.email} eq ${odata(person.email)}`);
    if (person.phoneTail && f.phone) {
      // "0871234567" and "087 123 4567" both end in 1234567 / 123 4567.
      ors.push(`contains(${f.phone},${odata(person.phoneTail)})`);
      ors.push(`contains(${f.phone},${odata(`${person.phoneTail.slice(0, 3)} ${person.phoneTail.slice(3)}`)})`);
    }
    if (person.first && person.last) ors.push(`(${f.first} eq ${odata(person.first)} and ${f.last} eq ${odata(person.last)})`);
    if (!ors.length) return { ok: true, matches: [] };
    const columns = [...new Set([meta.PrimaryIdAttribute, meta.PrimaryNameAttribute, ...Object.values(f).filter(Boolean)])];
    const found = await Xrm.WebApi.retrieveMultipleRecords(entity, `?$select=${columns.join(',')}&$filter=${ors.join(' or ')}&$top=10`);

    const currentId = String(page.data.entity.getId() || '').replace(/[{}]/g, '').toLowerCase();
    const digits = (s) => String(s || '').replace(/\D/g, '');
    // A date-only field comes back as "1990-04-23"; a date-time one as a moment, read in local time.
    const day = (v) => {
      if (!v) return '';
      const s = String(v);
      if (!s.includes('T')) return s.slice(0, 10);
      const d = new Date(s);
      return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const ctx = Xrm.Utility.getGlobalContext();
    const base = ctx && ctx.getClientUrl ? ctx.getClientUrl() : location.origin;
    const appId = new URLSearchParams(location.search).get('appid');
    const matches = found.entities
      .filter((r) => String(r[meta.PrimaryIdAttribute]).toLowerCase() !== currentId)
      .map((r) => {
        const dob = f.dob ? day(r[f.dob]) : '';
        const why = [];
        if (person.email && f.email && String(r[f.email] || '').trim().toLowerCase() === person.email.toLowerCase()) why.push('email');
        if (person.phoneTail && f.phone && digits(r[f.phone]).endsWith(person.phoneTail)) why.push('phone');
        if (norm(r[f.first]) === norm(person.first) && norm(r[f.last]) === norm(person.last)) why.push('name');
        if (person.dob && dob === person.dob) why.push('date of birth');
        const id = r[meta.PrimaryIdAttribute];
        return {
          name: r[meta.PrimaryNameAttribute] || `${r[f.first] || ''} ${r[f.last] || ''}`.trim(),
          email: f.email ? r[f.email] || '' : '',
          phone: f.phone ? r[f.phone] || '' : '',
          dob,
          why,
          url: `${base}/main.aspx?${appId ? `appid=${encodeURIComponent(appId)}&` : ''}pagetype=entityrecord&etn=${entity}&id=${id}`,
        };
      })
      .filter((m) => m.why.some((w) => w !== 'date of birth'));
    return { ok: true, matches };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/**
 * Runs inside the IRIS page (main world), on a saved individual's form. Opens a
 * new Individual Intervention for that individual, the way the form's own
 * "New Individual Intervention" does, so IRIS links the two and copies what it
 * maps. Does not wait for the new form: the panel watches for it.
 * `interventionEntity` is the table's name when the panel has seen such a form;
 * otherwise it is looked up among the tables that point at individuals.
 * `expected` is the person picked in the panel, which must be the one on the form.
 */
export async function openIrisIntervention(interventionEntity, expected) {
  const Xrm = window.Xrm;
  const page = Xrm && Xrm.Page;
  if (!page || !page.ui || !page.ui.controls || !page.data || !page.data.entity || !Xrm.Navigation) {
    return { ok: false, error: 'no-form' };
  }
  // Letters without accents, so "Zoë" and "Zoe" are the same name.
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const controls = (page.ui.controls.get() || []).filter((c) =>
    typeof c.getAttribute === 'function' && typeof c.getLabel === 'function' && c.getAttribute());
  const valueOf = (label) => {
    const control = controls.find((c) => norm(c.getLabel()) === norm(label));
    return control ? control.getAttribute().getValue() : null;
  };
  const first = valueOf('First Name');
  const last = valueOf('Last Name');
  if (first === null && last === null) return { ok: false, error: 'not-individual' };
  const onForm = `${first || ''} ${last || ''}`.trim();
  if (expected && (norm(first) !== norm(expected.first) || norm(last) !== norm(expected.last))) {
    return { ok: false, error: 'other-person', name: onForm };
  }
  const id = String(page.data.entity.getId() || '').replace(/[{}]/g, '');
  if (!id) return { ok: false, error: 'unsaved' };
  const parent = page.data.entity.getEntityName();

  let entity = interventionEntity;
  if (!entity) {
    try {
      const ctx = Xrm.Utility.getGlobalContext();
      const url = `${ctx.getClientUrl()}/api/data/v9.2/EntityDefinitions(LogicalName='${parent}')/OneToManyRelationships?$select=ReferencingEntity`;
      const response = await fetch(url, { headers: { Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' } });
      const names = [...new Set(((await response.json()).value || []).map((r) => r.ReferencingEntity))];
      const end = names.filter((n) => /intervention$/i.test(n));
      const found = end.length ? end : names.filter((n) => /intervention/i.test(n));
      if (found.length === 1) entity = found[0];
    } catch (e) {
      // Not allowed to read the tables: the panel asks for an intervention form to be opened once.
    }
  }
  if (!entity) return { ok: false, error: 'unknown-entity' };

  let name = '';
  try {
    name = page.data.entity.getPrimaryAttributeValue() || onForm;
  } catch (e) {
    name = onForm;
  }
  // The promise settles only when the new form is closed, so it is not awaited.
  Promise.resolve(Xrm.Navigation.openForm({ entityName: entity, createFromEntity: { entityType: parent, id, name } }))
    .catch((e) => console.error('CRM → IRIS: could not open a new intervention', e));
  return { ok: true, entity, name };
}

/**
 * Runs inside any IRIS page (main world). Opens an empty form for a new record
 * of `entity`, the way IRIS's own "New" does. Does not wait for it: the panel watches.
 */
export function openIrisNewForm(entity) {
  const Xrm = window.Xrm;
  if (!Xrm || !Xrm.Navigation || typeof Xrm.Navigation.openForm !== 'function') return { ok: false, error: 'no-iris' };
  // The promise settles only when the new form is closed, so it is not awaited.
  Promise.resolve(Xrm.Navigation.openForm({ entityName: entity }))
    .catch((e) => console.error('CRM → IRIS: could not open a new form', e));
  return { ok: true };
}

/**
 * Runs inside the IRIS page (main world), on an intervention form whose
 * individual is already set (as it is when opened from the individual's form).
 * Finds that individual's other interventions that look like a registration:
 * Intervention Type "One-to-one meeting" and Case Notes starting with "Reg".
 * Answers { ok: false, error: 'no-individual' } when the form has no individual yet.
 */
export async function findIrisRegistrations(individualEntity) {
  const Xrm = window.Xrm;
  const page = Xrm && Xrm.Page;
  if (!page || !page.ui || !page.ui.controls || !page.data || !page.data.entity || !Xrm.WebApi || !Xrm.Utility) {
    return { ok: false, error: 'no-form' };
  }
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const controls = (page.ui.controls.get() || []).filter((c) =>
    typeof c.getAttribute === 'function' && typeof c.getLabel === 'function' && c.getAttribute());
  const attrOf = (label) => {
    const control = controls.find((c) => norm(c.getLabel()) === norm(label));
    return control ? control.getAttribute() : null;
  };
  const type = attrOf('Intervention Type');
  const notes = attrOf('Case Notes');
  const date = attrOf('Date of Intervention');
  if (!type || !notes) return { ok: false, error: 'not-intervention' };
  const oneToOne = (type.getOptions() || []).find((o) => norm(o.text) === norm('One-to-one meeting'));
  if (!oneToOne) return { ok: false, error: 'no-one-to-one' };

  // The lookup that holds the individual: the one pointing at the individuals' table.
  if (!individualEntity) return { ok: false, error: 'no-individual' };
  const individual = controls.map((c) => c.getAttribute()).find((a) => {
    const v = typeof a.getValue === 'function' ? a.getValue() : null;
    return Array.isArray(v) && v[0] && v[0].entityType === individualEntity;
  });
  const who = individual && individual.getValue()[0];
  if (!who || !who.id) return { ok: false, error: 'no-individual' };
  try {
    const entity = page.data.entity.getEntityName();
    const meta = await Xrm.Utility.getEntityMetadata(entity, []);
    const id = String(who.id).replace(/[{}]/g, '');
    const columns = [meta.PrimaryIdAttribute, type.getName(), notes.getName(), date ? date.getName() : null].filter(Boolean);
    const filter = `_${individual.getName()}_value eq ${id} and ${type.getName()} eq ${oneToOne.value}`;
    const found = await Xrm.WebApi.retrieveMultipleRecords(entity, `?$select=${columns.join(',')}&$filter=${filter}&$top=20`);
    const currentId = String(page.data.entity.getId() || '').replace(/[{}]/g, '').toLowerCase();
    const day = (v) => {
      if (!v) return '';
      const s = String(v);
      if (!s.includes('T')) return s.slice(0, 10);
      const d = new Date(s);
      return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const ctx = Xrm.Utility.getGlobalContext();
    const base = ctx && ctx.getClientUrl ? ctx.getClientUrl() : location.origin;
    const appId = new URLSearchParams(location.search).get('appid');
    const matches = found.entities
      .filter((r) => String(r[meta.PrimaryIdAttribute]).toLowerCase() !== currentId)
      .filter((r) => /^\s*reg/i.test(String(r[notes.getName()] || '')))
      .map((r) => ({
        date: date ? day(r[date.getName()]) : '',
        notes: String(r[notes.getName()] || '').trim().slice(0, 60),
        url: `${base}/main.aspx?${appId ? `appid=${encodeURIComponent(appId)}&` : ''}pagetype=entityrecord&etn=${entity}&id=${r[meta.PrimaryIdAttribute]}`,
      }));
    return { ok: true, name: who.name || '', matches };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}
