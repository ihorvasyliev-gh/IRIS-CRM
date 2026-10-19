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

/** What to type into the IRIS "Auto Address" box: the Eircode, else the address. */
export function autoAddressQuery(student) {
  return (student.eircode || '').trim().toUpperCase() || (student.address || '').trim();
}

/**
 * Runs inside the IRIS page (main world) via chrome.scripting.executeScript,
 * so it must not use anything from outside its own body.
 * Fills fields through the Dynamics client API and never saves the form.
 */
export async function fillIrisForm(fields) {
  const Xrm = window.Xrm;
  const page = Xrm && Xrm.Page;
  if (!page || !page.ui || !page.ui.controls || typeof page.getAttribute !== 'function') {
    return { ok: false, error: 'no-form' };
  }
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const controls = page.ui.controls.get() || [];
  const controlByLabel = (labels) => {
    const wanted = labels.map(norm);
    for (const c of controls) {
      if (typeof c.getAttribute !== 'function' || typeof c.getLabel !== 'function') continue;
      if (c.getAttribute() && wanted.includes(norm(c.getLabel()))) return c;
    }
    return null;
  };

  // A lookup with a single sensible choice (CAB/Lot): take the only active
  // record, or the one named `preferred` when there are several.
  const onlyLookupValue = async (control, preferred) => {
    const entity = (control.getEntityTypes && control.getEntityTypes()[0]) || null;
    if (!entity || !Xrm.WebApi || !Xrm.Utility) throw new Error('lookup not readable');
    const meta = await Xrm.Utility.getEntityMetadata(entity, []);
    const id = meta.PrimaryIdAttribute;
    const name = meta.PrimaryNameAttribute;
    const select = `?$select=${id},${name}&$top=50`;
    let rows;
    try {
      rows = (await Xrm.WebApi.retrieveMultipleRecords(entity, `${select}&$filter=statecode eq 0`)).entities;
    } catch (e) {
      rows = (await Xrm.WebApi.retrieveMultipleRecords(entity, select)).entities;
    }
    const pick = rows.length === 1 ? rows[0] : rows.find((r) => norm(r[name]) === norm(preferred));
    return pick ? [{ id: pick[id], name: pick[name], entityType: entity }] : null;
  };

  const results = [];
  for (const field of fields) {
    if (field.value === null || field.value === '') {
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
    try {
      let value;
      if (field.type === 'date') {
        value = new Date(field.value[0], field.value[1] - 1, field.value[2]);
      } else if (field.type === 'only-lookup') {
        if (attr.getValue()) {
          results.push({ key: field.key, status: 'kept' });
          continue;
        }
        value = control ? await onlyLookupValue(control, field.value) : null;
        if (!value) {
          results.push({ key: field.key, status: 'choose' });
          continue;
        }
      } else {
        value = field.value;
      }
      attr.setValue(value);
      // Lets IRIS run its own rules, e.g. working out the Age Band.
      if (typeof attr.fireOnChange === 'function') attr.fireOnChange();
      results.push({ key: field.key, status: 'filled' });
    } catch (e) {
      results.push({ key: field.key, status: 'error', message: String(e && e.message || e) });
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
