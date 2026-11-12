// Turning what a person wrote about their job into one of the fixed
// "Occupational group" options of IRIS. Pure helpers, shared with the tests.

/**
 * The groups IRIS offers: the CSO census "intermediate occupational groups".
 * Each line is [name, other spellings of the name, words that point to it].
 *
 * Words: a word matches the start of a word in the answer ("clean" finds
 * "cleaner"), `=word` and words of up to three letters match whole words only,
 * several words match in a row, `:0.6` makes a hint weaker or stronger.
 * These are first guesses: the person at the panel has the last word, and the
 * panel remembers it.
 */
const GROUPS = [
  ['Army occupations', [],
    'army, soldier, military, defence forces, defense forces, navy, naval, air corps, армі, арми, військов, военн'],
  ['Building and construction workers', ['Building and construction'],
    'construction, builder, building site, building:0.7, bricklayer, carpenter, carpentry, joiner, plasterer, plastering, painter, painting, decorator, roofer, roofing, tiler, tiling, scaffold, labourer, laborer, groundwork, plumber, plumbing, paving, insulation, drywall, formwork, steel fixer, glazier, =site:0.5, будівн, будівел, строит, стройк, маляр, сантехн, тесля, плотник, штукатур'],
  ['Business and commerce occupations', ['Business and commerce'],
    'accountant, accounting, accountancy, account:0.8, finance, financial, bank, banking, insurance, auditor, audit, tax, marketing, hr, human resources, recruitment, recruiter, analyst, business analyst, consultant, consulting, procurement, buyer, purchasing, broker, underwriter, compliance, investment, fund:0.7, credit union, economist, business development, advertising, public relations, aib, bank of ireland, ptsb, permanent tsb, pwc, deloitte, kpmg, ey, бухгалтер, фінанс, финанс, банк, маркет, страхув, страхов, економіст, экономист, рекрут'],
  ['Central and local government workers', ['Government workers', 'Government'],
    'civil servant, civil service, council, city council, county council, government, local authority, public service, public sector, department of, revenue:0.7, intreo, держслужб, державн, госслужб, государств, мерія, мэрия'],
  ['Chemical, paper, wood, rubber, plastics, and printing workers', ['Chemical, paper, wood, rubber, plastics and printing workers', 'Chemical workers'],
    'chemical, printing, print:0.6, printer:0.6, plastic, paper mill, sawmill, rubber, =pharma, pharmaceutical, biopharma, pfizer, lilly, novartis, gsk, janssen, abbvie, msd, gilead, хімічн, химическ, друкар, типограф'],
  ['Clerical and office workers', ['Clerical and office', 'Clerical workers'],
    'admin, administrator, administration, administrative, =office, =offices, receptionist, reception, secretary, clerk, clerical, data entry, customer service, customer support, customer care, call centre, call center, back office, accounts assistant, accounts clerk, payroll, bookkeeper, bookkeeping, personal assistant, front desk:0.8, typist, адміністратор, администратор, офіс, офис, секретар, діловод, делопроизвод'],
  ['Communication, warehouse and transport workers', ['Communication', 'Communications', 'Transport', 'Warehouse and transport workers'],
    'warehouse, warehousing, forklift, driver, driving, delivery, deliver, courier, logistics, picker, order picker, dispatch, shipping, freight, storekeeper, storeman, stores person, stock control:0.7, truck, lorry, hgv, bus, taxi, uber, freenow, deliveroo, just eat, dpd, dhl, fedex, ups, gls, an post, postman, postal, post office, transport, haulage, van, =port, airport:0.6, склад, комірник, кладовщ, водій, водитель, доставк, курєр, курьер, логіст, логист, вантаж, грузчик, таксі, такси'],
  ['Computer software occupations', ['Computer software', 'Computer occupations'],
    'it, software, software engineer, qa engineer, developer, programmer, programming, coder, web developer, frontend, front end, backend, back end, full stack, fullstack, qa, tester, testing:0.6, devops, sysadmin, system administrator, systems administrator, network engineer, it support, tech support, technical support, helpdesk, help desk, data engineer, data analyst, data scientist, cyber, cloud, ux, ui, web design, machine learning, ai, =tech:0.7, technology:0.7, apple:0.6, dell:0.6, vmware, ibm:0.6, microsoft:0.6, google:0.6, aws, salesforce:0.6, qualcomm, mcafee, trend micro, workday, іт, айті, айти, програміст, программист, розробник, разработчик, тестувальник, тестировщик'],
  ['Electrical trades workers', ['Electrical trades'],
    'electrician, electrical, electric, electronics, wiring, електрик, электрик, електромонт, электромонт'],
  ['Engineering and allied trades workers', ['Engineering and allied trades', 'Engineering trades workers'],
    'mechanic, welder, welding, fitter, machinist, cnc, toolmaker, tool maker, sheet metal, metalwork, metal work, fabricat, garage, car repair, auto repair, panel beater, maintenance technician, maintenance:0.6, technician:0.5, locksmith, зварюв, сварщ, механік, механик, слюсар, слесар, токар'],
  ['Farming, fishing and forestry workers', ['Farming, fishing and forestry', 'Farming'],
    'farm, farmer, farming, agricultur, fishing, fisherman, fishery, forestry, gardener, gardening, landscap, horticultur, mushroom, greenhouse, livestock, equine, фермер, ферм, сільськ, сельск, садівн, садовн, теплиц'],
  ['Food, drink and tobacco production workers', ['Food, drink and tobacco production', 'Food production workers'],
    'bakery, baker, butcher, meat factory, meat plant, meat processing, meat:0.8, food production, food factory, food processing, food manufactur, fish processing, fish factory, brewery, distillery, confectionery, dairy, abattoir, dairygold, kepak, carbery, пекар, мясокомбинат, мясокомбінат, харчов, пищев'],
  ['Garda Siochana', ['Gardai', 'Garda'],
    'garda, gardai, police, policeman, policewoman, поліц, полиц'],
  ['Health and related workers', ['Health workers', 'Health'],
    '=nurse, =nurses, nursing, doctor, physician, gp, health, health care, hca, carer, caregiver, care assistant, care worker, home care, homecare, home help, care home, nursing home, =care, caring:0.7, hospital:0.9, clinic, medic, dentist, dental, pharmacist, pharmacy:0.8, physio, paramedic, ambulance, midwife, radiograph, optician, therapist:0.8, occupational therap, speech therap, hse, cuh, bon secours, elderly, disability:0.6, медсестр, медбрат, лікар, врач, медик, медиц, доглядальн, сиделк, догляд, опікун, стоматолог, аптек, фармацевт'],
  ['Managers and executives', ['Managers'],
    'manager:1.6, managing director, director, executive, ceo, head of, team lead:0.9, team leader:0.9, supervisor:0.8, owner:0.8, менеджер, керівник, руководит, директор'],
  ['Other gainful occupations (incl. not stated)', ['Other gainful occupations', 'Other occupations'], ''],
  ['Other manufacturing workers', ['Other manufacturing', 'Manufacturing workers'],
    'factory, manufactur, production, operative, operator:0.7, assembly, assembler, packer, packing, packaging, process operator, general operative, machine operator, production line, line worker, medical device, stryker, boston scientific, depuy, завод, фабрик, виробнич, производств, упаков, пакув'],
  ['Other professional workers', ['Other professional', 'Other professionals'],
    'lawyer, solicitor, barrister, legal, law firm, paralegal, journalist, translator, translation, interpreter, interpreting, designer, graphic design, artist, musician, music, photographer, writer, editor, librarian, library, psychologist, actor, film, =media, museum, юрист, адвокат, журналіст, журналист, перекладач, переводчик, дизайнер, художн, музикант, музыкант, фотограф, психолог'],
  ['Personal service and childcare workers', ['Personal service and childcare', 'Personal service workers', 'Personal services'],
    'childcare, child care, children:0.8, creche, childminder, childminding, nanny, au pair, montessori:0.8, preschool, pre school, playschool, early years, sna, special needs assistant, teaching assistant, hairdresser, hairdressing, hair salon, hair stylist, barber, beauty, beautician, beauty therapist, nail, manicur, lash, makeup, make up, massage, salon, spa, cleaner, cleaning, clean, housekeep, accommodation assistant, room attendant, hotel, hostel, guesthouse, hospitality, waiter, waitress, waiting staff, bartender, barman, barmaid, bar, barista, cafe, coffee, coffee shop, restaurant, chef, cook, kitchen, kitchen porter, kp, catering, caterer, pub, takeaway, fast food, mcdonald, burger king, kfc, supermac, subway:0.7, starbucks, costa, pizza, domino, laundry, dry clean, launderette, caretaker, janitor, security:0.8, security guard, doorman, porter, gym, fitness, personal trainer, leisure centre, tour guide, tourism, travel:0.6, flight attendant, cabin crew, pet, groomer, прибира, уборк, уборщ, клінінг, клининг, готел, отел, кухн, кухар, повар, офіціант, официант, бармен, бариста, кафе, ресторан, перукар, парикмахер, манікюр, маникюр, краса, красот, косметолог, масаж, массаж, няня, нянь, охорон, охран, покоївк, горничн'],
  ['Religious occupations', ['Religious'],
    'priest, pastor, church, clergy, chaplain, nun, religious, parish, imam, rabbi, священ, церкв, пастор'],
  ['Sales occupations', ['Sales workers', 'Sales'],
    'retail, shop, sales, salesperson, cashier, checkout, =till, supermarket, store, shop assistant, sales assistant, retail assistant, merchandis, =deli, counter:0.6, petrol station, filling station, forecourt, showroom, estate agent, pharmacy:0.5, dunnes:0.9, tesco:0.9, lidl:0.9, aldi:0.9, supervalu:0.9, centra:0.9, =spar:0.9, penneys:0.9, primark:0.9, marks spencer:0.9, tk maxx:0.9, ikea:0.9, zara:0.9, boots:0.9, smyths:0.9, woodies:0.9, homesense:0.9, dealz:0.9, circle k:0.9, applegreen:0.9, maxol:0.9, harvey norman:0.9, currys:0.9, decathlon:0.9, sports direct:0.9, jd sports:0.9, brown thomas:0.9, mace:0.9, londis:0.9, polonez:0.9, магазин, продав, касир, кассир, торгів, торгов'],
  ['Scientific and technical occupations', ['Scientific and technical', 'Scientific occupations'],
    'engineer, scientist, science, laboratory, lab, chemist, biologist, biotech, microbiolog, physicist, architect, research, quality control, quality assurance, qc, lab technician, laboratory technician, surveyor, geologist, technologist, process engineer, validation, draughts, cad, =pharma:0.5, інженер, инженер, лаборант, науков, научн, архітект, архитект, хімік, химик'],
  ['Social workers and related occupations', ['Social workers and related', 'Social workers'],
    'social worker, social work, social care, social care worker, social services, community worker, community development, community:0.7, youth worker, youth work, support worker, family support, project worker, outreach worker, key worker, advocacy, counsellor, counselling, welfare, charity, ngo, non profit, nonprofit, homeless, tusla, соціальн, социальн'],
  ['Teachers', ['Teaching', 'Teaching occupations'],
    'teacher, teaching, tutor, lecturer, professor, school:0.7, educator, education:0.8, trainer:0.7, instructor:0.7, university:0.6, college:0.6, вчител, учител, викладач, преподават, освіт, образован, репетитор, вихователь, воспитатель'],
  ['Textile, clothing and leather workers', ['Textile, clothing and leather', 'Textile workers'],
    'tailor, sewing, seamstress, textile, upholster, garment, clothing factory, alteration, dressmaker, shoemaker, cobbler, leather, швачка, швея, кравець, кравчин, портн, шить'],
];

