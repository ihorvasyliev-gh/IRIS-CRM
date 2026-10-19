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

/**
 * The IRIS fields this extension fills, found on the form by their label.
 * `names` are logical-name guesses tried when no label matches.
 */
export function toIrisFields(student) {
  return [
    { key: 'first_name', labels: ['First Name'], names: ['firstname'], type: 'text', value: (student.first_name || '').trim() },
    { key: 'last_name', labels: ['Last Name'], names: ['lastname'], type: 'text', value: (student.last_name || '').trim() },
    { key: 'mobile', labels: ['Mobile No.', 'Mobile No', 'Mobile Phone'], names: ['mobilephone'], type: 'text', value: toIrishLocalPhone(student.phone) },
    { key: 'email', labels: ['Email'], names: ['emailaddress1'], type: 'text', value: (student.email || '').trim() },
    { key: 'eircode', labels: ['Eircode'], names: [], type: 'text', value: (student.eircode || '').trim().toUpperCase() },
    { key: 'dob', labels: ['Date of Birth'], names: ['birthdate'], type: 'date', value: parseIsoDate(student.dob) },
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
export function fillIrisForm(fields, addressQuery) {
  const page = window.Xrm && window.Xrm.Page;
  if (!page || !page.ui || !page.ui.controls || typeof page.getAttribute !== 'function') {
    return { ok: false, error: 'no-form' };
  }
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const controls = page.ui.controls.get() || [];
  const attrByLabel = (labels) => {
    const wanted = labels.map(norm);
    for (const c of controls) {
      if (typeof c.getAttribute !== 'function' || typeof c.getLabel !== 'function') continue;
      const attr = c.getAttribute();
      if (attr && wanted.includes(norm(c.getLabel()))) return attr;
    }
    return null;
  };

  const results = [];
  for (const field of fields) {
    if (field.value === null || field.value === '') {
      results.push({ key: field.key, status: 'empty' });
      continue;
    }
    let attr = attrByLabel(field.labels);
    for (const name of field.names) {
      if (attr) break;
      attr = page.getAttribute(name);
    }
    if (!attr) {
      results.push({ key: field.key, status: 'not-found' });
      continue;
    }
    try {
      const value = field.type === 'date'
        ? new Date(field.value[0], field.value[1] - 1, field.value[2])
        : field.value;
      attr.setValue(value);
      // Lets IRIS run its own rules, e.g. working out the Age Band.
      if (typeof attr.fireOnChange === 'function') attr.fireOnChange();
      results.push({ key: field.key, status: 'filled' });
    } catch (e) {
      results.push({ key: field.key, status: 'error', message: String(e && e.message || e) });
    }
  }

  // The Auto Address box is a custom control: type into it so IRIS shows its
  // suggestions, and the person picks the right one.
  let address = 'skipped';
  if (addressQuery) {
    const input = document.querySelector('input[placeholder*="Full Address" i], input[placeholder*="Postcode" i]');
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      input.focus();
      setter.call(input, addressQuery);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ' ' }));
      address = 'typed';
    } else {
      address = 'not-found';
    }
  }

  return { ok: true, results, address };
}