/** Lower-case words of a text, accents and apostrophes dropped. Keeps Cyrillic. */
export function words(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/['’ʼ`]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

const PARSED = GROUPS.map(([name, aliases, keywords]) => ({
  names: [name, ...aliases],
  keywords: keywords.split(',').map((raw) => raw.trim()).filter(Boolean).map((raw) => {
    const [phrase, weight] = raw.split(':');
    const parts = phrase.trim().split(/\s+/).map((part) => {
      const exact = part.startsWith('=');
      const w = words(part).join('');
      return { w, exact: exact || w.length <= 3 };
    });
    const letters = parts.reduce((n, p) => n + p.w.length, 0);
    return { parts, score: Number(weight || 1) * (1 + letters / 20) };
  }),
}));

/** The names this extension expects in IRIS, used until the real list is read from the form. */
export const DEFAULT_OCCUPATION_OPTIONS = GROUPS.map(([name]) => name);

/** Words that say nothing about the job, left out when answers are compared. */
const FILLER = new Set(words('a an the in at of for and as to i am im my is on with work working works job company ltd limited cork ireland'));

/** What an answer is remembered under: "Working at Lidl, Cork" and "lidl" are the same answer. */
export function occupationKey(text) {
  const all = words(text);
  const kept = all.filter((w) => !FILLER.has(w));
  return (kept.length ? kept : all).join(' ');
}

const squash = (text) => words(text).join('');

/**
 * The option of the real IRIS list that goes by one of `names`, or null.
 * IRIS shortens some names ("Communication"), so one may be the start of the other.
 */
export function matchOption(options, names) {
  const wanted = names.map(squash).filter(Boolean);
  const exact = options.find((o) => wanted.includes(squash(o)));
  if (exact) return exact;
  let best = null;
  for (const option of options) {
    const have = squash(option);
    for (const want of wanted) {
      const length = Math.min(have.length, want.length);
      if (length >= 6 && (have.startsWith(want) || want.startsWith(have)) && (!best || length > best.length)) {
        best = { option, length };
      }
    }
  }
  return best ? best.option : null;
}

const fits = (tokens, at, parts) =>
  at + parts.length <= tokens.length
  && parts.every((p, k) => (p.exact ? tokens[at + k] === p.w : tokens[at + k].startsWith(p.w)));

/** How strongly the answer's words point to one group, and the words that did it. */
function scoreGroup(group, tokens) {
  const hits = [];
  for (const keyword of group.keywords) {
    for (let at = 0; at < tokens.length; at++) {
      if (fits(tokens, at, keyword.parts)) hits.push({ at, length: keyword.parts.length, score: keyword.score });
    }
  }
  // A word counts once per group: "sales assistant" is not "sales" plus "sales assistant".
  hits.sort((a, b) => b.score - a.score);
  const used = new Set();
  let score = 0;
  let word = '';
  for (const hit of hits) {
    const span = Array.from({ length: hit.length }, (_, k) => hit.at + k);
    if (span.some((i) => used.has(i))) continue;
    span.forEach((i) => used.add(i));
    score += hit.score;
    if (!word) word = span.map((i) => tokens[i]).join(' ');
  }
  return score ? { score, word } : null;
}

/**
 * The IRIS options that fit an answer, best first:
 * [{ option, score, why: { kind, text } }].
 *
 * `options` is the list read from the IRIS form. `memory` holds earlier
 * choices, { [occupationKey]: { option, text } }:
 *   'remembered': this very answer was given a group before, it wins outright;
 *   'similar':    an earlier answer is part of this one ("Lidl" in "Lidl Douglas");
 *   'word':       a known word of the answer points to the group.
 */
export function suggestOccupations(text, options, memory = {}) {
  const tokens = words(text);
  if (!tokens.length) return [];
  const key = occupationKey(text);
  const keyTokens = key.split(' ');
  const found = new Map();
  const offer = (option, score, why) => {
    if (!option) return;
    const had = found.get(option);
    if (!had) found.set(option, { option, score, why, best: score });
    else {
      // Two reasons for one group: the stronger one counts, the other adds a little.
      const best = Math.max(had.best, score);
      found.set(option, { option, score: best + 0.1 * Math.min(had.best, score), why: score > had.best ? why : had.why, best });
    }
  };

  for (const [remembered, entry] of Object.entries(memory)) {
    const option = entry && matchOption(options, [entry.option]);
    if (!option) continue;
    if (remembered === key) {
      offer(option, 100, { kind: 'remembered', text: entry.text });
      continue;
    }
    const parts = remembered.split(' ').map((w) => ({ w, exact: true }));
    if (keyTokens.some((_, at) => fits(keyTokens, at, parts))) {
      offer(option, 1 + remembered.replace(/ /g, '').length / 20, { kind: 'similar', text: entry.text });
    }
  }
  for (const group of PARSED) {
    const hit = scoreGroup(group, tokens);
    if (hit) offer(matchOption(options, group.names), hit.score, { kind: 'word', text: hit.word });
  }
  return [...found.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ option, score, why }) => ({ option, score, why }));
}

/**
 * The Contract Type for a CRM employment type ('full_time' | 'part_time'):
 * what was chosen for it last time, else the only option that says full or
 * part time, else null.
 */
export function guessContract(employmentType, options, memory = {}) {
  const remembered = memory[employmentType || 'unknown'];
  const kept = remembered && matchOption(options, [remembered]);
  if (kept) return kept;
  const wanted = { full_time: 'fulltime', part_time: 'parttime' }[employmentType];
  if (!wanted) return null;
  const hits = options.filter((o) => squash(o).includes(wanted));
  return hits.length === 1 ? hits[0] : null;
}
