(() => {
  'use strict';

  const SOURCE = 'semper-referencje-ocr';
  const EXTENSION_VERSION = '0.3.17';
  const KLUCZ_STANU_WTYCZKI = 'semper_stan_wtyczki_v1';
  const STORAGE_PREFIX = 'semper_ref_v2_';
  const CATEGORY_CACHE_PREFIX = 'semper_ref_cat_v3_';
  const CATEGORY_CACHE_TTL = 10 * 60 * 1000;
  const MAX_VISIBLE_ANALYSIS = 100;
  const LIST_PAGE_SIZE_KEY = 'semper_ref_list_page_size_v1';
  const LIST_PAGE_JUMP_KEY = 'semper_ref_list_page_jump_v1';
  const PANEL_WIDTH_KEY = 'semper_ui_ocr_panel_width';
  const PANEL_COLLAPSED_KEY = 'semper_ui_ocr_panel_collapsed';
  const PANEL_DEFAULT_WIDTH = 500;
  const PANEL_MIN_WIDTH = 360;
  const PANEL_COLLAPSED_WIDTH = 46;
  const DAILY_CATEGORY_ACTIVITY_KEY = 'semper_category_activity_v1';
  const DAILY_CATEGORY_ACTIVITY_RETENTION_DAYS = 120;
  const PENDING_CATEGORY_SAVE_KEY = 'semper_category_save_pending_v1';
  const AFTER_SAVE_SORT_KEY = 'semper_ref_after_save_sort_v3';
  const AFTER_SAVE_SORT_DEFAULT = ''; // domyślnie bieżąca data RRMMDD

  // Klasyfikator 3.0: hybrydowy model lokalny oparty na podobieństwie tytułów,
  // rdzeniach/fuzzy matching, publicznej ofercie SEMPER i zatwierdzonych decyzjach użytkownika.
  const CLASSIFIER_VERSION = '3.2.2';
  const KNOWLEDGE_CACHE_KEY = 'semper_classifier_knowledge_v3';
  const KNOWLEDGE_CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
  const KNOWLEDGE_DISCOVERY_TTL = 7 * 24 * 60 * 60 * 1000;
  const KNOWLEDGE_DETAILS_PER_SESSION = 70;
  const KNOWLEDGE_MAX_EXAMPLES = 700;

  let classifierKnowledge = { examples: [], profiles: {}, updatedAt: 0, discoveredAt: 0, pendingUrls: [] };
  let learnedExamples = [];
  let classifierInitPromise = null;
  let knowledgeSyncPromise = null;

  const SPECIAL_CATEGORY_ORDER = [
    'nowości',
    'Training in English/ W języku angielskim',
    'szkolenia on-line',
    'szkolenia wyjazdowe',
    'warsztaty biznesowe'
  ];

  const dirtyChanges = new Set();

  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  function setDirty(key, dirty = true) {
    if (!key) return;
    if (dirty) dirtyChanges.add(key);
    else dirtyChanges.delete(key);
  }

  function localDateKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function localCompactDateKey(date = new Date()) {
    const year = String(date.getFullYear()).slice(-2);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
  }

  function updateDailyCategoryCounterElements(count) {
    const safeCount = Math.max(0, Number.isFinite(Number(count)) ? Number(count) : 0);
    document.querySelectorAll('.semper-daily-category-counter').forEach((element) => {
      element.textContent = element.dataset.compact === '1'
        ? `Dzisiaj: ${safeCount}`
        : `Dzisiaj sklasyfikowano referencji: ${safeCount}`;
      element.title = 'Licznik referencji, którym dzisiaj zapisano co najmniej jedną kategorię. Możesz go skorygować ręcznie przyciskami − / + lub wyzerować.';
    });
  }

  function normalizeDailyActivityDay(day) {
    const ids = new Set(Array.isArray(day?.ids) ? day.ids.map(String) : []);
    const manualAdjustment = Number.isFinite(Number(day?.manualAdjustment)) ? Math.trunc(Number(day.manualAdjustment)) : 0;
    return { ids, manualAdjustment };
  }

  async function getTodayCategoryAssignmentCount() {
    const stored = (await chrome.storage.local.get(DAILY_CATEGORY_ACTIVITY_KEY))[DAILY_CATEGORY_ACTIVITY_KEY] || {};
    const day = normalizeDailyActivityDay(stored?.days?.[localDateKey()]);
    return Math.max(0, day.ids.size + day.manualAdjustment);
  }

  async function refreshDailyCategoryCounters() {
    try {
      updateDailyCategoryCounterElements(await getTodayCategoryAssignmentCount());
    } catch (error) {
      console.warn('[SEMPER OCR] Nie udało się odczytać dziennego licznika kategorii.', error);
    }
  }

  async function writeTodayCategoryActivity(ids, manualAdjustment = 0) {
    const stored = (await chrome.storage.local.get(DAILY_CATEGORY_ACTIVITY_KEY))[DAILY_CATEGORY_ACTIVITY_KEY] || {};
    const days = stored?.days && typeof stored.days === 'object' ? { ...stored.days } : {};
    const today = localDateKey();
    days[today] = {
      ids: [...new Set([...ids].map(String))],
      manualAdjustment: Math.trunc(Number(manualAdjustment) || 0),
      updatedAt: Date.now()
    };

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - DAILY_CATEGORY_ACTIVITY_RETENTION_DAYS);
    const cutoffKey = localDateKey(cutoff);
    for (const key of Object.keys(days)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(key) && key < cutoffKey) delete days[key];
    }

    await chrome.storage.local.set({ [DAILY_CATEGORY_ACTIVITY_KEY]: { days, updatedAt: Date.now() } });
    const count = Math.max(0, new Set([...ids].map(String)).size + Math.trunc(Number(manualAdjustment) || 0));
    updateDailyCategoryCounterElements(count);
    return count;
  }

  async function markCategoryAssignmentToday(id) {
    const referenceId = String(id || '').trim();
    if (!referenceId) return getTodayCategoryAssignmentCount();
    const stored = (await chrome.storage.local.get(DAILY_CATEGORY_ACTIVITY_KEY))[DAILY_CATEGORY_ACTIVITY_KEY] || {};
    const day = normalizeDailyActivityDay(stored?.days?.[localDateKey()]);
    day.ids.add(referenceId);
    return writeTodayCategoryActivity(day.ids, day.manualAdjustment);
  }

  async function adjustTodayCategoryAssignmentCount(delta) {
    const stored = (await chrome.storage.local.get(DAILY_CATEGORY_ACTIVITY_KEY))[DAILY_CATEGORY_ACTIVITY_KEY] || {};
    const day = normalizeDailyActivityDay(stored?.days?.[localDateKey()]);
    const current = Math.max(0, day.ids.size + day.manualAdjustment);
    const requested = Math.max(0, current + Math.trunc(Number(delta) || 0));
    day.manualAdjustment = requested - day.ids.size;
    return writeTodayCategoryActivity(day.ids, day.manualAdjustment);
  }

  async function resetTodayCategoryAssignmentCount() {
    return writeTodayCategoryActivity(new Set(), 0);
  }

  function makeDailyCategoryCounter(compact = false) {
    const wrap = document.createElement('span');
    wrap.className = 'semper-daily-category-counter-wrap';

    const counter = document.createElement('span');
    counter.className = 'semper-daily-category-counter';
    counter.dataset.compact = compact ? '1' : '0';
    counter.textContent = compact ? 'Dzisiaj: …' : 'Dzisiaj sklasyfikowano referencji: …';

    const minus = document.createElement('button');
    minus.type = 'button';
    minus.className = 'semper-daily-counter-btn';
    minus.textContent = '−';
    minus.title = 'Zmniejsz licznik o 1';

    const plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'semper-daily-counter-btn';
    plus.textContent = '+';
    plus.title = 'Zwiększ licznik o 1';

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'semper-daily-counter-reset';
    reset.textContent = 'Reset';
    reset.title = 'Wyzeruj dzisiejszy licznik';

    minus.addEventListener('click', () => adjustTodayCategoryAssignmentCount(-1));
    plus.addEventListener('click', () => adjustTodayCategoryAssignmentCount(1));
    reset.addEventListener('click', () => {
      if (window.confirm('Wyzerować dzisiejszy licznik przypisanych referencji?')) resetTodayCategoryAssignmentCount();
    });

    wrap.append(minus, counter, plus, reset);
    refreshDailyCategoryCounters();
    return wrap;
  }

  async function processPendingCategorySaveCounter() {
    const raw = sessionStorage.getItem(PENDING_CATEGORY_SAVE_KEY);
    if (!raw) return;
    let pending = null;
    try {
      pending = JSON.parse(raw);
    } catch (_) {
      sessionStorage.removeItem(PENDING_CATEGORY_SAVE_KEY);
      return;
    }
    const id = String(pending?.id || '').trim();
    const requested = [...new Set((pending?.requestedIds || []).map(String).filter(Boolean))];
    if (!id) {
      sessionStorage.removeItem(PENDING_CATEGORY_SAVE_KEY);
      return;
    }

    try {
      const verified = await getAssignedCategories(id, true);
      const actual = new Set((verified?.ids || []).map(String));
      const expected = new Set(requested);
      const matches = actual.size === expected.size && [...expected].every((value) => actual.has(value));
      if (matches) {
        if (actual.size) await markCategoryAssignmentToday(id);
        sessionStorage.removeItem(PENDING_CATEGORY_SAVE_KEY);
      }
    } catch (error) {
      console.warn('[SEMPER OCR] Nie udało się potwierdzić zapisu kategorii dla dziennego licznika.', error);
    }
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[DAILY_CATEGORY_ACTIVITY_KEY]) refreshDailyCategoryCounters();
  });

  window.addEventListener('beforeunload', (event) => {
    if (!dirtyChanges.size) return;
    event.preventDefault();
    event.returnValue = '';
  });

  const CATEGORIES = [
    { id: 1, name: 'zamówienia publiczne', specificity: 1.08, anchors: ['zamówienia publiczne', 'prawo zamówień publicznych', 'pzp', 'swz', 'kio', 'przetarg', 'zamawiający', 'wykonawca', 'tryb podstawowy', 'postępowanie o udzielenie zamówienia'] },
    { id: 2, name: 'zarządzanie / menedżerskie', anchors: ['zarządzanie zespołem', 'zarządzanie zasobami ludzkimi', 'menedżer', 'kierownik', 'lider', 'leadership', 'przywództwo', 'motywowanie', 'delegowanie', 'zarządzanie procesami'] },
    { id: 3, name: 'zarządzanie projektami', specificity: 1.04, anchors: ['zarządzanie projektami', 'zarządzanie projektem', 'project management', 'project manager', 'agile', 'scrum', 'harmonogram projektu', 'metodyka projektowa'] },
    { id: 4, name: 'produkcja / logistyka', anchors: ['produkcja', 'logistyka', 'łańcuch dostaw', 'supply chain', 'lean', 'transport', 'incoterms', 'proces produkcyjny'] },
    { id: 5, name: 'negocjacje / sprzedaż / komunikacja', anchors: ['negocjacje', 'sprzedaż', 'komunikacja', 'perswazja', 'rozmowa handlowa', 'trudny klient', 'handlowiec', 'komunikacja w zespole'] },
    { id: 6, name: 'administracja / dla urzędników', specificity: 0.88, anchors: ['administracja publiczna', 'administracja samorządowa', 'urzędnik', 'urząd', 'jst', 'jednostka samorządu terytorialnego', 'sektor publiczny', 'dostępność osobom ze szczególnymi potrzebami'] },
    { id: 7, name: 'HR / kadry', anchors: ['prawo pracy', 'kadry', 'hr', 'rekrutacja', 'czas pracy', 'wynagrodzenia', 'urlopy', 'pracownik', 'pracodawca', 'zatrudnianie'] },
    { id: 8, name: 'prawo', specificity: 0.84, anchors: ['prawo', 'ustawa', 'kodeks', 'przepisy', 'orzecznictwo', 'regulacje', 'odpowiedzialność prawna', 'compliance'] },
    { id: 9, name: 'warsztaty biznesowe', anchors: ['warsztaty biznesowe', 'biznes', 'case study', 'kompetencje biznesowe'] },
    { id: 10, name: 'obsługa klienta', anchors: ['obsługa klienta', 'customer service', 'reklamacje', 'kontakt z klientem', 'trudny klient', 'pacjent jako klient'] },
    { id: 11, name: 'budownictwo', specificity: 1.06, anchors: ['budownictwo', 'budowlany', 'roboty budowlane', 'prawo budowlane', 'proces budowlany', 'proces inwestycyjny', 'kierownik budowy', 'obiekt budowlany', 'inwestycja budowlana', 'fidic', 'kosztorysowanie'] },
    { id: 12, name: 'księgowość / rachunkowość / podatki', anchors: ['rachunkowość', 'księgowość', 'sprawozdanie finansowe', 'vat', 'cit', 'pit', 'podatek', 'podatki', 'ksef', 'faktura', 'księga rachunkowa'] },
    { id: 13, name: 'tematyka unijna', anchors: ['fundusze europejskie', 'fundusze unijne', 'projekty unijne', 'unia europejska', 'kpo', 'program operacyjny', 'perspektywa finansowa', 'kwalifikowalność wydatków', 'rozliczanie projektów unijnych'] },
    { id: 14, name: 'kontrola zarządcza / finanse publ.', specificity: 1.05, anchors: ['kontrola zarządcza', 'finanse publiczne', 'dyscyplina finansów publicznych', 'zarządzanie ryzykiem', 'budżet jednostki', 'sektor finansów publicznych'] },
    { id: 15, name: 'szkolenia wyjazdowe', additional: true, anchors: ['szkolenie wyjazdowe', 'zakwaterowanie w cenie', 'noclegi i wyżywienie', 'szkolenie w zakopanem', 'szkolenie w kołobrzegu'] },
    { id: 17, name: 'ochrona środowiska / gosp. odpadami', specificity: 0.93, anchors: ['ochrona środowiska', 'środowisko', 'emisje', 'kobize', 'korzystanie ze środowiska', 'pozwolenie środowiskowe', 'prawo wodne', 'gospodarka wodna', 'opłaty środowiskowe'] },
    { id: 18, name: 'energetyka', specificity: 1.05, anchors: ['energetyka', 'energetyczny', 'energia', 'sieć energetyczna', 'urządzenia instalacje i sieci', 'eksploatacja urządzeń', 'kwalifikacje energetyczne', 'świadectwo kwalifikacyjne', 'komisja kwalifikacyjna', 'oze', 'odnawialne źródła energii'] },
    { id: 20, name: 'marketing', anchors: ['marketing', 'branding', 'social media', 'media społecznościowe', 'kampania marketingowa', 'promocja', 'facebook', 'instagram'] },
    { id: 21, name: 'postępowanie administracyjne', specificity: 1.05, anchors: ['postępowanie administracyjne', 'decyzja administracyjna', 'organ administracji', 'strona postępowania', 'procedura administracyjna', 'postępowanie przed organem'] },
    { id: 22, name: 'bezpieczeństwo', anchors: ['cyberbezpieczeństwo', 'bezpieczeństwo informacji', 'zarządzanie kryzysowe', 'ochrona informacji', 'phishing', 'incydent bezpieczeństwa', 'bezpieczeństwo danych', 'sytuacja kryzysowa'] },
    { id: 23, name: 'windykacja należności / post. egzekucyjne', specificity: 1.06, anchors: ['windykacja', 'postępowanie egzekucyjne', 'egzekucja', 'należności', 'komornik', 'odzyskiwanie należności', 'zabezpieczenie wierzytelności'] },
    { id: 24, name: 'nieruchomości', anchors: ['nieruchomość', 'nieruchomości', 'wspólnota mieszkaniowa', 'zarządca nieruchomości', 'gospodarka nieruchomościami', 'najem lokali', 'służebność przesyłu', 'stan prawny nieruchomości'] },
    { id: 25, name: 'audyt / kontrola', anchors: ['audyt', 'audytor', 'kontrola wewnętrzna', 'kontrola', 'czynności kontrolne', 'program audytu'] },
    { id: 29, name: 'komputerowe / IT / AI sztuczna inteligencja', specificity: 1.05, anchors: ['sztuczna inteligencja', 'chatgpt', 'ai act', 'ai', 'power bi', 'excel', 'python', 'informatyczny', 'technologie cyfrowe', 'system informatyczny', 'bim', 'gis'] },
    { id: 33, name: 'gospodarka odpadami', specificity: 1.08, anchors: ['gospodarka odpadami', 'odpady komunalne', 'odpady', 'ewidencja odpadów', 'sprawozdawczość odpadowa', 'magazynowanie odpadów', 'klasyfikacja odpadów', 'recykling'] },
    { id: 34, name: 'KPA', specificity: 1.14, anchors: ['kodeks postępowania administracyjnego', 'kpa'] },
    { id: 35, name: 'BDO', specificity: 1.14, anchors: ['bdo', 'baza danych o produktach i opakowaniach', 'rejestr bdo', 'system bdo'] },
    { id: 36, name: 'prawo autorskie', specificity: 1.10, anchors: ['prawo autorskie', 'copyright', 'licencja', 'utwór', 'własność intelektualna', 'prawa autorskie'] },
    { id: 37, name: 'prawo energetyczne', specificity: 1.12, anchors: ['prawo energetyczne', 'ustawa prawo energetyczne', 'taryfa energetyczna', 'regulacje energetyczne'] },
    { id: 38, name: 'nowości', additional: true, anchors: ['nowelizacja', 'zmiany w przepisach', 'nowe przepisy', 'nowe regulacje', 'nowe obowiązki', 'po zmianach', 'aktualne zmiany', 'reforma', 'najważniejsze zmiany'] },
    { id: 39, name: 'sektor medyczny', anchors: ['podmiot leczniczy', 'ochrona zdrowia', 'szpital', 'pacjent', 'medyczny', 'placówka medyczna', 'działalność lecznicza', 'dokumentacja medyczna'] },
    { id: 40, name: 'zrównoważony rozwój ESG', specificity: 1.08, anchors: ['zrównoważony rozwój', 'esg', 'csr', 'taksonomia', 'raportowanie niefinansowe', 'csrd', 'zielona transformacja', 'ślad węglowy'] },
    { id: 41, name: 'gospodarka magazynowa', specificity: 1.08, anchors: ['gospodarka magazynowa', 'magazyn', 'inwentaryzacja', 'stany magazynowe', 'zarządzanie magazynem', 'zapasy magazynowe'] },
    { id: 42, name: 'autoprezentacja', anchors: ['autoprezentacja', 'wystąpienia publiczne', 'wystąpienie publiczne', 'prezentacja', 'wizerunek', 'mowa ciała', 'przemawianie'] },
    { id: 43, name: 'kompetencje cyfrowe', anchors: ['kompetencje cyfrowe', 'narzędzia cyfrowe', 'transformacja cyfrowa', 'dostępność cyfrowa', 'digitalizacja', 'cyfryzacja', 'e-usługi'] }
  ];

  // Publiczne strony służą wyłącznie do odkrywania linków do konkretnych szkoleń.
  // Etykiety kategorii pobieramy dopiero ze strony szczegółowej szkolenia, gdzie SEMPER
  // publikuje rzeczywiste przypisania (breadcrumb/lista kategorii przy tytule).
  const SEMPER_DISCOVERY_URLS = [
    '/szkolenia',
    '/szkolenia-zamowienia-publiczne',
    '/szkolenia-prawo',
    '/szkolenia-prawo/prawo-budowlane',
    '/szkolenia-prawo/prawo-administracyjne',
    '/szkolenia-prawo/prawo-autorskie',
    '/szkolenia-prawo/prawo-energetyczne',
    '/szkolenia-administracja',
    '/szkolenia-administracja/kpa',
    '/szkolenia-ksiegowosc',
    '/szkolenia-zarzadzanie',
    '/szkolenia-zarzdzanie-projektami',
    '/szkolenia-komputerowe-it',
    '/produkcja-logistyka',
    '/szkolenia-gospodarka-magazynowa',
    '/szkolenia-negocjacje',
    '/szkolenia-komunikacja',
    '/szkolenia-unijne',
    '/szkolenia-kontrola-zarzadcza',
    '/szkolenia-budowlane',
    '/hr-kadry',
    '/szkolenia-audyt-wewntrzny',
    '/szkolenia-windykacja-naleznosci',
    '/szkolenia-ochrona-srodowiska',
    '/szkolenia-ochrona-srodowiska/gospodarka-odpadami',
    '/szkolenia-ochrona-srodowiska/gospodarka-odpadami/bdo',
    '/szkolenia-obsluga-klienta',
    '/szkolenia-autoprezentacja',
    '/w-jezyku-angielskim'
  ];

  const STRONG_MARKERS = new Map([
    [1, ['pzp', 'swz', 'kio', 'zamowienia publiczne']],
    [2, ['zarzadzanie zasobami ludzkimi']],
    [11, ['fidic', 'prawo budowlane', 'roboty budowlane']],
    [12, ['ksef', 'vat', 'cit', 'pit']],
    [13, ['fundusze europejskie', 'projekty unijne', 'kwalifikowalnosc wydatkow']],
    [14, ['kontrola zarzadcza', 'finanse publiczne']],
    [17, ['kobize', 'oplata za korzystanie ze srodowiska']],
    [18, ['swiadectwo kwalifikacyjne', 'komisja kwalifikacyjna', 'urzadzenia instalacje i sieci']],
    [23, ['windykacja', 'postepowanie egzekucyjne']],
    [29, ['chatgpt', 'ai act', 'power bi']],
    [33, ['gospodarka odpadami', 'ewidencja odpadow']],
    [34, ['kpa', 'kodeks postepowania administracyjnego']],
    [35, ['bdo', 'rejestr bdo']],
    [36, ['prawo autorskie']],
    [37, ['prawo energetyczne']],
    [40, ['esg', 'csrd']]
  ]);

  const CATEGORY_PRIORITY = [
    [34, [21, 6, 8]],
    [35, [33, 17, 8]],
    [33, [17]],
    [37, [18, 8]],
    [36, [8]],
    [1, [8]],
    [14, [25, 6]],
    [11, [8]],
    [23, [8]]
  ];

  const pendingOcr = new Map();

  function normalize(text) {
    return String(text || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/ł/g, 'l')
      .replace(/[„”"'’`]/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }


  const CLASSIFIER_STOPWORDS = new Set(normalize(`
    szkolenie szkolenia szkoleniowe warsztaty warsztat praktyczne praktyczny praktyczna praktycznych
    kompendium wiedzy zakres zakresu zasady podstawy podstaw od podstaw wprowadzenie aktualne aktualny aktualnych
    dla oraz i lub w we z ze do na od po przy przez jako jak czy nad pod o a an the of to in
    dniowe dniowy dniowa dzień dni online certyfikowane certyfikowany kompleksowe kompleksowy
    realizacja realizacji praktyce omówienie najważniejsze możliwość możliwości uczestnik uczestnicy
    praca pracy zawodowej firma firmy instytucja instytucji organizacja organizacji
  `).split(' ').filter(Boolean));

  const STEM_SUFFIXES = [
    'owaniami','owaniach','owaniu','owania','owanie','owego','owych','owymi','owej','owym',
    'eniami','eniach','eniu','enia','enie','aniami','aniach','aniu','ania','anie',
    'acjami','acjach','acji','acje','acja','ycznych','ycznego','ycznej','ycznym','ycznymi',
    'alnych','alnego','alnej','alnym','alnymi','owych','owego','owej','owymi','owym',
    'ami','ach','owie','owego','emu','ego','ymi','ych','iej','owej','owa','owe','owy','nia','nie',
    'cie','cia','cji','cja','uje','ujacy','ujaca','ujace','ujacych','owym','owa','owe','owy',
    'om','em','ie','ia','iu','u','a','e','y','i'
  ].sort((a, b) => b.length - a.length);

  function stemToken(token) {
    let value = normalize(token).replace(/\s+/g, '');
    if (value.length <= 4) return value;
    for (const suffix of STEM_SUFFIXES) {
      if (value.endsWith(suffix) && value.length - suffix.length >= 5) {
        value = value.slice(0, -suffix.length);
        break;
      }
    }
    return value;
  }

  function classifierTokens(text) {
    return normalize(text)
      .split(' ')
      .filter((token) => token.length >= 3 && !CLASSIFIER_STOPWORDS.has(token))
      .map((token) => ({ raw: token, stem: stemToken(token) }))
      .filter((token) => token.stem.length >= 3);
  }

  function charNgrams(text, size = 3) {
    const value = ` ${normalize(text).replace(/\s+/g, ' ')} `;
    const result = new Set();
    if (value.length < size) return result;
    for (let i = 0; i <= value.length - size; i += 1) result.add(value.slice(i, i + size));
    return result;
  }

  function diceCoefficient(a, b) {
    const left = a instanceof Set ? a : charNgrams(a);
    const right = b instanceof Set ? b : charNgrams(b);
    if (!left.size || !right.size) return 0;
    let intersection = 0;
    for (const item of left) if (right.has(item)) intersection += 1;
    return (2 * intersection) / (left.size + right.size);
  }

  function tokenSimilarity(a, b) {
    const left = stemToken(a);
    const right = stemToken(b);
    if (!left || !right) return 0;
    if (left === right) return 1;
    const shorter = left.length <= right.length ? left : right;
    const longer = left.length > right.length ? left : right;
    if (shorter.length >= 5 && longer.startsWith(shorter)) return 0.94;
    if (left.length >= 6 && right.length >= 6 && left.slice(0, 6) === right.slice(0, 6)) return 0.90;
    const dice = diceCoefficient(new Set([...charNgrams(left, 2)]), new Set([...charNgrams(right, 2)]));
    return dice >= 0.72 ? Math.min(0.89, dice) : dice * 0.72;
  }

  function tokenCoverage(queryTokens, candidateTokens) {
    if (!queryTokens.length || !candidateTokens.length) return 0;
    let sum = 0;
    for (const query of queryTokens) {
      let best = 0;
      for (const candidate of candidateTokens) best = Math.max(best, tokenSimilarity(query.stem, candidate.stem));
      sum += best;
    }
    return sum / queryTokens.length;
  }

  function stemBigrams(tokens) {
    const result = new Set();
    for (let i = 0; i + 1 < tokens.length; i += 1) result.add(`${tokens[i].stem} ${tokens[i + 1].stem}`);
    return result;
  }

  function titleSimilarity(queryTitle, candidateTitle) {
    const queryTokens = classifierTokens(queryTitle);
    const candidateTokens = classifierTokens(candidateTitle);
    if (!queryTokens.length || !candidateTokens.length) return 0;
    const precision = tokenCoverage(queryTokens, candidateTokens);
    const recall = tokenCoverage(candidateTokens, queryTokens);
    const tokenF1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    const chars = diceCoefficient(charNgrams(queryTitle), charNgrams(candidateTitle));
    const qBigrams = stemBigrams(queryTokens);
    const cBigrams = stemBigrams(candidateTokens);
    let bigramOverlap = 0;
    if (qBigrams.size && cBigrams.size) {
      let matched = 0;
      for (const item of qBigrams) if (cBigrams.has(item)) matched += 1;
      bigramOverlap = matched / Math.min(qBigrams.size, cBigrams.size);
    }
    return Math.max(0, Math.min(1, (tokenF1 * 0.60) + (chars * 0.24) + (bigramOverlap * 0.16)));
  }

  function categoryById(id) {
    return CATEGORIES.find((category) => String(category.id) === String(id)) || null;
  }

  function categoryIdFromPublicLabel(text) {
    let value = normalize(text);
    value = value.replace(/^szkolenia\s+/, '').replace(/^szkolenie\s+/, '').trim();
    const exact = CATEGORIES.find((category) => normalize(category.name) === value);
    if (exact) return exact.id;
    const aliases = [
      ['audyt kontrola', 25], ['budownictwo', 11], ['administracja dla urzednikow', 6],
      ['ochrona srodowiska gosp odpadami', 17], ['komputerowe it ai sztuczna inteligencja', 29],
      ['kontrola zarzadcza finanse publ', 14], ['ksiegowosc rachunkowosc podatki', 12],
      ['negocjacje sprzedaz komunikacja', 5], ['windykacja naleznosci post egzekucyjne', 23],
      ['zarzadzanie menedzerskie', 2], ['zrownowazony rozwoj esg', 40],
      ['postepowanie administracyjne', 21], ['gospodarka odpadami', 33], ['prawo autorskie', 36],
      ['prawo energetyczne', 37], ['zamowienia publiczne', 1], ['zarzadzanie projektami', 3],
      ['gospodarka magazynowa', 41], ['sektor medyczny', 39], ['kompetencje cyfrowe', 43],
      ['autoprezentacja', 42], ['obsluga klienta', 10], ['tematyka unijna', 13], ['energetyka', 18],
      ['bezpieczenstwo', 22], ['nieruchomosci', 24], ['marketing', 20], ['hr kadry', 7], ['bdo', 35], ['kpa', 34]
    ];
    const hit = aliases.find(([alias]) => value === alias);
    return hit?.[1] || null;
  }

  function extractTrainingLinks(doc, baseUrl) {
    const links = new Map();
    for (const anchor of doc.querySelectorAll('a[href*="/component/trainings/details/szkolenie"]')) {
      const href = anchor.getAttribute('href') || '';
      let url;
      try { url = new URL(href, baseUrl).href; } catch (_) { continue; }
      const match = decodeURIComponent(url).match(/szkolenie(?:%2C|,)(\d+)/i) || url.match(/szkolenie%2C(\d+)/i);
      const id = match?.[1] || '';
      if (!id) continue;
      if (!links.has(id)) links.set(id, url);
    }
    return [...links.entries()].map(([id, url]) => ({ id, url }));
  }

  function extractTrainingExample(doc, url) {
    const h1 = doc.querySelector('h1');
    const title = cleanTitle(h1?.textContent || '');
    if (!title || title.length < 12) return null;
    const categories = new Set();
    if (h1) {
      const before = [...doc.querySelectorAll('a')]
        .filter((anchor) => Boolean(anchor.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING))
        .slice(-24);
      for (const anchor of before) {
        const id = categoryIdFromPublicLabel(anchor.textContent || '');
        if (id) categories.add(id);
      }
    }
    if (!categories.size) return null;
    const match = decodeURIComponent(url).match(/szkolenie(?:%2C|,)(\d+)/i) || url.match(/szkolenie%2C(\d+)/i);
    return { id: match?.[1] || normalize(title).slice(0, 60), title, categories: [...categories], url };
  }

  function buildKnowledgeProfiles(examples) {
    const perCategory = new Map();
    const termCategoryDf = new Map();
    const categoryIds = CATEGORIES.filter((category) => !category.additional).map((category) => category.id);

    for (const categoryId of categoryIds) perCategory.set(categoryId, new Map());
    for (const example of examples || []) {
      const tokens = classifierTokens(example.title);
      const terms = new Set(tokens.map((token) => token.stem).filter((term) => term.length >= 4));
      const bigrams = stemBigrams(tokens);
      const allTerms = new Set([...terms, ...[...bigrams].map((value) => `~${value}`)]);
      for (const categoryId of example.categories || []) {
        const bucket = perCategory.get(Number(categoryId));
        if (!bucket) continue;
        for (const term of allTerms) bucket.set(term, (bucket.get(term) || 0) + 1);
      }
    }

    for (const [categoryId, counts] of perCategory) {
      for (const term of counts.keys()) {
        if (!termCategoryDf.has(term)) termCategoryDf.set(term, new Set());
        termCategoryDf.get(term).add(categoryId);
      }
    }

    const profiles = {};
    const nCategories = Math.max(1, categoryIds.length);
    for (const [categoryId, counts] of perCategory) {
      const weighted = [];
      for (const [term, tf] of counts) {
        const df = termCategoryDf.get(term)?.size || 1;
        const idf = Math.log((nCategories + 1.5) / (df + 0.7));
        const weight = Math.log1p(tf) * Math.max(0.15, idf);
        if (weight > 0.24) weighted.push({ term, weight });
      }
      weighted.sort((a, b) => b.weight - a.weight);
      profiles[categoryId] = weighted.slice(0, 55);
    }
    return profiles;
  }

  async function loadLearnedExamples() {
    try {
      const all = await chrome.storage.local.get(null);
      learnedExamples = Object.entries(all)
        .filter(([key, value]) => key.startsWith(STORAGE_PREFIX) && value?.title && Array.isArray(value?.approvedCategoryIds) && value.approvedCategoryIds.length)
        .map(([key, value]) => ({
          id: key.slice(STORAGE_PREFIX.length),
          title: value.manualTitle || value.title || value.detectedTitle,
          categories: value.approvedCategoryIds.map(Number).filter(Boolean),
          source: 'user'
        }))
        .filter((item) => item.title && item.categories.length)
        .slice(-500);
    } catch (error) {
      console.warn('[SEMPER OCR] Nie udało się wczytać przykładów użytkownika.', error);
      learnedExamples = [];
    }
    return learnedExamples;
  }

  async function loadKnowledgeCache() {
    try {
      const data = await chrome.storage.local.get(KNOWLEDGE_CACHE_KEY);
      const cached = data[KNOWLEDGE_CACHE_KEY];
      if (cached && Array.isArray(cached.examples)) {
        classifierKnowledge = {
          examples: cached.examples.slice(0, KNOWLEDGE_MAX_EXAMPLES),
          profiles: cached.profiles || buildKnowledgeProfiles(cached.examples),
          updatedAt: Number(cached.updatedAt || 0),
          discoveredAt: Number(cached.discoveredAt || 0),
          pendingUrls: Array.isArray(cached.pendingUrls) ? cached.pendingUrls : []
        };
      }
    } catch (error) {
      console.warn('[SEMPER OCR] Nie udało się wczytać bazy wiedzy SEMPER.', error);
    }
  }

  async function persistKnowledgeCache() {
    classifierKnowledge.examples = classifierKnowledge.examples.slice(-KNOWLEDGE_MAX_EXAMPLES);
    classifierKnowledge.profiles = buildKnowledgeProfiles(classifierKnowledge.examples);
    await chrome.storage.local.set({ [KNOWLEDGE_CACHE_KEY]: classifierKnowledge });
  }

  async function discoverSemperTrainingUrls() {
    const discovered = new Map((classifierKnowledge.pendingUrls || []).map((item) => [String(item.id), item.url]));
    const known = new Set((classifierKnowledge.examples || []).map((item) => String(item.id)));
    const queue = SEMPER_DISCOVERY_URLS.map((path) => new URL(path, 'https://www.szkolenia-semper.pl').href);
    const workers = Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const url = queue.shift();
        try {
          const response = await fetch(url, { credentials: 'omit', cache: 'no-cache' });
          if (!response.ok) continue;
          const html = await response.text();
          const doc = new DOMParser().parseFromString(html, 'text/html');
          for (const item of extractTrainingLinks(doc, url)) {
            if (!known.has(String(item.id))) discovered.set(String(item.id), item.url);
          }
        } catch (error) {
          console.warn('[SEMPER OCR] Nie udało się odczytać publicznej strony oferty:', url, error);
        }
      }
    });
    await Promise.all(workers);
    classifierKnowledge.pendingUrls = [...discovered.entries()]
      .map(([id, url]) => ({ id, url }))
      .sort((a, b) => Number(b.id) - Number(a.id));
    classifierKnowledge.discoveredAt = Date.now();
  }

  async function syncSemperKnowledgeBase(force = false) {
    if (knowledgeSyncPromise) return knowledgeSyncPromise;
    knowledgeSyncPromise = (async () => {
      const now = Date.now();
      if (force || !classifierKnowledge.discoveredAt || now - classifierKnowledge.discoveredAt > KNOWLEDGE_DISCOVERY_TTL || !(classifierKnowledge.pendingUrls || []).length) {
        await discoverSemperTrainingUrls();
        await persistKnowledgeCache();
      }

      const existing = new Map((classifierKnowledge.examples || []).map((item) => [String(item.id), item]));
      const pending = [...(classifierKnowledge.pendingUrls || [])];
      const batch = pending.splice(0, KNOWLEDGE_DETAILS_PER_SESSION);
      let processed = 0;

      await processWithLimit(batch, 3, async (item) => {
        try {
          const response = await fetch(item.url, { credentials: 'omit', cache: 'no-cache' });
          if (!response.ok) return;
          const html = await response.text();
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const example = extractTrainingExample(doc, item.url);
          if (example) existing.set(String(example.id), example);
        } catch (error) {
          console.warn('[SEMPER OCR] Nie udało się zindeksować szkolenia SEMPER:', item.url, error);
        } finally {
          processed += 1;
          if (processed % 12 === 0) await sleep(80);
        }
      });

      classifierKnowledge.examples = [...existing.values()]
        .sort((a, b) => Number(a.id || 0) - Number(b.id || 0))
        .slice(-KNOWLEDGE_MAX_EXAMPLES);
      classifierKnowledge.pendingUrls = pending;
      classifierKnowledge.updatedAt = Date.now();
      await persistKnowledgeCache();
      window.dispatchEvent(new CustomEvent('semper-classifier-knowledge-updated', {
        detail: { count: classifierKnowledge.examples.length, pending: classifierKnowledge.pendingUrls.length }
      }));
      return classifierKnowledge;
    })().finally(() => { knowledgeSyncPromise = null; });
    return knowledgeSyncPromise;
  }

  async function initializeClassifier() {
    if (classifierInitPromise) return classifierInitPromise;
    classifierInitPromise = (async () => {
      await Promise.all([loadKnowledgeCache(), loadLearnedExamples()]);
      const stale = !classifierKnowledge.updatedAt || Date.now() - classifierKnowledge.updatedAt > KNOWLEDGE_CACHE_TTL;
      // Synchronizacja jest celowo nieblokująca. OCR działa od razu na modelu morfologicznym,
      // a publiczny korpus SEMPER wzmacnia wyniki w miarę indeksowania.
      if (stale || classifierKnowledge.pendingUrls?.length) syncSemperKnowledgeBase(false).catch((error) => console.warn('[SEMPER OCR] Synchronizacja bazy SEMPER nie powiodła się.', error));
      return classifierKnowledge;
    })();
    return classifierInitPromise;
  }

  function publicExampleScores(title) {
    const support = new Map();
    const bestExamples = [];
    for (const example of classifierKnowledge.examples || []) {
      const similarity = titleSimilarity(title, example.title);
      if (similarity < 0.29) continue;
      bestExamples.push({ ...example, similarity });
    }
    bestExamples.sort((a, b) => b.similarity - a.similarity);
    for (const example of bestExamples.slice(0, 12)) {
      for (const categoryId of example.categories || []) {
        if (!support.has(Number(categoryId))) support.set(Number(categoryId), []);
        support.get(Number(categoryId)).push(example.similarity);
      }
    }
    const scores = new Map();
    for (const [categoryId, similarities] of support) {
      similarities.sort((a, b) => b - a);
      const best = similarities[0] || 0;
      const avg = similarities.slice(0, 4).reduce((sum, value) => sum + value, 0) / Math.min(4, similarities.length);
      const score = Math.max(0, Math.min(100, ((best * 0.72) + (avg * 0.28)) * 100));
      scores.set(categoryId, score);
    }
    return { scores, examples: bestExamples.slice(0, 5) };
  }

  function learnedExampleScores(title) {
    const support = new Map();
    const bestExamples = [];
    for (const example of learnedExamples || []) {
      const similarity = titleSimilarity(title, example.title);
      if (similarity < 0.30) continue;
      bestExamples.push({ ...example, similarity });
      for (const categoryId of example.categories || []) {
        const current = support.get(Number(categoryId)) || 0;
        support.set(Number(categoryId), Math.max(current, similarity));
      }
    }
    const scores = new Map();
    for (const [categoryId, similarity] of support) {
      const calibrated = similarity <= 0.30 ? 0 : Math.min(100, ((similarity - 0.30) / 0.70) * 100);
      scores.set(categoryId, calibrated);
    }
    bestExamples.sort((a, b) => b.similarity - a.similarity);
    return { scores, examples: bestExamples.slice(0, 4) };
  }

  function anchorMatchScore(category, title, ocrText = '') {
    const titleTokens = classifierTokens(title);
    const contextTokens = classifierTokens(`${title} ${String(ocrText || '').slice(0, 1800)}`);
    const titleNorm = normalize(title);
    const contextNorm = normalize(`${title} ${String(ocrText || '').slice(0, 1800)}`);
    let evidence = 0;
    const hits = [];

    for (const anchor of category.anchors || []) {
      const anchorNorm = normalize(anchor);
      const anchorTokens = classifierTokens(anchor);
      if (!anchorTokens.length) continue;
      let titleMatch = 0;
      for (const token of anchorTokens) {
        let best = 0;
        for (const query of titleTokens) best = Math.max(best, tokenSimilarity(token.stem, query.stem));
        titleMatch += best;
      }
      titleMatch /= anchorTokens.length;
      let contextMatch = 0;
      if (titleMatch < 0.75) {
        for (const token of anchorTokens) {
          let best = 0;
          for (const query of contextTokens) best = Math.max(best, tokenSimilarity(token.stem, query.stem));
          contextMatch += best;
        }
        contextMatch /= anchorTokens.length;
      }
      const exact = titleNorm.includes(anchorNorm) ? 1 : contextNorm.includes(anchorNorm) ? 0.88 : 0;
      const match = Math.max(exact, titleMatch, contextMatch * 0.55);
      if (match >= 0.72) {
        evidence += Math.pow(match, 2) * (anchorTokens.length > 1 ? 1.25 : 0.88);
        if (hits.length < 5) hits.push(anchor);
      }
    }

    const markerHits = [];
    for (const marker of STRONG_MARKERS.get(category.id) || []) {
      const markerNorm = normalize(marker);
      const tokenyMarkera = classifierTokens(marker);
      const dopasowanieOdmiany = tokenyMarkera.length >= 2 && tokenyMarkera.every((tokenMarkera) =>
        titleTokens.some((tokenTytulu) => tokenSimilarity(tokenMarkera.stem, tokenTytulu.stem) >= 0.90)
      );
      if (titleNorm.includes(markerNorm) || contextNorm.includes(markerNorm) || dopasowanieOdmiany) markerHits.push(marker);
    }
    let score = 100 * (1 - Math.exp(-evidence / 2.25));
    if (markerHits.length) score = Math.max(score, Math.min(100, 82 + (markerHits.length - 1) * 7));
    return { score: Math.min(100, score), hits: [...new Set([...markerHits, ...hits])].slice(0, 7) };
  }

  function profileScore(categoryId, title) {
    const profile = classifierKnowledge.profiles?.[categoryId] || [];
    if (!profile.length) return 0;
    const tokens = classifierTokens(title);
    const tokenStems = tokens.map((token) => token.stem);
    const bigrams = stemBigrams(tokens);
    let matched = 0;
    let matches = 0;
    for (const item of profile.slice(0, 45)) {
      let similarity = 0;
      if (item.term.startsWith('~')) {
        similarity = bigrams.has(item.term.slice(1)) ? 1 : 0;
      } else {
        for (const stem of tokenStems) similarity = Math.max(similarity, tokenSimilarity(item.term, stem));
      }
      if (similarity >= 0.82) {
        matched += item.weight * similarity;
        matches += 1;
      }
    }
    if (!matches) return 0;
    return Math.min(100, 100 * (1 - Math.exp(-matched / 4.4)));
  }

  function applyCategoryPriorities(results) {
    const byId = new Map(results.map((item) => [item.id, item]));
    for (const [strongId, weakerIds] of CATEGORY_PRIORITY) {
      const strong = byId.get(strongId);
      if (!strong || strong.score < 55) continue;
      for (const weakId of weakerIds) {
        const weak = byId.get(weakId);
        if (!weak || weak.score <= 0) continue;
        if (strong.score >= weak.score * 0.78) weak.score = Math.round(weak.score * 0.84);
      }
    }
  }

  function titleContainsLawMorphology(title) {
    const tokens = normalize(title).split(' ').filter(Boolean);
    // Świadomie nie używamy samego prefiksu „praw”, żeby nie łapać słów
    // takich jak „prawidłowy”. Obejmuje natomiast praktycznie wszystkie
    // odmiany: prawo, prawa, prawem, prawie, prawny/prawne/prawnych,
    // prawnie, prawniczy itd.
    return tokens.some((token) => /^(?:praw|prawo|prawa|prawem|prawie|prawu|prawn\w*|prawnic\w*)$/.test(token));
  }

  function titleContainsAdministrativeMorphology(title) {
    const tokens = normalize(title).split(' ').filter(Boolean);
    return tokens.some((token) => /^(?:administrac\w*|urzednik\w*|urzednic\w*|urzad|urzedu|urzedzie|urzedy|urzedach|urzedami|urzedow\w*)$/.test(token));
  }

  function tytulZawieraOdmianeWarsztatu(title) {
    return normalize(title).split(' ').some((token) => /^warsztat\w*$/.test(token));
  }

  function zastosujJednoznaczneDopasowaniaNazwKategorii(results, title) {
    const tokenyTytulu = classifierTokens(title);
    if (!tokenyTytulu.length) return;

    for (const wynik of results) {
      const dopasowanyFragment = String(wynik.name || '')
        .split('/')
        .map((fragment) => fragment.trim())
        .find((fragment) => {
          const tokenyKategorii = classifierTokens(fragment);
          return tokenyKategorii.length >= 2 && tokenyKategorii.every((tokenKategorii) =>
            tokenyTytulu.some((tokenTytulu) => tokenSimilarity(tokenKategorii.stem, tokenTytulu.stem) >= 0.90)
          );
        });

      if (!dopasowanyFragment) continue;
      const pelnaNazwaWTytule = normalize(title).includes(normalize(dopasowanyFragment));
      wynik.score = Math.max(wynik.score, pelnaNazwaWTytule ? 96 : 84);
      wynik.hits = [...new Set([
        ...(wynik.hits || []),
        `${pelnaNazwaWTytule ? 'pełna nazwa' : 'nazwa'} kategorii: ${dopasowanyFragment}`
      ])];
    }
  }

  function zastosujReguleWarsztatowBiznesowych(results, title) {
    if (!tytulZawieraOdmianeWarsztatu(title)) return;
    const warsztatyBiznesowe = results.find((item) => item.id === 9);
    if (!warsztatyBiznesowe) return;
    warsztatyBiznesowe.score = Math.max(warsztatyBiznesowe.score, 76);
    warsztatyBiznesowe.hits = [...new Set([...(warsztatyBiznesowe.hits || []), 'odmiana słowa „warsztat” w tytule'])];
  }

  function applyLegalCombinationRules(results, title) {
    const byId = new Map(results.map((item) => [item.id, item]));
    const law = byId.get(8);
    const construction = byId.get(11);
    const energy = byId.get(18);
    const energyLaw = byId.get(37);
    const copyrightLaw = byId.get(36);
    const procurement = byId.get(1);
    const normalizedTitle = normalize(title);
    const hasLawWord = titleContainsLawMorphology(title);
    const derivedSuggestions = [];

    const addHit = (item, hit) => {
      if (!item) return;
      item.hits = [...new Set([...(item.hits || []), hit])];
    };

    // Jeżeli tytuł jawnie mówi o prawie / prawnych / prawnie itd., kategoria
    // „prawo” zawsze ma być widocznym, możliwym do zaznaczenia kandydatem.
    if (hasLawWord && law) {
      law.score = Math.max(law.score, 72);
      addHit(law, 'odmiana słowa „prawo” w tytule');
    }

    const constructionContext = Boolean(construction && (construction.score >= 45 || /\bbudowlan\w*\b/.test(normalizedTitle)));
    if (hasLawWord && constructionContext && law && construction) {
      law.score = Math.max(law.score, 74);
      construction.score = Math.max(construction.score, 78);
      addHit(law, 'reguła łączona: prawo budowlane');
      addHit(construction, 'reguła łączona: prawo budowlane');
      derivedSuggestions.push({
        name: 'prawo budowlane',
        score: Math.max(law.score, construction.score),
        categoryIds: [11, 8],
        note: 'W Wavepanelu odpowiada zestawowi: budownictwo + prawo.'
      });
    }

    const energyContext = Boolean(energy && (energy.score >= 45 || /\b(?:energetycz\w*|energetyk\w*|energia|oze)\b/.test(normalizedTitle)));
    if (hasLawWord && energyContext && energyLaw) {
      energyLaw.score = Math.max(energyLaw.score, 86, Math.round(((law?.score || 72) + (energy?.score || 55)) / 2 + 10));
      addHit(energyLaw, 'reguła łączona: prawo + energetyka');
    }

    if (hasLawWord && copyrightLaw && (/\bautorsk\w*\b/.test(normalizedTitle) || copyrightLaw.score >= 45)) {
      copyrightLaw.score = Math.max(copyrightLaw.score, 86);
      addHit(copyrightLaw, 'reguła łączona: prawo autorskie');
    }

    if (hasLawWord && procurement && (/\b(?:zamowien\w* publiczn\w*|pzp|kio|swz)\b/.test(normalizedTitle) || procurement.score >= 55)) {
      procurement.score = Math.max(procurement.score, 86);
      addHit(procurement, 'reguła łączona: prawo zamówień publicznych');
    }

    return derivedSuggestions;
  }

  function applyAdministrativeMorphologyRule(results, title) {
    if (!titleContainsAdministrativeMorphology(title)) return;
    const administration = results.find((item) => item.id === 6);
    if (!administration) return;
    administration.score = Math.max(administration.score, 76);
    administration.hits = [...new Set([...(administration.hits || []), 'odmiana słowa „administracja/urzędnik” w tytule'])];
  }

  function knowledgeSummary() {
    const publicCount = classifierKnowledge.examples?.length || 0;
    const userCount = learnedExamples?.length || 0;
    const pending = classifierKnowledge.pendingUrls?.length || 0;
    return { publicCount, userCount, pending };
  }

  function cleanOcr(text) {
    return String(text || '')
      .replace(/\r/g, '\n')
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  function cleanTitle(text) {
    return String(text || '')
      .replace(/[„”"]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^[\s:;,.–—-]+/, '')
      .replace(/[\s:;,.–—-]+$/, '')
      .trim()
      .slice(0, 320);
  }

  const POLISH_MONTHS = new Map([
    ['stycznia', 1], ['styczen', 1], ['styczeń', 1],
    ['lutego', 2], ['luty', 2],
    ['marca', 3], ['marzec', 3],
    ['kwietnia', 4], ['kwiecien', 4], ['kwiecień', 4],
    ['maja', 5], ['maj', 5],
    ['czerwca', 6], ['czerwiec', 6],
    ['lipca', 7], ['lipiec', 7],
    ['sierpnia', 8], ['sierpien', 8], ['sierpień', 8],
    ['września', 9], ['wrzesnia', 9], ['wrzesień', 9], ['wrzesien', 9],
    ['pazdziernika', 10], ['października', 10], ['pazdziernik', 10], ['październik', 10],
    ['listopada', 11], ['listopad', 11],
    ['grudnia', 12], ['grudzien', 12], ['grudzień', 12]
  ]);

  const WZOR_POLSKIEGO_MIESIACA = [...POLISH_MONTHS.keys()].join('|');

  function makeIsoDate(day, month, year) {
    const d = Number(day);
    const m = Number(month);
    const y = Number(year);
    if (!Number.isInteger(d) || !Number.isInteger(m) || !Number.isInteger(y) || y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return '';
    const check = new Date(Date.UTC(y, m - 1, d));
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return '';
    return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  function formatIssueDate(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? `${match[3]}.${match[2]}.${match[1]}` : '';
  }

  function collectDateCandidates(ocrText) {
    const text = cleanOcr(ocrText);
    if (!text) return [];
    const lines = text.split('\n');
    const candidates = [];
    let absoluteOffset = 0;

    const addCandidate = (lineIndex, lineOffset, matchIndex, raw, iso) => {
      if (!iso) return;
      const line = lines[lineIndex] || '';
      const folded = normalize(line);
      const before = line.slice(0, Math.max(0, matchIndex));
      let score = 42;

      // Data wystawienia zwykle znajduje się w nagłówku i jest poprzedzona miejscowością.
      if (lineIndex <= 4) score += 28;
      else if (lineIndex <= 9) score += 20;
      else if (lineIndex <= 16) score += 10;
      else if (lineIndex > Math.max(20, Math.round(lines.length * 0.55))) score -= 8;

      if (/[,;]\s*$/.test(before) || /[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]{3,}\s*,\s*$/.test(before)) score += 18;
      if (/\b(?:dnia|dn\.)\b/i.test(before)) score += 5;

      // Daty realizacji szkolenia są częste w treści referencji i nie są datą wystawienia.
      if (/\b(?:w dniach|termin|terminie|realizac|szkolen|uslug|zrealiz|uczestnic|odbyl|odbyło|odbylo)\b/.test(folded)) score -= 34;
      if (/\b(?:od|do)\s+\d{1,2}/.test(folded)) score -= 16;
      if (/\d{1,2}\s*[-–—]\s*\d{1,2}[.\/-]/.test(line)) score -= 36;
      if (/\b\d{1,2}\s*[-–—]\s*\d{1,2}\s+[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]+\s+20\d{2}\b/.test(line)) score -= 36;

      const rawText = String(raw || '').trim();
      const start = lineOffset + Math.max(0, matchIndex);
      const end = start + String(raw || '').length;
      candidates.push({ iso, raw: rawText, lineIndex, score, start, end });
    };

    lines.forEach((line, lineIndex) => {
      const lineOffset = absoluteOffset;
      const numeric = /\b(\d{1,2})[.\/-](\d{1,2})[.\/-](20\d{2})(?:\s*r\.?\b)?/g;
      for (const match of line.matchAll(numeric)) {
        addCandidate(lineIndex, lineOffset, match.index || 0, match[0], makeIsoDate(match[1], match[2], match[3]));
      }

      const formatRokMiesiacDzien = /\b(20\d{2})-(\d{1,2})-(\d{1,2})(?:\s*r\.?\b)?/g;
      for (const match of line.matchAll(formatRokMiesiacDzien)) {
        addCandidate(lineIndex, lineOffset, match.index || 0, match[0], makeIsoDate(match[3], match[2], match[1]));
      }

      const words = new RegExp(`\\b(\\d{1,2})\\s+(${WZOR_POLSKIEGO_MIESIACA})\\s+(20\\d{2})(?:\\s*r\\.?\\b)?`, 'gi');
      for (const match of line.matchAll(words)) {
        const month = POLISH_MONTHS.get(String(match[2] || '').toLowerCase());
        addCandidate(lineIndex, lineOffset, match.index || 0, match[0], makeIsoDate(match[1], month, match[3]));
      }
      absoluteOffset += line.length + 1;
    });

    // Ta sama data potrafi zostać złapana kilkoma bardzo podobnymi wzorcami.
    const unique = new Map();
    for (const candidate of candidates) {
      const key = `${candidate.start}:${candidate.end}:${candidate.iso}`;
      const previous = unique.get(key);
      if (!previous || candidate.score > previous.score) unique.set(key, candidate);
    }
    return [...unique.values()].sort((a, b) => b.score - a.score || a.lineIndex - b.lineIndex || a.start - b.start);
  }

  function extractIssueDate(ocrText) {
    const candidates = collectDateCandidates(ocrText);
    if (!candidates.length) return null;
    const best = candidates[0];
    if (best.score < 50) return null;
    return {
      iso: best.iso,
      raw: best.raw,
      confidence: Math.max(35, Math.min(98, Math.round(best.score))),
      candidates: candidates.slice(0, 8)
    };
  }

  function parseSelectedIssueDate(text) {
    const candidates = collectDateCandidates(text);
    if (!candidates.length) return null;
    const best = candidates[0];
    return {
      iso: best.iso,
      raw: best.raw,
      confidence: 100
    };
  }

  function normalizeWithSourceMap(text) {
    const source = String(text || '');
    let normalized = '';
    const map = [];
    let pendingSpace = false;
    let pendingSpaceIndex = 0;

    for (let i = 0; i < source.length; i += 1) {
      const folded = source[i]
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
      const chars = folded.match(/[a-z0-9]/g) || [];

      if (chars.length) {
        if (pendingSpace && normalized.length) {
          normalized += ' ';
          map.push(pendingSpaceIndex);
        }
        for (const ch of chars) {
          normalized += ch;
          map.push(i);
        }
        pendingSpace = false;
      } else if (normalized.length && !pendingSpace) {
        pendingSpace = true;
        pendingSpaceIndex = i;
      }
    }

    return { normalized, map };
  }

  function findTitleSpanInOcr(ocrText, title) {
    const source = String(ocrText || '');
    const target = normalize(title);
    if (!source || !target || target.length < 8) return null;

    const mapped = normalizeWithSourceMap(source);
    const startNormalized = mapped.normalized.indexOf(target);
    if (startNormalized < 0) return null;

    const endNormalized = startNormalized + target.length - 1;
    const start = mapped.map[startNormalized];
    const end = (mapped.map[endNormalized] ?? start) + 1;
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return null;
    return { start, end };
  }

  function getEditableOcrText(element) {
    if (!element) return '';
    return cleanOcr(element.innerText || element.textContent || '');
  }

  function findQuotedSpans(text) {
    const source = String(text || '');
    const spans = [];
    // OCR bywa niespójny: polski „ może zostać zamknięty przez ” albo zwykły znak ".
    const pattern = /[„“"]([^„“”"]{4,800})[”"]/gs;
    for (const match of source.matchAll(pattern)) {
      if (!Number.isInteger(match.index) || !match[1]) continue;
      const start = match.index + 1;
      const end = start + match[1].length;
      if (end > start) spans.push({ start, end, type: 'quote', priority: 1 });
    }
    return spans;
  }

  function highlightClass(type) {
    if (type === 'manual') return 'semper-ocr-manual-title-highlight';
    if (type === 'auto') return 'semper-ocr-auto-title-highlight';
    if (type === 'issue-date') return 'semper-ocr-issue-date-highlight';
    if (type === 'date') return 'semper-ocr-date-highlight';
    return 'semper-ocr-quote-highlight';
  }

  function findIssueDateSpanInOcr(source, issueDateInfo = {}) {
    const candidates = collectDateCandidates(source);
    if (!candidates.length) return null;
    const wantedIso = String(issueDateInfo?.iso || issueDateInfo?.issueDate || '').trim();
    const wantedRaw = normalize(issueDateInfo?.raw || issueDateInfo?.issueDateRaw || '');
    const matching = candidates.filter((candidate) => {
      if (wantedRaw && normalize(candidate.raw) === wantedRaw) return true;
      return Boolean(wantedIso && candidate.iso === wantedIso);
    });
    return (matching.length ? matching : []).sort((a, b) => b.score - a.score || a.start - b.start)[0] || null;
  }

  function renderOcrWithHighlights(element, text, detectedTitle, manualTitle = '', issueDateInfo = {}, autoScroll = true) {
    const source = String(text || '');
    element.textContent = '';

    const ranges = findQuotedSpans(source);
    for (const date of collectDateCandidates(source)) {
      ranges.push({ start: date.start, end: date.end, type: 'date', priority: 2, iso: date.iso });
    }

    const issueDateSpan = findIssueDateSpanInOcr(source, issueDateInfo);
    if (issueDateSpan) ranges.push({ ...issueDateSpan, type: 'issue-date', priority: 3 });

    const detectedSpan = findTitleSpanInOcr(source, detectedTitle);
    if (detectedSpan) ranges.push({ ...detectedSpan, type: 'auto', priority: 4 });

    const hasManualApproval = Boolean(cleanTitle(manualTitle));
    let manualSpan = null;
    if (hasManualApproval) {
      // Ręcznie zatwierdzony tytuł ma najwyższy priorytet kolorystyczny, nawet
      // gdy jest identyczny z automatycznie rozpoznanym tytułem.
      manualSpan = findTitleSpanInOcr(source, manualTitle) || detectedSpan;
      if (manualSpan) ranges.push({ ...manualSpan, type: 'manual', priority: 5 });
    }

    if (!ranges.length) {
      element.appendChild(document.createTextNode(source));
      element.dataset.titleHighlighted = '0';
      return;
    }

    const boundaries = new Set([0, source.length]);
    for (const range of ranges) {
      boundaries.add(Math.max(0, Math.min(source.length, range.start)));
      boundaries.add(Math.max(0, Math.min(source.length, range.end)));
    }
    const points = [...boundaries].sort((a, b) => a - b);
    let scrollTarget = null;

    for (let i = 0; i < points.length - 1; i += 1) {
      const segmentStart = points[i];
      const segmentEnd = points[i + 1];
      if (segmentEnd <= segmentStart) continue;

      const covering = ranges
        .filter((range) => range.start <= segmentStart && range.end >= segmentEnd)
        .sort((a, b) => b.priority - a.priority)[0];
      const segmentText = source.slice(segmentStart, segmentEnd);

      if (!covering) {
        element.appendChild(document.createTextNode(segmentText));
        continue;
      }

      const mark = document.createElement('mark');
      mark.className = highlightClass(covering.type);
      mark.dataset.highlightType = covering.type;
      if (covering.type === 'manual' || (!hasManualApproval && covering.type === 'auto')) {
        mark.dataset.role = 'current-title';
        if (!scrollTarget) scrollTarget = mark;
      } else if (!scrollTarget && covering.type === 'issue-date') {
        scrollTarget = mark;
      }
      mark.textContent = segmentText;
      element.appendChild(mark);
    }

    element.dataset.titleHighlighted = detectedSpan || manualSpan ? '1' : '0';
    if (autoScroll && scrollTarget) {
      requestAnimationFrame(() => {
        const top = Math.max(0, scrollTarget.offsetTop - Math.round(element.clientHeight * 0.28));
        element.scrollTop = top;
      });
    }
  }

  function getIdFromText(text) {
    const value = String(text || '').replace(/&amp;/g, '&');
    const patterns = [
      /ref_kat\.php\?[^"'<>\s)]*id=(\d+)/i,
      /ref_adm\.php\?[^"'<>\s)]*id=(\d+)/i,
      /[?&]id=(\d+)/i
    ];
    for (const pattern of patterns) {
      const match = value.match(pattern);
      if (match?.[1]) return match[1];
    }
    return '';
  }

  function getCurrentId() {
    return new URLSearchParams(location.search).get('id') || getIdFromText(document.referrer) || '';
  }

  function getIdFromRow(row) {
    for (const element of row.querySelectorAll('a,button,input,form,[href],[onclick],[action],[data-id],[data-ref-id]')) {
      for (const attr of ['href', 'onclick', 'action', 'value', 'data-id', 'data-ref-id']) {
        const id = getIdFromText(element.getAttribute?.(attr));
        if (id) return id;
      }
    }
    return getIdFromText(row.innerHTML);
  }

  function storageKey(id) { return `${STORAGE_PREFIX}${id}`; }
  function categoryCacheKey(id) { return `${CATEGORY_CACHE_PREFIX}${id}`; }

  async function getRecord(id) {
    if (!id) return null;
    const key = storageKey(id);
    const data = await chrome.storage.local.get(key);
    return data[key] || null;
  }

  async function saveRecord(id, record) {
    if (!id) return;
    await chrome.storage.local.set({ [storageKey(id)]: { ...record, id, updatedAt: Date.now() } });
  }

  function findImageUrlInDocument(doc, baseUrl = location.href) {
    const selectors = [
      'img[src*="/__template/img/upload/"]',
      'a[href*="/__template/img/upload/"]',
      'input[value*="/__template/img/upload/"]',
      'textarea'
    ];
    for (const selector of selectors) {
      for (const el of doc.querySelectorAll(selector)) {
        for (const attr of ['src', 'href', 'value']) {
          const raw = el.getAttribute?.(attr) || '';
          if (raw.includes('/__template/img/upload/')) {
            try { return new URL(raw, baseUrl).href; } catch (_) { /* ignore */ }
          }
        }
        const text = el.value || el.textContent || '';
        const match = text.match(/https?:\/\/[^\s"'<>]+\/__template\/img\/upload\/[^\s"'<>]+/i)
          || text.match(/\/__template\/img\/upload\/[^\s"'<>]+/i);
        if (match) {
          try { return new URL(match[0], baseUrl).href; } catch (_) { /* ignore */ }
        }
      }
    }
    const html = doc.documentElement?.innerHTML || '';
    const match = html.match(/https?:\/\/[^\s"'<>]+\/__template\/img\/upload\/[^\s"'<>]+/i)
      || html.match(/\/__template\/img\/upload\/[^\s"'<>]+/i);
    if (!match) return '';
    try { return new URL(match[0].replace(/&amp;/g, '&'), baseUrl).href; } catch (_) { return ''; }
  }

  function normalizeReferencePageUrl(raw, baseUrl = location.href) {
    const value = String(raw || '')
      .replace(/&amp;/g, '&')
      .replace(/\\\//g, '/')
      .trim();
    if (!value) return '';
    try { return new URL(value, baseUrl).href; } catch (_) { return ''; }
  }

  function findReferenceEditUrlInRow(row, id) {
    if (!row || !id) return '';
    const idText = String(id);
    const attrs = ['href', 'onclick', 'action', 'data-href', 'data-url', 'value'];
    const elements = [row, ...row.querySelectorAll('a,button,input,form,[href],[onclick],[action],[data-href],[data-url]')];
    const candidates = [];

    for (const element of elements) {
      for (const attr of attrs) {
        const raw = element.getAttribute?.(attr) || '';
        if (!raw || !/ref_adm\.php/i.test(raw)) continue;
        const match = raw.match(/(?:https?:\/\/[^\s"'<>]+)?(?:\/wavepanel\/)?ref_adm\.php\?[^"'<>\s)]+/i);
        const normalized = normalizeReferencePageUrl(match?.[0] || raw);
        if (!normalized) continue;
        try {
          const u = new URL(normalized);
          if (u.pathname.endsWith('/wavepanel/ref_adm.php') && u.searchParams.get('id') === idText) {
            candidates.push(normalized);
          }
        } catch (_) { /* ignore */ }
      }
    }

    return candidates.find((url) => {
      try { return new URL(url).searchParams.get('opc') === 'edit'; } catch (_) { return false; }
    }) || candidates[0] || '';
  }

  function findReferenceEditUrlsInDocument(doc, baseUrl, id) {
    const found = [];
    const seen = new Set();
    const idText = String(id || '');
    for (const element of doc.querySelectorAll('a[href],form[action],[onclick],[data-href],[data-url]')) {
      for (const attr of ['href', 'action', 'onclick', 'data-href', 'data-url']) {
        const raw = element.getAttribute?.(attr) || '';
        if (!raw || !/ref_adm\.php/i.test(raw)) continue;
        const match = raw.match(/(?:https?:\/\/[^\s"'<>]+)?(?:\/wavepanel\/)?ref_adm\.php\?[^"'<>\s)]+/i);
        const normalized = normalizeReferencePageUrl(match?.[0] || raw, baseUrl);
        if (!normalized || seen.has(normalized)) continue;
        try {
          const u = new URL(normalized);
          if (!u.pathname.endsWith('/wavepanel/ref_adm.php')) continue;
          if (idText && u.searchParams.get('id') !== idText) continue;
          seen.add(normalized);
          found.push(normalized);
        } catch (_) { /* ignore */ }
      }
    }
    found.sort((a, b) => {
      const ae = new URL(a).searchParams.get('opc') === 'edit' ? 0 : 1;
      const be = new URL(b).searchParams.get('opc') === 'edit' ? 0 : 1;
      return ae - be;
    });
    return found;
  }

  async function fetchImageUrlForReference(id, preferredEditUrl = '') {
    const encodedId = encodeURIComponent(id);
    const queue = [
      preferredEditUrl,
      `https://www.szkolenia-semper.pl/wavepanel/ref_adm.php?id=${encodedId}&opc=edit`,
      `https://www.szkolenia-semper.pl/wavepanel/ref_adm.php?opc=edit&id=${encodedId}`,
      `https://www.szkolenia-semper.pl/wavepanel/ref_adm.php?id=${encodedId}`,
      `https://www.szkolenia-semper.pl/wavepanel/ref_kat.php?id=${encodedId}`
    ].filter(Boolean);
    const visited = new Set();
    const attempted = [];

    while (queue.length) {
      const url = normalizeReferencePageUrl(queue.shift());
      if (!url || visited.has(url)) continue;
      visited.add(url);
      attempted.push(url);
      try {
        const response = await fetch(url, { credentials: 'include', cache: 'no-cache', redirect: 'follow' });
        if (!response.ok) {
          console.warn('[SEMPER OCR] Strona referencji zwróciła HTTP', response.status, { id, url });
          continue;
        }
        const html = await response.text();
        const effectiveUrl = response.url || url;
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const imageUrl = findImageUrlInDocument(doc, effectiveUrl);
        if (imageUrl) {
          console.debug('[SEMPER OCR] Znaleziono obraz referencji', { id, pageUrl: effectiveUrl, imageUrl });
          return imageUrl;
        }

        // Część widoków Wavepanelu nie zawiera obrazu, ale zawiera link do właściwej
        // strony edycji. Dodajemy takie linki do kolejki i próbujemy dalej.
        for (const editUrl of findReferenceEditUrlsInDocument(doc, effectiveUrl, id)) {
          if (!visited.has(editUrl)) queue.push(editUrl);
        }
      } catch (error) {
        console.warn('[SEMPER OCR] Nie udało się pobrać strony referencji', { id, url, error });
      }
    }

    console.warn('[SEMPER OCR] Nie znaleziono pliku graficznego referencji.', { id, attempted });
    return '';
  }

  function scoreTitleCandidate(text, baseScore, source, candidates) {
    const title = cleanTitle(text);
    if (title.length < 12 || title.length > 320) return;
    const n = normalize(title);
    if (!n || /^(referencje|referencja|zaswiadczenie|certyfikat|podziekowanie)$/.test(n)) return;
    if (/^(uniwersytet|urzad|firma|centrum organizacji|z powazaniem|niniejszym)/.test(n) && title.length < 80) return;

    let score = baseScore;
    if (title.length >= 25 && title.length <= 190) score += 15;
    if (title.length >= 40 && title.length <= 150) score += 7;
    if (/\b(ustaw|prawo|zasad|postepowan|kwalifikac|zarzadz|obslug|zamowien|podat|kadry|energet|odpadow|nieruchom|cyber|excel|komunikac)/i.test(n)) score += 8;
    if (/\b(radom|poznan|warszaw|telefon|www|ulica|ul\b|nip|regon|data|dnia|stycznia|lutego|marca|kwietnia|maja|czerwca|lipca|sierpnia|wrzesnia|pazdziernika|listopada|grudnia)\b/i.test(n)) score -= 18;
    candidates.push({ title, score, source });
  }

  function extractTitle(ocrText, ocrConfidence = 0) {
    const text = cleanOcr(ocrText);
    const lines = text.split('\n').map(cleanTitle).filter(Boolean);
    const candidates = [];

    const marker = /\b(?:szkoleni\w*|warsztat\w*|seminari\w*|webinari\w*)\b.*?\b(?:pt\.?|pn\.?|pod\s+nazwa|pod\s+tytulem|o\s+nazwie|o\s+temacie|z\s+zakresu)\b\s*[:\-–]?\s*(.*)$/i;
    const simpleMarker = /\b(?:temat\s+szkolenia|nazwa\s+szkolenia)\b\s*[:\-–]\s*(.*)$/i;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const m = line.match(marker) || line.match(simpleMarker);
      if (m) {
        const chunks = [];
        if (m[1]) chunks.push(m[1]);
        for (let j = i + 1; j < Math.min(lines.length, i + 4); j += 1) {
          const next = lines[j];
          if (/^(szkolenie|trener|termin|data|miejsce|organizator|z powazaniem|uczestnicy|uczestnik)/i.test(normalize(next))) break;
          chunks.push(next);
          if (/[.!?]$/.test(next) && chunks.join(' ').length > 35) break;
          if (chunks.join(' ').length > 220) break;
        }
        scoreTitleCandidate(chunks.join(' '), 92, 'fraza szkolenie pt./pn.', candidates);
      }

      if (/\b(?:uczestnicz\w*|wzi\w*\s+udzial)\b.*\b(?:szkoleni\w*|warsztat\w*)\b/i.test(line)) {
        const after = line.replace(/^.*?\b(?:szkoleni\w*|warsztat\w*)\b\s*[:\-–]?\s*/i, '');
        scoreTitleCandidate(`${after} ${lines[i + 1] || ''}`, 68, 'uczestnictwo w szkoleniu', candidates);
      }
    }

    const flattened = text.replace(/\n+/g, ' ');
    for (const match of flattened.matchAll(/[„"]([^„”"]{18,300})[”"]/g)) {
      scoreTitleCandidate(match[1], 72, 'cudzysłów', candidates);
    }

    const regexes = [
      /(?:szkoleni\w*|warsztat\w*)\s*(?:pt\.?|pn\.?|pod\s+nazwa|pod\s+tytulem|o\s+nazwie)\s*[:\-–]?\s*[„"]?(.{18,260}?)(?=(?:[”"]|\s{2,}|\b(?:szkolenie\s+zostalo|usluga\s+zostala|termin\b|z\s+powazaniem)\b|$))/gi,
      /(?:z\s+zakresu|dotyczac\w*)\s*[:\-–]?\s*[„"]?(.{18,220}?)(?=(?:[”"]|\.|$))/gi
    ];
    for (const regex of regexes) {
      for (const match of flattened.matchAll(regex)) scoreTitleCandidate(match[1], 62, 'wzorzec tekstowy', candidates);
    }

    for (const line of lines) {
      if (line.length >= 25 && line.length <= 200 && /\b(ustaw|prawo|zasad|kwalifikac|zarzadz|zamowien|podat|obslug|energet|odpadow|cyber|excel|komunikac)/i.test(normalize(line))) {
        scoreTitleCandidate(line, 28, 'linia tematyczna', candidates);
      }
    }

    const map = new Map();
    for (const c of candidates) {
      const key = normalize(c.title);
      const previous = map.get(key);
      if (!previous || c.score > previous.score) map.set(key, c);
    }
    const ranked = [...map.values()].sort((a, b) => b.score - a.score || b.title.length - a.title.length);
    const best = ranked[0] || { title: '', score: 0, source: 'brak' };
    const margin = best.score - (ranked[1]?.score || 0);
    const confidence = best.title
      ? Math.max(25, Math.min(99, Math.round((best.score * 0.72) + (Number(ocrConfidence || 0) * 0.2) + Math.min(8, margin / 4))))
      : 0;
    return { title: best.title, confidence, source: best.source, candidates: ranked.slice(0, 5) };
  }

  function classify(title, ocrText = '') {
    const clean = cleanTitle(title);
    const publicData = publicExampleScores(clean);
    const learnedData = learnedExampleScores(clean);
    const results = CATEGORIES.map((category) => {
      const anchor = anchorMatchScore(category, clean, ocrText);
      const publicScore = publicData.scores.get(category.id) || 0;
      const userScore = learnedData.scores.get(category.id) || 0;
      const lexicalScore = profileScore(category.id, clean);

      const components = [];
      if (publicScore > 0) components.push({ value: publicScore, weight: 0.42, name: 'oferta SEMPER' });
      if (userScore > 0) components.push({ value: userScore, weight: 0.34, name: 'zaakceptowane referencje' });
      if (lexicalScore > 0) components.push({ value: lexicalScore, weight: 0.20, name: 'profil językowy' });
      if (anchor.score > 0) components.push({ value: anchor.score, weight: 0.24, name: 'pojęcia dziedzinowe' });

      let weighted = 0;
      let totalWeight = 0;
      for (const component of components) {
        weighted += component.value * component.weight;
        totalWeight += component.weight;
      }
      let score = totalWeight ? weighted / totalWeight : 0;
      // Silny, charakterystyczny marker może sam w sobie dać wiarygodną klasyfikację,
      // ale nadal jest wzmacniany przez podobieństwo do realnej oferty i profili.
      const strongestSemantic = Math.max(publicScore, userScore, lexicalScore);
      if (anchor.score >= 80) score = Math.max(score, (anchor.score * 0.78) + (strongestSemantic * 0.22));
      if (userScore >= 88) score = Math.max(score, (userScore * 0.80) + (Math.max(publicScore, anchor.score) * 0.20));
      if (publicScore >= 90) score = Math.max(score, (publicScore * 0.80) + (Math.max(anchor.score, lexicalScore) * 0.20));
      score *= Number(category.specificity || 1);
      score = Math.max(0, Math.min(100, Math.round(score)));

      return {
        ...category,
        score,
        hits: anchor.hits,
        evidence: {
          public: Math.round(publicScore),
          user: Math.round(userScore),
          lexical: Math.round(lexicalScore),
          domain: Math.round(anchor.score)
        }
      };
    });

    zastosujJednoznaczneDopasowaniaNazwKategorii(results, clean);
    zastosujReguleWarsztatowBiznesowych(results, clean);
    applyCategoryPriorities(results);
    const derivedSuggestions = applyLegalCombinationRules(results, clean);
    applyAdministrativeMorphologyRule(results, clean);
    results.sort((a, b) => b.score - a.score || a.id - b.id);

    const mainCandidates = results.filter((item) => !item.additional);
    const top = mainCandidates[0] || null;
    const best = top && top.score >= 70 ? top : null;
    const second = mainCandidates.find((item) => !best || item.id !== best.id) || null;
    let additional = best
      ? results.filter((item) => item.score >= 50 && item.id !== best.id).slice(0, 3)
      : [];

    // Jawne odmiany słów „prawo”, „administracja/urzędnik” i „warsztat” mają być zawsze
    // widoczne w końcowej sugestii, nawet gdy przy bardzo złożonym tytule
    // wypadłyby poza trzy najwyższe kategorie dodatkowe.
    if (best) {
      const mandatoryIds = [];
      if (titleContainsLawMorphology(clean)) mandatoryIds.push(8);
      if (titleContainsAdministrativeMorphology(clean)) mandatoryIds.push(6);
      if (tytulZawieraOdmianeWarsztatu(clean)) mandatoryIds.push(9);
      const mandatory = mandatoryIds
        .map((categoryId) => results.find((item) => item.id === categoryId && item.score >= 50))
        .filter((item) => item && item.id !== best.id);
      const mandatoryIdSet = new Set(mandatory.map((item) => item.id));
      const regular = results.filter((item) => item.score >= 50 && item.id !== best.id && !mandatoryIdSet.has(item.id));
      additional = [...mandatory, ...regular]
        .filter((item, index, array) => array.findIndex((candidate) => candidate.id === item.id) === index)
        .sort((a, b) => b.score - a.score || a.id - b.id)
        .slice(0, 3);
      // Jeżeli sortowanie wyrzuciło kategorię obowiązkową, wymień najsłabszą
      // zwykłą pozycję, zachowując limit maksymalnie 3 kategorii dodatkowych.
      for (const must of mandatory) {
        if (additional.some((item) => item.id === must.id)) continue;
        const replaceIndex = [...additional].reverse().findIndex((item) => !mandatoryIdSet.has(item.id));
        if (replaceIndex >= 0) additional.splice(additional.length - 1 - replaceIndex, 1, must);
        else if (additional.length < 3) additional.push(must);
      }
      additional.sort((a, b) => b.score - a.score || a.id - b.id);
    }

    const topScore = top?.score || 0;
    let level = 'niska';
    if (topScore >= 95) level = 'bardzo wysoka';
    else if (topScore >= 85) level = 'bardzo wysoka';
    else if (topScore >= 70) level = 'wysoka';
    else if (topScore >= 50) level = 'średnia';

    const closestPublic = publicData.examples[0] || null;
    const closestUser = learnedData.examples[0] || null;
    return {
      version: CLASSIFIER_VERSION,
      title: clean,
      best,
      top,
      second,
      additional,
      level,
      status: best ? 'Automatycznie zaakceptowano' : 'Wymaga ręcznej weryfikacji',
      results: results.slice(0, 10),
      closestPublic,
      closestUser,
      derivedSuggestions,
      knowledge: knowledgeSummary()
    };
  }

  window.__SEMPER_CLASSIFIER_V3__ = Object.freeze({
    version: CLASSIFIER_VERSION,
    classify,
    titleSimilarity,
    stemToken,
    knowledgeSummary
  });

  async function ensureRecordClassification(id, record) {
    if (!record) return record;
    await initializeClassifier();
    let updated = { ...record };
    let changed = false;

    // Migracja rekordów z v0.3.0: wykorzystujemy już zapisany OCR, bez ponownego
    // uruchamiania Tesseracta, aby od razu uzupełnić datę wystawienia.
    if (updated.issueDateState === undefined && updated.ocrText) {
      const issueDateResult = extractIssueDate(updated.ocrText);
      updated.issueDate = issueDateResult?.iso || '';
      updated.issueDateState = issueDateResult?.iso ? 'date' : 'undetected';
      updated.issueDateSource = issueDateResult?.iso ? 'auto' : '';
      updated.issueDateConfidence = issueDateResult?.confidence || 0;
      updated.issueDateRaw = issueDateResult?.raw || '';
      updated.issueDateCandidates = issueDateResult?.candidates || [];
      changed = true;
    }

    if ((updated.title || updated.detectedTitle)
      && (updated.classifierVersion !== CLASSIFIER_VERSION || updated.classification?.version !== CLASSIFIER_VERSION)) {
      const title = updated.manualTitle || updated.title || updated.detectedTitle || '';
      updated.title = title;
      updated.classification = classify(title, updated.ocrText || '');
      updated.classifierVersion = CLASSIFIER_VERSION;
      changed = true;
    }

    if (changed && id) await saveRecord(id, updated);
    return updated;
  }

  function requestOcr(imageUrl, id, onProgress = null) {
    const requestId = `${id || 'noid'}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingOcr.delete(requestId);
        reject(new Error('OCR przekroczył limit 3 minut.'));
      }, 180000);
      pendingOcr.set(requestId, { resolve, reject, timer, onProgress });
      window.postMessage({ source: SOURCE, direction: 'extension-to-bridge', type: 'RUN_OCR', requestId, imageUrl }, '*');
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== SOURCE || data.direction !== 'bridge-to-extension') return;

    if (data.type === 'OCR_PROGRESS') {
      const pending = data.requestId ? pendingOcr.get(data.requestId) : null;
      if (pending?.onProgress) pending.onProgress(data);
      return;
    }

    if (!data.requestId) return;
    const pending = pendingOcr.get(data.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingOcr.delete(data.requestId);
    if (data.type === 'OCR_RESULT') pending.resolve(data.result);
    else if (data.type === 'OCR_ERROR') pending.reject(new Error(data.message || 'Błąd OCR'));
  });

  async function analyzeReference(id, imageUrl, onProgress) {
    if (!imageUrl) throw new Error('Nie znaleziono obrazu referencji.');
    await initializeClassifier();
    const ocr = await requestOcr(imageUrl, id, onProgress);
    const titleResult = extractTitle(ocr.text, ocr.confidence);
    const issueDateResult = extractIssueDate(ocr.text);
    const classification = classify(titleResult.title, ocr.text);
    const previous = (await getRecord(id)) || {};
    const preserveManualIssueDate = previous.issueDateSource === 'manual' || previous.issueDateState === 'none';
    const record = {
      ...previous,
      imageUrl,
      ocrText: ocr.text,
      ocrConfidence: ocr.confidence,
      ocrVariant: ocr.variant,
      ocrAttempts: ocr.attempts,
      detectedTitle: titleResult.title,
      title: previous.manualTitle || titleResult.title,
      titleConfidence: titleResult.confidence,
      titleSource: titleResult.source,
      titleCandidates: titleResult.candidates,
      issueDate: preserveManualIssueDate ? (previous.issueDate || '') : (issueDateResult?.iso || ''),
      issueDateState: preserveManualIssueDate ? (previous.issueDateState || (previous.issueDate ? 'date' : 'undetected')) : (issueDateResult?.iso ? 'date' : 'undetected'),
      issueDateSource: preserveManualIssueDate ? (previous.issueDateSource || 'manual') : (issueDateResult?.iso ? 'auto' : ''),
      issueDateConfidence: preserveManualIssueDate ? (previous.issueDateConfidence || 100) : (issueDateResult?.confidence || 0),
      issueDateRaw: preserveManualIssueDate ? (previous.issueDateRaw || '') : (issueDateResult?.raw || ''),
      issueDateCandidates: issueDateResult?.candidates || [],
      classification,
      classifierVersion: CLASSIFIER_VERSION
    };
    await saveRecord(id, record);
    return record;
  }

  async function getAssignedCategories(id, force = false) {
    const key = categoryCacheKey(id);
    if (!force) {
      const cached = await chrome.storage.local.get(key);
      const value = cached[key];
      if (value && Array.isArray(value.names) && Date.now() - value.savedAt < CATEGORY_CACHE_TTL) return value;
    }

    const url = `https://www.szkolenia-semper.pl/wavepanel/ref_kat.php?id=${encodeURIComponent(id)}`;
    const response = await fetch(url, { credentials: 'include', cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const select = doc.querySelector('select[name="params[lista][]"]');
    const selected = [...(select?.options || [])].filter((o) => o.selected || o.hasAttribute('selected'));
    const value = {
      names: selected.map((o) => o.textContent.trim()).filter(Boolean),
      ids: selected.map((o) => String(o.value || '')).filter(Boolean),
      savedAt: Date.now()
    };
    await chrome.storage.local.set({ [key]: value });
    return value;
  }

  async function fetchCategoryEditorSource(id) {
    const url = `https://www.szkolenia-semper.pl/wavepanel/ref_kat.php?id=${encodeURIComponent(id)}`;
    const response = await fetch(url, { credentials: 'include', cache: 'no-cache' });
    if (!response.ok) throw new Error(`Nie udało się pobrać kategorii (HTTP ${response.status}).`);
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const select = doc.querySelector('select[name="params[lista][]"]');
    const form = select?.closest('form') || null;
    if (!select || !form) throw new Error('Nie znaleziono formularza kategorii na ref_kat.php.');
    return { url, doc, form, select };
  }

  function appendSuccessfulFormControls(formData, form, categorySelect) {
    for (const control of [...form.elements]) {
      if (!control?.name || control.disabled || control === categorySelect) continue;
      const type = String(control.type || '').toLowerCase();
      if (['submit', 'button', 'reset', 'file', 'image'].includes(type)) continue;
      if ((type === 'checkbox' || type === 'radio') && !control.checked) continue;

      if (control.tagName === 'SELECT') {
        for (const option of [...control.options].filter((option) => option.selected)) {
          formData.append(control.name, option.value);
        }
      } else {
        formData.append(control.name, control.value ?? '');
      }
    }

    const submitter = [...form.querySelectorAll('button[type="submit"],input[type="submit"],button:not([type])')]
      .find((button) => /zapis/i.test(button.textContent || button.value || ''))
      || form.querySelector('button[type="submit"],input[type="submit"],button:not([type])');
    if (submitter?.name) formData.append(submitter.name, submitter.value || submitter.textContent?.trim() || 'Zapisz');
  }

  async function saveCategoriesForReference(id, selectedIds) {
    const requested = [...new Set((selectedIds || []).map(String).filter(Boolean))];
    const { url, form, select } = await fetchCategoryEditorSource(id);
    const formData = new FormData();
    appendSuccessfulFormControls(formData, form, select);
    for (const categoryId of requested) formData.append(select.name, categoryId);

    const action = new URL(form.getAttribute('action') || url, url).href;
    const method = String(form.getAttribute('method') || 'post').toUpperCase();
    let response;
    if (method === 'GET') {
      const params = new URLSearchParams();
      for (const [key, value] of formData.entries()) params.append(key, String(value));
      const target = new URL(action);
      for (const [key, value] of params.entries()) target.searchParams.append(key, value);
      response = await fetch(target.href, { credentials: 'include', cache: 'no-cache' });
    } else {
      response = await fetch(action, {
        method,
        credentials: 'include',
        cache: 'no-cache',
        body: formData,
        redirect: 'follow'
      });
    }
    if (!response.ok) throw new Error(`Nie udało się zapisać kategorii (HTTP ${response.status}).`);

    await chrome.storage.local.remove(categoryCacheKey(id));
    const verified = await getAssignedCategories(id, true);
    const actual = new Set((verified.ids || []).map(String));
    const requestedSet = new Set(requested);
    const matches = actual.size === requestedSet.size && [...requestedSet].every((value) => actual.has(value));
    if (!matches) {
      throw new Error('Serwer odpowiedział, ale zapisanych kategorii nie udało się potwierdzić. Otwórz ref_kat.php i sprawdź zapis ręcznie.');
    }
    return verified;
  }

  function findRowContainingText(pattern) {
    for (const row of document.querySelectorAll('tr')) {
      if (row.closest('table') !== row.parentElement?.closest('table')) {
        // Zagnieżdżone tabele są częste w Wavepanelu; nie wykluczamy ich automatycznie.
      }
      const text = String(row.textContent || '').replace(/\s+/g, ' ').trim();
      if (pattern.test(text)) return row;
    }
    return null;
  }

  function normalizeUiText(value) {
    return String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const specialCategoryRank = new Map(SPECIAL_CATEGORY_ORDER.map((name, index) => [normalizeUiText(name), index]));

  function isSpecialCategory(name) {
    return specialCategoryRank.has(normalizeUiText(name));
  }

  function sortCategoryOptions(options) {
    const collator = new Intl.Collator('pl', { sensitivity: 'base' });
    const main = options
      .filter((option) => !isSpecialCategory(option.name))
      .sort((a, b) => collator.compare(a.name, b.name));
    const special = options
      .filter((option) => isSpecialCategory(option.name))
      .sort((a, b) => specialCategoryRank.get(normalizeUiText(a.name)) - specialCategoryRank.get(normalizeUiText(b.name)));
    return { main, special };
  }

  function appendCategoryOption(container, option) {
    const label = document.createElement('label');
    label.className = 'semper-inline-category-option';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = option.id;
    checkbox.checked = option.selected;
    const text = document.createElement('span');
    text.textContent = option.name;
    label.append(checkbox, text);
    container.appendChild(label);
  }

  function appendCategoryColumns(container, options, columnCount = 2) {
    container.textContent = '';
    if (!options.length) return;

    const columns = Math.max(1, Math.min(columnCount, options.length));
    const rowsPerColumn = Math.ceil(options.length / columns);
    for (let columnIndex = 0; columnIndex < columns; columnIndex += 1) {
      const column = document.createElement('div');
      column.className = 'semper-inline-category-column';
      const start = columnIndex * rowsPerColumn;
      const end = Math.min(options.length, start + rowsPerColumn);
      for (const option of options.slice(start, end)) appendCategoryOption(column, option);
      container.appendChild(column);
    }
  }

  function findCategoryInsertTarget() {
    const rows = [...document.querySelectorAll('tr')];

    // Najbardziej naturalne miejsce na stronie edycji: po polach podstawowych,
    // ale jeszcze przed wyborem/podglądem zdjęcia. Dzięki temu kategorie są
    // widoczne bez przewijania całej referencji.
    const imageRow = rows.find((row) => {
      const text = normalizeUiText(row.textContent);
      return /^zdjecie\s*:/.test(text) || /^podglad\s+zdjecia\s*:/.test(text);
    });
    if (imageRow?.parentNode) return { anchor: imageRow, position: 'before' };

    const aliasRow = rows.find((row) => /^alias\s*:/.test(normalizeUiText(row.textContent)));
    if (aliasRow?.parentNode) return { anchor: aliasRow, position: 'after' };

    const nameRow = rows.find((row) => /^nazwa\s*:/.test(normalizeUiText(row.textContent)));
    if (nameRow?.parentNode) return { anchor: nameRow, position: 'after' };

    const previewRow = rows.find((row) => /podglad\s+zdjecia/.test(normalizeUiText(row.textContent)));
    if (previewRow?.parentNode) return { anchor: previewRow, position: 'before' };

    const textRow = rows.find((row) => /^tekst\s*:/.test(normalizeUiText(row.textContent)));
    if (textRow?.parentNode) return { anchor: textRow, position: 'before' };
    return null;
  }

  function normalizujEtykieteNatywna(wartosc) {
    return normalizeUiText(wartosc)
      .replace(/^\*+\s*/, '')
      .replace(/\s*:\s*$/, '')
      .trim();
  }

  function selektoryChronionychKontrolek() {
    return [
      'select[name="params[act]"]',
      'input[name="params[sort]"]',
      'input[name="params[name]"]',
      '#todo_add',
      'a.btn_normal3[title="Anuluj"]',
      'a[href*="ref.php?show="]'
    ];
  }

  function znajdzEtykieteNatywna(tekstEtykiety) {
    const oczekiwanyTekst = normalizujEtykieteNatywna(tekstEtykiety);
    return [...document.querySelectorAll('#forma div.input_bgt_o, #forma div.input_bgt, #forma label, #forma td, #forma th')]
      .find((element) => {
        if (element.closest('#semper-inline-categories, .semper-original-preview, #semper-ocr-panel')) return false;
        const tekst = normalizujEtykieteNatywna(element.textContent || '');
        return tekst === oczekiwanyTekst || tekst.startsWith(`${oczekiwanyTekst} `);
      }) || null;
  }

  function znajdzPrzodkow(element) {
    const formularz = document.getElementById('forma');
    const przodkowie = [];
    let biezacy = element;
    while (biezacy && biezacy !== formularz) {
      przodkowie.push(biezacy);
      biezacy = biezacy.parentElement;
    }
    return przodkowie;
  }

  function czyBezpiecznyKontenerDoUkrycia(kontener, wlasneKontrolki = []) {
    if (!kontener) return false;
    return !selektoryChronionychKontrolek().some((selektor) => {
      const element = kontener.matches?.(selektor) ? kontener : kontener.querySelector?.(selektor);
      return element && !wlasneKontrolki.includes(element);
    });
  }

  function znajdzKontenerPola(kontrolki, etykieta = null) {
    const elementyPola = [...new Set([etykieta, ...kontrolki].filter(Boolean))];
    if (!elementyPola.length) return null;

    // Kontener wybieramy dopiero po potwierdzeniu, że zawiera komplet elementów
    // jednego pola i żadną z kontrolek, które muszą pozostać widoczne.
    for (const kandydat of znajdzPrzodkow(elementyPola[0])) {
      if (!elementyPola.every((element) => kandydat.contains(element))) continue;
      if (!czyBezpiecznyKontenerDoUkrycia(kandydat, kontrolki)) continue;
      return kandydat;
    }
    return null;
  }

  function ukryjElement(element) {
    if (!element) return;
    element.classList.add('semper-ukryty-element-natywny');
    element.setAttribute('aria-hidden', 'true');
    element.style.setProperty('display', 'none', 'important');
  }

  function ukryjKontenerPola(kontener) {
    if (!kontener) return false;
    kontener.classList.add('semper-ukryte-pole-natywne');
    kontener.setAttribute('aria-hidden', 'true');
    kontener.style.setProperty('display', 'none', 'important');
    return true;
  }

  function ukryjBezposredniKontenerKontrolki(kontrolka, selektorKontenera) {
    const kontener = kontrolka?.parentElement;
    if (!kontener?.matches(selektorKontenera)) return false;
    if (!czyBezpiecznyKontenerDoUkrycia(kontener, [kontrolka])) return false;
    return ukryjKontenerPola(kontener);
  }

  function przywrocWidocznoscElementu(element) {
    if (!element) return;
    const formularz = document.getElementById('forma');
    for (const przodek of znajdzPrzodkow(element)) {
      przodek.hidden = false;
      przodek.removeAttribute('aria-hidden');
      przodek.classList.remove(
        'semper-native-edit-row-hidden',
        'semper-native-preview-row-hidden',
        'semper-original-text-editor-hidden',
        'semper-hidden-native-label',
        'semper-native-editor-widget-hidden',
        'semper-native-mini-preview-content-hidden',
        'semper-ukryte-pole-natywne',
        'semper-ukryty-element-natywny'
      );
      if (przodek.style?.getPropertyValue('display') === 'none') przodek.style.removeProperty('display');
      if (przodek === formularz) break;
    }
  }

  function przywrocChronioneElementyFormularza() {
    if (!location.pathname.endsWith('/wavepanel/ref_adm.php')) return;
    const elementy = [
      document.querySelector('#forma select[name="params[act]"]'),
      document.querySelector('#forma input[name="params[sort]"]'),
      document.querySelector('#forma input[name="params[name]"]'),
      document.querySelector('#forma #todo_add'),
      document.querySelector('#forma a.btn_normal3[title="Anuluj"], #forma a[href*="ref.php?show="]')
    ];
    elementy.forEach(przywrocWidocznoscElementu);
  }

  function ukryjPoleNatywne(etykietaTekst, kontrolki) {
    const etykieta = znajdzEtykieteNatywna(etykietaTekst);
    const kontener = etykieta && kontrolki.length ? znajdzKontenerPola(kontrolki, etykieta) : null;
    if (ukryjKontenerPola(kontener)) return true;

    // Brak indywidualnego kontenera nie upoważnia do ukrywania rodzica.
    // Wtedy chowamy jedynie dokładnie rozpoznaną etykietę i kontrolkę.
    ukryjElement(etykieta);
    kontrolki.forEach(ukryjElement);
    return Boolean(etykieta || kontrolki.length);
  }

  function kontrolkiFckEditora() {
    const formularz = document.getElementById('forma');
    if (!formularz) return [];
    return [
      document.getElementById('params[des]'),
      document.getElementById('params[des]___Config'),
      document.getElementById('params[des]___Frame'),
      formularz.querySelector('iframe[src*="InstanceName=params[des]"]')
    ].filter(Boolean);
  }

  function ramkiFckEditora() {
    const formularz = document.getElementById('forma');
    return [
      document.getElementById('params[des]___Frame'),
      formularz?.querySelector('iframe[src*="InstanceName=params[des]"]')
    ].filter(Boolean);
  }

  function znajdzKontenerEdytoraOpisu(kontrolki, etykieta) {
    const kontenerPola = znajdzKontenerPola(kontrolki, etykieta);
    if (kontenerPola) return kontenerPola;

    // Jeżeli etykieta i ramka nie mają wspólnego małego kontenera, szukamy
    // wyłącznie opakowania samego FCKEditora, nadal z ochroną pól formularza.
    for (const kandydat of znajdzPrzodkow(kontrolki[0])) {
      if (kandydat === kontrolki[0]) continue;
      if (!czyBezpiecznyKontenerDoUkrycia(kandydat, kontrolki)) continue;
      if (!kandydat.querySelector('#params\\[des\\], #params\\[des\\]___Config, #params\\[des\\]___Frame, iframe[src*="InstanceName=params[des]"]')) continue;
      return kandydat;
    }
    return null;
  }

  function ukryjNatywnyEdytorOpisu() {
    const etykieta = znajdzEtykieteNatywna('Tekst');
    const kontrolki = kontrolkiFckEditora();
    if (!etykieta && !kontrolki.length) return false;

    const kontener = kontrolki.length ? znajdzKontenerEdytoraOpisu(kontrolki, etykieta) : null;
    if (ukryjKontenerPola(kontener)) return true;

    ukryjElement(etykieta);
    kontrolki.forEach(ukryjElement);
    return true;
  }

  function mediaNatywnegoPodgladu() {
    return [...document.querySelectorAll('#forma img[src*="/__template/img/upload/"], #forma a[href*="/__template/img/upload/"], #forma [style*="background-image"]')]
      .filter((element) => !element.closest('.semper-original-preview'));
  }

  function ukryjNatywnyPodgladZdjecia() {
    const etykieta = document.querySelector('#forma #pody') || znajdzEtykieteNatywna('Podgląd zdjęcia');
    const media = mediaNatywnegoPodgladu();
    const miniatura = document.querySelector('#forma #thumb2');
    if (miniatura && czyBezpiecznyKontenerDoUkrycia(miniatura)) ukryjKontenerPola(miniatura);
    const kontener = etykieta && media.length ? znajdzKontenerPola(media, etykieta) : null;
    if (ukryjKontenerPola(kontener)) return true;

    ukryjElement(etykieta);
    media.forEach(ukryjElement);
    return Boolean(etykieta || media.length);
  }

  function skompaktujNatywnyFormularzReferencji() {
    if (!location.pathname.endsWith('/wavepanel/ref_adm.php')) return;
    przywrocChronioneElementyFormularza();

    const aliasy = [...document.querySelectorAll('#forma input[name="params[alias]"], #forma input[name*="[alias]"]')];
    aliasy.forEach((alias) => ukryjBezposredniKontenerKontrolki(alias, 'div.input_bg'));
    ukryjPoleNatywne('Alias', aliasy);

    const polaPlikow = [...document.querySelectorAll('#forma input[type="file"]')];
    polaPlikow.forEach((polePliku) => ukryjBezposredniKontenerKontrolki(polePliku, 'div.input_bg'));
    ukryjPoleNatywne('Zdjęcie', polaPlikow);
    ukryjNatywnyPodgladZdjecia();
    ukryjNatywnyEdytorOpisu();

    // Wavepanel ma wysoką, samodzielną komórkę etykiety opisu.
    // Ukrywamy wyłącznie jej dokładny element, potwierdzony po tekście „Tekst”.
    document.querySelectorAll('#forma div.input_bgt_o').forEach((etykieta) => {
      if (normalizujEtykieteNatywna(etykieta.textContent || '') === 'tekst') ukryjElement(etykieta);
    });
  }

  function znajdzWierszDoWstawienia(element) {
    return znajdzPrzodkow(element).find((przodek) => przodek.tagName === 'TR') || null;
  }

  function znajdzKotwicePodgladu() {
    const etykietaTekstu = znajdzEtykieteNatywna('Tekst');
    const kontrolkiEdytora = kontrolkiFckEditora();
    const kontenerEdytora = kontrolkiEdytora.length
      ? znajdzKontenerEdytoraOpisu(kontrolkiEdytora, etykietaTekstu)
      : null;
    if (kontenerEdytora?.parentNode) return kontenerEdytora;

    const etykietaPodgladu = document.querySelector('#forma #pody') || znajdzEtykieteNatywna('Podgląd zdjęcia');
    const media = mediaNatywnegoPodgladu();
    const kontenerPodgladu = etykietaPodgladu && media.length ? znajdzKontenerPola(media, etykietaPodgladu) : null;
    if (kontenerPodgladu?.parentNode) return kontenerPodgladu;

    // Pasek akcji jest osobnym, znanym punktem formularza; wstawiamy podgląd przed nim.
    return znajdzWierszDoWstawienia(document.getElementById('todo_add'));
  }

  function znajdzMiejscePodgladuOryginalu() {
    if (location.pathname.endsWith('/wavepanel/ref_adm.php')) {
      const poleNazwy = document.querySelector('#forma input[name="params[name]"]');
      const wierszNazwy = znajdzWierszDoWstawienia(poleNazwy);
      if (wierszNazwy?.parentNode) return { kotwica: wierszNazwy, pozycja: 'after' };

      const celAwaryjny = findCategoryInsertTarget();
      if (celAwaryjny?.anchor?.parentNode) {
        return {
          kotwica: celAwaryjny.anchor,
          pozycja: celAwaryjny.position === 'before' ? 'before' : 'after'
        };
      }
    }

    if (location.pathname.endsWith('/wavepanel/ref_kat.php')) {
      const wyborKategorii = document.querySelector('select[name="params[lista][]"]');
      const wierszKategorii = znajdzWierszDoWstawienia(wyborKategorii);
      if (wierszKategorii?.parentNode) return { kotwica: wierszKategorii, pozycja: 'after' };
    }

    return null;
  }

  function utworzLubAktualizujPodgladOryginalu(adresObrazu) {
    const stronaEdycji = location.pathname.endsWith('/wavepanel/ref_adm.php');
    const stronaKategorii = location.pathname.endsWith('/wavepanel/ref_kat.php');
    if (!stronaEdycji && !stronaKategorii) return false;
    if (stronaEdycji) skompaktujNatywnyFormularzReferencji();

    let hostPodgladu = document.getElementById('semper-original-preview-host');

    if (!hostPodgladu) {
      const miejsce = znajdzMiejscePodgladuOryginalu();
      const kotwica = miejsce?.kotwica || znajdzKotwicePodgladu();
      if (!kotwica?.parentNode) return false;

      const wiersz = kotwica.tagName === 'TR' ? kotwica : znajdzWierszDoWstawienia(kotwica);
      hostPodgladu = document.createElement(wiersz ? 'tr' : 'div');
      hostPodgladu.id = 'semper-original-preview-host';
      let kontenerSekcji = hostPodgladu;
      if (wiersz) {
        const komorka = document.createElement('td');
        const liczbaKolumn = directCells(wiersz).reduce((suma, komorkaWiersza) => suma + Math.max(1, Number(komorkaWiersza.colSpan) || 1), 0);
        komorka.colSpan = Math.max(2, liczbaKolumn || directCells(wiersz).length || 2);
        komorka.className = 'semper-original-preview-cell';
        hostPodgladu.appendChild(komorka);
        kontenerSekcji = komorka;
      } else {
        hostPodgladu.className = 'semper-original-preview-host';
      }
      const kotwicaWstawienia = wiersz || kotwica;
      const wstawPoKotwicy = miejsce?.pozycja !== 'before';
      kotwicaWstawienia.parentNode.insertBefore(hostPodgladu, wstawPoKotwicy ? kotwicaWstawienia.nextSibling : kotwicaWstawienia);

      const sekcja = document.createElement('section');
      sekcja.className = 'semper-original-preview';
      const naglowek = document.createElement('header');
      const tytul = document.createElement('strong');
      tytul.textContent = 'Podgląd oryginału:';
      const otworz = document.createElement('a');
      otworz.className = 'semper-original-preview-open';
      otworz.target = '_blank';
      otworz.rel = 'noopener';
      otworz.textContent = 'Otwórz oryginał';
      naglowek.append(tytul, otworz);

      const obraz = document.createElement('img');
      obraz.alt = 'Pełnowymiarowy podgląd oryginalnego pliku referencji';
      obraz.loading = 'eager';
      sekcja.append(naglowek, obraz);
      kontenerSekcji.appendChild(sekcja);
    }

    const obraz = hostPodgladu.querySelector('.semper-original-preview img');
    const otworz = hostPodgladu.querySelector('.semper-original-preview-open');
    if (adresObrazu) {
      if (obraz) obraz.src = adresObrazu;
      if (otworz) {
        otworz.href = adresObrazu;
        otworz.hidden = false;
      }
    } else if (otworz) {
      otworz.hidden = true;
    }
    return true;
  }

  function czyElementWidoczny(element) {
    if (!element || !element.isConnected) return false;
    for (const przodek of [element, ...znajdzPrzodkow(element)]) {
      const style = getComputedStyle(przodek);
      if (przodek.hidden || style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  }

  function validateEditFormLayout() {
    if (!location.pathname.endsWith('/wavepanel/ref_adm.php')) return true;

    const wymagane = {
      aktywne: document.querySelector('#forma select[name="params[act]"]'),
      sortowanie: document.querySelector('#forma input[name="params[sort]"]'),
      nazwa: document.querySelector('#forma input[name="params[name]"]'),
      zapisz: document.querySelector('#forma #todo_add'),
      poZapisie: document.querySelector('#semper-after-save-sort-control'),
      podgladOryginalu: document.querySelector('.semper-original-preview')
    };
    const niewidoczne = {
      alias: document.querySelector('#forma input[name="params[alias]"], #forma input[name*="[alias]"]'),
      plik: document.querySelector('#forma input[type="file"]'),
      podgladZdjecia: document.querySelector('#forma #thumb2, #forma #pody') || znajdzEtykieteNatywna('Podgląd zdjęcia'),
      fckEditor: ramkiFckEditora()[0] || null,
      tekst: znajdzEtykieteNatywna('Tekst')
    };
    const bledyWidocznosci = Object.entries(wymagane).filter(([, element]) => !czyElementWidoczny(element));
    const bledyUkrycia = Object.entries(niewidoczne).filter(([, element]) => element && czyElementWidoczny(element));

    if (!bledyWidocznosci.length && !bledyUkrycia.length) return true;
    console.error('[SEMPER OCR] Błąd układu formularza', {
      ukryteElementyChronione: bledyWidocznosci.map(([nazwa]) => nazwa),
      widoczneElementyDoUkrycia: bledyUkrycia.map(([nazwa]) => nazwa)
    });
    bledyWidocznosci.forEach(([, element]) => przywrocWidocznoscElementu(element));
    return false;
  }

  function utrzymajNatywnyEdytorOpisuUkryty(adresObrazu) {
    if (!location.pathname.endsWith('/wavepanel/ref_adm.php')) return;
    utworzLubAktualizujPodgladOryginalu(adresObrazu);

    // FCKEditor może powstać po document_idle. Obserwator wykonuje wyłącznie
    // bezpieczne ukrycie edytora i kończy pracę zaraz po sukcesie.
    const obserwator = new MutationObserver(() => {
      if (!ramkiFckEditora().length) return;
      if (ukryjNatywnyEdytorOpisu()) obserwator.disconnect();
    });
    obserwator.observe(document.body, { childList: true, subtree: true });
    if (ramkiFckEditora().length && ukryjNatywnyEdytorOpisu()) obserwator.disconnect();
    window.setTimeout(() => obserwator.disconnect(), 15000);
  }

  function categorySuggestionIds(record) {
    const classification = record?.classification;
    return new Set([classification?.best, ...(classification?.additional || [])]
      .filter(Boolean)
      .map((item) => String(item.id)));
  }

  function updateInlineCategorySuggestions(section, record) {
    if (!section) return;
    const suggested = categorySuggestionIds(record);
    const scores = new Map((record?.classification?.results || []).map((item) => [String(item.id), item.score]));
    section.querySelectorAll('.semper-inline-category-option').forEach((label) => {
      const input = label.querySelector('input[type="checkbox"]');
      const id = String(input?.value || '');
      const isSuggested = suggested.has(id);
      label.classList.toggle('suggested', isSuggested);
      let badge = label.querySelector('.semper-inline-category-score');
      const score = scores.get(id) || 0;
      if (isSuggested && score > 0) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'semper-inline-category-score';
          label.appendChild(badge);
        }
        badge.textContent = `${score}/100`;
      } else {
        badge?.remove();
      }
    });

    const hint = section.querySelector('[data-role="category-suggestion-hint"]');
    if (hint) {
      const best = record?.classification?.best;
      hint.textContent = best
        ? `Sugestia OCR: ${best.name} (${best.score}/100, pewność ${record.classification.level}). Możesz zastosować ją jednym kliknięciem lub zaznaczyć kategorie ręcznie.`
        : 'Brak mocnej sugestii OCR. Kategorie możesz zaznaczyć ręcznie.';
    }
  }

  async function buildInlineCategoryEditor(id) {
    if (!id || document.getElementById('semper-inline-categories')) return;
    const target = findCategoryInsertTarget();
    const anchor = target?.anchor;
    if (!anchor?.parentNode) return;

    const row = document.createElement('tr');
    row.className = 'semper-inline-category-row';
    const cell = document.createElement('td');
    const visualColumns = directCells(anchor).reduce((sum, item) => sum + Math.max(1, Number(item.colSpan) || 1), 0);
    cell.colSpan = Math.max(2, visualColumns || directCells(anchor).length || 2);
    cell.className = 'semper-inline-category-cell';
    row.appendChild(cell);
    if (target.position === 'before') anchor.parentNode.insertBefore(row, anchor);
    else anchor.parentNode.insertBefore(row, anchor.nextSibling);

    const section = document.createElement('section');
    section.id = 'semper-inline-categories';
    section.innerHTML = `
      <div class="semper-inline-category-header">
        <strong>Kategorie referencji</strong>
        <div class="semper-inline-category-actions">
          <button type="button" class="semper-ocr-btn primary" data-action="save-categories">Zapisz</button>
          <button type="button" class="semper-ocr-btn" data-action="apply-suggestions">Zastosuj sugestie OCR</button>
          <button type="button" class="semper-ocr-btn" data-action="refresh-categories">Odśwież</button>
        </div>
        <span class="semper-inline-category-status" data-role="category-status">Wczytywanie…</span>
      </div>
      <div class="semper-inline-category-hint" data-role="category-suggestion-hint">Sprawdzam sugestie OCR…</div>
      <div class="semper-inline-category-grid" data-role="category-grid"></div>
      <div class="semper-inline-category-special-separator" data-role="category-special-separator" hidden></div>
      <div class="semper-inline-category-grid semper-inline-category-special" data-role="category-special-grid"></div>`;
    cell.appendChild(section);

    const grid = section.querySelector('[data-role="category-grid"]');
    const specialGrid = section.querySelector('[data-role="category-special-grid"]');
    const specialSeparator = section.querySelector('[data-role="category-special-separator"]');
    const status = section.querySelector('[data-role="category-status"]');
    const saveButton = section.querySelector('[data-action="save-categories"]');
    const applyButton = section.querySelector('[data-action="apply-suggestions"]');
    const refreshButton = section.querySelector('[data-action="refresh-categories"]');
    refreshDailyCategoryCounters();

    let optionSnapshot = [];
    let record = await getRecord(id);
    if (record) record = await ensureRecordClassification(id, record);
    const categoryDirtyKey = `categories:${id}`;

    function updateCategoryDirtyState() {
      const selectedNow = new Set([...section.querySelectorAll('input[type="checkbox"]:checked')].map((input) => String(input.value)));
      const selectedSaved = new Set(optionSnapshot.filter((option) => option.selected).map((option) => String(option.id)));
      const dirty = selectedNow.size !== selectedSaved.size || [...selectedNow].some((value) => !selectedSaved.has(value));
      setDirty(categoryDirtyKey, dirty);
      if (dirty) {
        status.className = 'semper-inline-category-status warning';
        status.textContent = 'Niezapisane zmiany';
      } else {
        const selectedCount = optionSnapshot.filter((option) => option.selected).length;
        status.className = `semper-inline-category-status${selectedCount ? ' success' : ''}`;
        status.textContent = selectedCount ? `Zapisane: ${selectedCount}` : 'Brak zapisanych kategorii';
      }
      return dirty;
    }

    section.addEventListener('change', (event) => {
      if (event.target?.matches('input[type="checkbox"]')) updateCategoryDirtyState();
    });

    async function loadCategories(force = false) {
      status.className = 'semper-inline-category-status';
      status.textContent = 'Wczytywanie kategorii…';
      try {
        const { select } = await fetchCategoryEditorSource(id);
        optionSnapshot = [...select.options]
          .map((option) => ({ id: String(option.value || ''), name: option.textContent.trim(), selected: option.selected || option.hasAttribute('selected') }))
          .filter((option) => option.id && option.name);
        const sorted = sortCategoryOptions(optionSnapshot);
        appendCategoryColumns(grid, sorted.main, 2);
        appendCategoryColumns(specialGrid, sorted.special, 2);
        specialSeparator.hidden = !sorted.special.length;
        specialGrid.hidden = !sorted.special.length;
        record = await getRecord(id);
        updateInlineCategorySuggestions(section, record);
        const selectedCount = optionSnapshot.filter((option) => option.selected).length;
        status.className = `semper-inline-category-status${selectedCount ? ' success' : ''}`;
        status.textContent = selectedCount ? `Zapisane: ${selectedCount}` : 'Brak zapisanych kategorii';
        setDirty(categoryDirtyKey, false);
        if (force) await chrome.storage.local.remove(categoryCacheKey(id));
      } catch (error) {
        status.className = 'semper-inline-category-status error';
        status.textContent = `Błąd: ${error?.message || error}`;
      }
    }

    applyButton.addEventListener('click', async () => {
      record = await getRecord(id);
      const suggested = categorySuggestionIds(record);
      if (!suggested.size) {
        status.textContent = 'Brak wystarczająco mocnej sugestii do zastosowania.';
        return;
      }
      section.querySelectorAll('input[type="checkbox"]').forEach((input) => {
        input.checked = suggested.has(String(input.value));
      });
      updateCategoryDirtyState();
      status.textContent = 'Zastosowano sugestie lokalnie. Kliknij „Zapisz”, aby zapisać je w Wavepanelu.';
    });

    saveButton.addEventListener('click', async () => {
      const selected = [...section.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
      saveButton.disabled = true;
      refreshButton.disabled = true;
      status.className = 'semper-inline-category-status';
      status.textContent = 'Zapisuję kategorie…';
      try {
        const verified = await saveCategoriesForReference(id, selected);
        status.className = 'semper-inline-category-status success';
        status.textContent = verified.names.length ? `Zapisano: ${verified.names.length} kategorii` : 'Zapisano brak kategorii.';
        optionSnapshot = optionSnapshot.map((option) => ({ ...option, selected: verified.ids.includes(option.id) }));
        if (verified.ids.length) await markCategoryAssignmentToday(id);
        window.dispatchEvent(new CustomEvent('semper-categories-saved', {
          detail: { id: String(id), ids: verified.ids.map(String), names: verified.names || [] }
        }));
        // Jawny zapis użytkownika staje się przykładem uczącym klasyfikator.
        const currentRecord = await getRecord(id);
        if (currentRecord?.title || currentRecord?.detectedTitle) {
          const approved = {
            ...currentRecord,
            approvedCategoryIds: verified.ids.map(Number).filter(Boolean),
            approvedCategoryNames: verified.names,
            approvedCategoriesAt: Date.now()
          };
          await saveRecord(id, approved);
          await loadLearnedExamples();
          const refreshed = await ensureRecordClassification(id, { ...approved, classifierVersion: '' });
          record = refreshed;
          updateInlineCategorySuggestions(section, refreshed);
          announceRecordUpdate(id, refreshed);
        }
        setDirty(categoryDirtyKey, false);
      } catch (error) {
        status.className = 'semper-inline-category-status error';
        status.textContent = `Nie udało się zapisać: ${error?.message || error}`;
      } finally {
        saveButton.disabled = false;
        refreshButton.disabled = false;
      }
    });

    refreshButton.addEventListener('click', async () => {
      refreshButton.disabled = true;
      try { await loadCategories(true); } finally { refreshButton.disabled = false; }
    });

    window.addEventListener('semper-ocr-record-updated', async (event) => {
      if (String(event.detail?.id || '') !== String(id)) return;
      record = event.detail?.record || await getRecord(id);
      updateInlineCategorySuggestions(section, record);
    });

    window.addEventListener('semper-categories-saved', (event) => {
      if (String(event.detail?.id || '') !== String(id)) return;
      const savedIds = new Set((event.detail?.ids || []).map(String));
      optionSnapshot = optionSnapshot.map((option) => ({ ...option, selected: savedIds.has(String(option.id)) }));
      section.querySelectorAll('input[type="checkbox"]').forEach((input) => {
        input.checked = savedIds.has(String(input.value));
      });
      const selectedCount = optionSnapshot.filter((option) => option.selected).length;
      status.className = `semper-inline-category-status${selectedCount ? ' success' : ''}`;
      status.textContent = selectedCount ? `Zapisane: ${selectedCount}` : 'Brak zapisanych kategorii';
      setDirty(categoryDirtyKey, false);
    });

    await loadCategories(false);
  }

  function announceRecordUpdate(id, record) {
    if (!id) return;
    window.dispatchEvent(new CustomEvent('semper-ocr-record-updated', { detail: { id: String(id), record } }));
  }

  function statusClass(confidence) {
    if (confidence >= 80) return 'semper-ref-status-good';
    if (confidence >= 55) return 'semper-ref-status-mid';
    if (confidence > 0) return 'semper-ref-status-bad';
    return 'semper-ref-status-wait';
  }

  function renderPills(cell, values, empty = 'Brak') {
    cell.textContent = '';
    if (!values?.length) {
      cell.textContent = empty;
      return;
    }
    for (const value of values) {
      const span = document.createElement('span');
      span.className = 'semper-ref-pill';
      span.textContent = value;
      cell.appendChild(span);
    }
  }

  function utworzOznaczenieWeryfikacji(zatwierdzone, rodzajPola) {
    const oznaczenie = document.createElement('span');
    oznaczenie.className = `semper-ref-approval-badge ${zatwierdzone ? 'zatwierdzone' : 'oczekujace'}`;
    oznaczenie.textContent = zatwierdzone ? '✓ Ręcznie zatwierdzone' : '⌛ Do zatwierdzenia';
    oznaczenie.title = zatwierdzone
      ? `Pole „${rodzajPola}” zostało zatwierdzone ręcznie.`
      : `Pole „${rodzajPola}” czeka na ręczne zatwierdzenie.`;
    return oznaczenie;
  }

  function czyTytulZatwierdzonyRecznie(record) {
    return Boolean(cleanTitle(record?.manualTitle || ''));
  }

  function czyDataZatwierdzonaRecznie(record) {
    return Boolean(record?.issueDateApprovedAt || record?.issueDateSource === 'manual');
  }

  function setTitleCell(cell, record) {
    cell.textContent = '';
    const title = record?.title || record?.detectedTitle || '';
    if (!title) {
      cell.innerHTML = '<span class="semper-ref-status-wait">Nieanalizowane</span>';
      cell.appendChild(utworzOznaczenieWeryfikacji(false, 'Tytuł'));
      return;
    }
    const div = document.createElement('div');
    div.textContent = title;
    cell.appendChild(div);
    const meta = document.createElement('div');
    meta.className = statusClass(record?.titleConfidence || 0);
    meta.style.marginTop = '3px';
    meta.style.fontSize = '11px';
    meta.textContent = `tytuł: ${record?.titleConfidence || 0}%`;
    cell.appendChild(meta);
    cell.appendChild(utworzOznaczenieWeryfikacji(czyTytulZatwierdzonyRecznie(record), 'Tytuł'));
  }

  function setIssueDateCell(cell, record) {
    cell.textContent = '';
    const state = record?.issueDateState || (record?.issueDate ? 'date' : 'undetected');
    if (state === 'none') {
      cell.innerHTML = '<span class="semper-ref-status-wait">Brak</span>';
      cell.title = 'Użytkownik oznaczył, że dokument nie zawiera daty wystawienia.';
      cell.appendChild(utworzOznaczenieWeryfikacji(czyDataZatwierdzonaRecznie(record), 'Data wystawienia'));
      return;
    }
    if (!record?.issueDate) {
      cell.innerHTML = '<span class="semper-ref-status-wait">Niewykryta</span>';
      cell.title = 'OCR nie wykrył wiarygodnej daty wystawienia dokumentu.';
      cell.appendChild(utworzOznaczenieWeryfikacji(czyDataZatwierdzonaRecznie(record), 'Data wystawienia'));
      return;
    }
    const value = document.createElement('div');
    value.textContent = formatIssueDate(record.issueDate) || record.issueDate;
    value.className = record.issueDateSource === 'manual' ? 'semper-ref-status-good' : statusClass(record.issueDateConfidence || 0);
    cell.appendChild(value);
    if (record.issueDateSource === 'auto') {
      const meta = document.createElement('div');
      meta.className = 'semper-ref-date-meta';
      meta.textContent = `${record.issueDateConfidence || 0}%`;
      cell.appendChild(meta);
    }
    cell.appendChild(utworzOznaczenieWeryfikacji(czyDataZatwierdzonaRecznie(record), 'Data wystawienia'));
  }

  function setSuggestionCell(cell, record) {
    cell.textContent = '';
    const c = record?.classification;
    if (!c?.best) {
      cell.innerHTML = '<span class="semper-ref-status-wait">Brak sugestii</span>';
      return;
    }
    const main = document.createElement('div');
    main.textContent = c.best.name;
    main.className = c.level === 'wysoka' ? 'semper-ref-status-good' : c.level === 'średnia' ? 'semper-ref-status-mid' : 'semper-ref-status-bad';
    cell.appendChild(main);
    const meta = document.createElement('div');
    meta.style.fontSize = '11px';
    meta.textContent = `${c.best.score}/100 · pewność ${c.level}`;
    cell.appendChild(meta);
  }

  function setOcrCell(cell, record) {
    const confidence = record?.ocrConfidence || 0;
    cell.className = `semper-ref-ocr-cell ${statusClass(confidence)}`;
    cell.textContent = confidence ? `${confidence}%` : '—';
    if (record?.ocrVariant) cell.title = `Wariant: ${record.ocrVariant}`;
  }

  function rowLooksLikeReferenceHeader(row) {
    const headers = directCells(row).map((cell) => normalizeUiText(cell.textContent));
    return headers.some((value) => value === 'nazwa:' || value === 'nazwa')
      && headers.some((value) => value.includes('opcje'));
  }

  function findReferenceTable(root = document) {
    // Ważne: Wavepanel używa zagnieżdżonych tabel. Poprzednia wersja mogła
    // zwrócić tabelę-rodzica tylko dlatego, że zawierała w środku właściwy
    // nagłówek referencji. Wtedy findHeaderRow() nie znajdował bezpośredniego
    // nagłówka i rozszerzenie kończyło pracę bez dodania kolumn.
    for (const table of root.querySelectorAll('table')) {
      const directRows = [...table.querySelectorAll('tr')].filter((row) => row.closest('table') === table);
      if (directRows.some(rowLooksLikeReferenceHeader)) return table;
    }
    return null;
  }

  function findHeaderRow(table) {
    return [...table.querySelectorAll('tr')].find((row) => row.closest('table') === table && rowLooksLikeReferenceHeader(row)) || null;
  }

  function directCells(row) {
    return [...row.children].filter((c) => /^(TD|TH)$/.test(c.tagName));
  }

  function wlaczZmianeSzerokosciKolumn(tabela, wierszNaglowka) {
    const komorkiNaglowka = directCells(wierszNaglowka);
    if (komorkiNaglowka.length < 2 || tabela.dataset.semperZmianaSzerokosci === '1') return;
    tabela.dataset.semperZmianaSzerokosci = '1';

    for (let indeks = 0; indeks < komorkiNaglowka.length - 1; indeks += 1) {
      const komorka = komorkiNaglowka[indeks];
      const nastepnaKomorka = komorkiNaglowka[indeks + 1];
      const uchwyt = document.createElement('span');
      uchwyt.className = 'semper-ref-column-resizer';
      uchwyt.title = 'Przeciągnij, aby zmienić szerokość kolumny';
      uchwyt.setAttribute('aria-hidden', 'true');
      komorka.classList.add('semper-ref-resizable-header');

      uchwyt.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();

        const szerokoscTabeli = tabela.getBoundingClientRect().width;
        const szerokosci = komorkiNaglowka.map((naglowek) => naglowek.getBoundingClientRect().width);
        if (!szerokoscTabeli || !szerokosci[indeks] || !szerokosci[indeks + 1]) return;

        for (let numer = 0; numer < komorkiNaglowka.length; numer += 1) {
          komorkiNaglowka[numer].style.setProperty('width', `${(szerokosci[numer] / szerokoscTabeli) * 100}%`, 'important');
        }

        const poczatekX = event.clientX;
        const szerokoscBiezaca = szerokosci[indeks];
        const szerokoscNastepna = szerokosci[indeks + 1];
        const minimalnaSzerokosc = 48;
        uchwyt.setPointerCapture(event.pointerId);
        uchwyt.classList.add('aktywny');
        document.body.classList.add('semper-ref-column-resizing');

        const przesun = (zdarzenie) => {
          const przesuniecie = Math.max(
            minimalnaSzerokosc - szerokoscBiezaca,
            Math.min(zdarzenie.clientX - poczatekX, szerokoscNastepna - minimalnaSzerokosc)
          );
          komorka.style.setProperty('width', `${((szerokoscBiezaca + przesuniecie) / szerokoscTabeli) * 100}%`, 'important');
          nastepnaKomorka.style.setProperty('width', `${((szerokoscNastepna - przesuniecie) / szerokoscTabeli) * 100}%`, 'important');
        };

        const zakoncz = () => {
          uchwyt.removeEventListener('pointermove', przesun);
          uchwyt.removeEventListener('pointerup', zakoncz);
          uchwyt.removeEventListener('pointercancel', zakoncz);
          uchwyt.classList.remove('aktywny');
          document.body.classList.remove('semper-ref-column-resizing');
        };

        uchwyt.addEventListener('pointermove', przesun);
        uchwyt.addEventListener('pointerup', zakoncz);
        uchwyt.addEventListener('pointercancel', zakoncz);
      });

      komorka.appendChild(uchwyt);
    }
  }

  function getVisualColumnStart(row, targetCell) {
    let visualIndex = 0;
    for (const cell of directCells(row)) {
      if (cell === targetCell) return visualIndex;
      visualIndex += Math.max(1, Number(cell.colSpan) || 1);
    }
    return -1;
  }

  function findCellAtVisualColumn(row, visualIndex) {
    if (visualIndex < 0) return null;
    let current = 0;
    for (const cell of directCells(row)) {
      const span = Math.max(1, Number(cell.colSpan) || 1);
      if (visualIndex >= current && visualIndex < current + span) return cell;
      current += span;
    }
    return null;
  }

  function getDataRows(table, headerRow) {
    return [...table.querySelectorAll('tr')].filter((row) => (
      row !== headerRow
      && row.closest('table') === table
      && directCells(row).length
      && getIdFromRow(row)
    ));
  }

  function insertAfter(referenceNode, newNode) {
    referenceNode.parentNode.insertBefore(newNode, referenceNode.nextSibling);
  }

  function opisKontrolkiOpcji(kontrolka) {
    const atrybuty = ['href', 'onclick', 'title', 'aria-label', 'value', 'src', 'alt'];
    const elementy = [kontrolka, ...kontrolka.querySelectorAll('*')];
    return elementy
      .flatMap((element) => atrybuty.map((atrybut) => element.getAttribute?.(atrybut) || ''))
      .concat(kontrolka.textContent || '')
      .join(' ')
      .toLowerCase();
  }

  function typKontrolkiOpcji(kontrolka) {
    const opis = opisKontrolkiOpcji(kontrolka);
    if (/usuń|usun|kasuj|delete|remove|\bdel\b|[?&]opc=(?:del|delete|remove)\b/.test(opis)) return 'usun';
    if (/ref_kat\.php|kategor/.test(opis)) return 'kategorie';
    if (/ref_adm\.php|edyt|edit/.test(opis)) return 'edytuj';
    return '';
  }

  function ustawEtykieteKontrolkiOpcji(kontrolka, etykieta) {
    if (kontrolka.matches('input')) kontrolka.value = etykieta;
    else kontrolka.textContent = etykieta;
  }

  function utworzPrzyciskZOpcjiListy(lista, opcja) {
    const przycisk = document.createElement('button');
    przycisk.type = 'button';
    przycisk.addEventListener('click', () => {
      lista.value = opcja.value;
      lista.dispatchEvent(new Event('change', { bubbles: true }));
    });
    return przycisk;
  }

  function przywrocPrzyciskiOpcji(komorka) {
    if (!komorka || komorka.dataset.semperOpcje === '1') return false;
    const kontrolki = [...komorka.querySelectorAll('a, button, input[type="button"], input[type="submit"]')]
      .filter((kontrolka) => !kontrolka.parentElement?.closest('a, button'));
    const wedlugTypu = new Map();
    for (const kontrolka of kontrolki) {
      const typ = typKontrolkiOpcji(kontrolka);
      if (typ && !wedlugTypu.has(typ)) wedlugTypu.set(typ, kontrolka);
    }

    const listyOpcji = [...komorka.querySelectorAll('select')];
    for (const lista of listyOpcji) {
      for (const opcja of lista.options) {
        const typ = typKontrolkiOpcji(opcja);
        if (typ && !wedlugTypu.has(typ)) {
          wedlugTypu.set(typ, utworzPrzyciskZOpcjiListy(lista, opcja));
        }
      }
    }
    if (!wedlugTypu.has('edytuj') || !wedlugTypu.has('kategorie') || !wedlugTypu.has('usun')) return false;

    const kontener = document.createElement('div');
    kontener.className = 'semper-ref-opcje-akcje';
    const ustawienia = [
      ['edytuj', '✏️ Edytuj'],
      ['usun', '❌ Usuń'],
      ['kategorie', '📚 Kategorie']
    ];
    for (const [typ, etykieta] of ustawienia) {
      const kontrolka = wedlugTypu.get(typ);
      kontrolka.classList.add('semper-ref-opcja-przycisk', `semper-ref-opcja-${typ}`);
      ustawEtykieteKontrolkiOpcji(kontrolka, etykieta);
      kontener.appendChild(kontrolka);
    }
    komorka.textContent = '';
    komorka.classList.add('semper-ref-opcje-komorka');
    komorka.dataset.semperOpcje = '1';
    for (const lista of listyOpcji) {
      lista.hidden = true;
      komorka.appendChild(lista);
    }
    komorka.appendChild(kontener);
    return true;
  }

  function przywrocPrzyciskiOpcjiWWierszu(wiersz, indeksPoczatkowy, liczbaKolumn) {
    const kandydaci = [];
    for (let przesuniecie = liczbaKolumn - 1; przesuniecie >= 0; przesuniecie -= 1) {
      const komorka = findCellAtVisualColumn(wiersz, indeksPoczatkowy + przesuniecie);
      if (komorka && !kandydaci.includes(komorka)) kandydaci.push(komorka);
    }
    for (const komorka of directCells(wiersz)) {
      if (normalizeUiText(komorka.textContent).includes('opcje') && !kandydaci.includes(komorka)) {
        kandydaci.push(komorka);
      }
    }
    return kandydaci.some(przywrocPrzyciskiOpcji);
  }

  function ustawKolorPrzypisanejReferencji(zadanie) {
    const maKategorie = Boolean(zadanie?.assigned?.ids?.length);
    zadanie?.row?.classList.toggle('semper-ref-row-categorized', maKategorie);
  }

  async function processWithLimit(items, limit, handler) {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        await handler(items[index], index);
      }
    });
    await Promise.all(workers);
  }

  function getPreferredListPageSize() {
    const value = Number(localStorage.getItem(LIST_PAGE_SIZE_KEY) || '20');
    return [20, 50, 100].includes(value) ? value : 20;
  }

  function normalizePagerText(element) {
    if (!element) return '';
    const value = element.matches?.('input') ? (element.value || element.getAttribute('aria-label') || '') : (element.textContent || element.getAttribute?.('aria-label') || element.getAttribute?.('title') || '');
    return String(value).replace(/\s+/g, ' ').trim();
  }

  function isPagerNumber(element) {
    return /^\d+$/.test(normalizePagerText(element));
  }

  function isPagerForward(element) {
    const text = normalizePagerText(element).toLowerCase();
    return ['>', '›', '»', '>>'].includes(text) || /nast[eę]pn|next/.test(text);
  }

  function isPagerBackward(element) {
    const text = normalizePagerText(element).toLowerCase();
    return ['<', '‹', '«', '<<'].includes(text) || /poprzed|prev/.test(text);
  }

  function isPagerDisabled(element) {
    if (!element) return true;
    if (element.disabled) return true;
    if (element.getAttribute?.('aria-disabled') === 'true') return true;
    return Boolean(element.closest?.('.disabled, [disabled]'));
  }

  function findPagerContainer(root = document) {
    const selector = 'div, td, ul, ol, nav, p';
    const containers = [...root.querySelectorAll(selector)];
    const candidates = [];
    for (const container of containers) {
      const controls = [...container.querySelectorAll('a, button, span, strong, input[type="button"], input[type="submit"]')];
      const numeric = controls.filter(isPagerNumber);
      if (numeric.length < 2) continue;
      const arrows = controls.filter((el) => isPagerForward(el) || isPagerBackward(el));
      if (!arrows.length) continue;
      const interactiveCount = controls.filter((el) => el.matches?.('a[href], button, input[type="button"], input[type="submit"]')).length;
      candidates.push({ container, numericCount: numeric.length, interactiveCount, totalControls: controls.length });
    }
    candidates.sort((a, b) => (a.totalControls - b.totalControls) || (b.interactiveCount - a.interactiveCount) || (b.numericCount - a.numericCount));
    return candidates[0]?.container || null;
  }

  function getPagerModel(root = document) {
    const container = findPagerContainer(root);
    if (!container) return { container: null, current: null, numbers: new Map(), next: null, prev: null };
    const controls = [...container.querySelectorAll('a, button, span, strong, input[type="button"], input[type="submit"]')];
    const numbers = new Map();
    let current = null;
    for (const control of controls.filter(isPagerNumber)) {
      const page = Number(normalizePagerText(control));
      if (!numbers.has(page)) numbers.set(page, control);
      const active = control.matches?.('[aria-current="page"], .active, .current, .selected')
        || control.closest?.('[aria-current="page"], .active, .current, .selected')
        || (!control.matches?.('a[href], button, input[type="button"], input[type="submit"]'));
      if (active) current = page;
    }
    const next = controls.find((el) => isPagerForward(el) && !isPagerDisabled(el)) || null;
    const prev = controls.find((el) => isPagerBackward(el) && !isPagerDisabled(el)) || null;
    if (!current && numbers.has(1) && !prev) current = 1;
    return { container, current, numbers, next, prev };
  }

  function controlHref(control, baseUrl = location.href) {
    const anchor = control?.closest?.('a[href]') || (control?.matches?.('a[href]') ? control : null);
    const href = anchor?.getAttribute('href') || '';
    if (!href || href === '#' || /^javascript:/i.test(href)) return '';
    try { return new URL(href, baseUrl).href; } catch (_) { return ''; }
  }

  function getNextListPageUrl(root, baseUrl) {
    const model = getPagerModel(root);
    let url = controlHref(model.next, baseUrl);
    if (url) return url;
    if (model.current && model.numbers.has(model.current + 1)) {
      url = controlHref(model.numbers.get(model.current + 1), baseUrl);
      if (url) return url;
    }
    return '';
  }

  function appendFetchedReferenceRows(targetTable, fetchedTable, limit) {
    const targetHeader = findHeaderRow(targetTable);
    const fetchedHeader = findHeaderRow(fetchedTable);
    if (!targetHeader || !fetchedHeader || limit <= 0) return 0;
    const targetRows = getDataRows(targetTable, targetHeader);
    const fetchedRows = getDataRows(fetchedTable, fetchedHeader);
    if (!fetchedRows.length) return 0;
    const knownIds = new Set(targetRows.map(getIdFromRow).filter(Boolean));
    const lastTargetRow = targetRows[targetRows.length - 1];
    const parent = lastTargetRow?.parentNode || targetTable.tBodies?.[0] || targetTable;
    let anchor = lastTargetRow?.nextSibling || null;
    let added = 0;
    for (const row of fetchedRows) {
      const id = getIdFromRow(row);
      if (!id || knownIds.has(id)) continue;
      const clone = row.cloneNode(true);
      clone.dataset.semperAggregatedRow = '1';
      parent.insertBefore(clone, anchor);
      knownIds.add(id);
      added += 1;
      if (added >= limit) break;
    }
    return added;
  }

  async function expandReferenceTableForPreferredSize(table) {
    const wanted = getPreferredListPageSize();
    const header = findHeaderRow(table);
    if (!header) return { wanted, loaded: 0, pagesMerged: 0 };
    let loaded = getDataRows(table, header).length;
    if (wanted <= loaded) return { wanted, loaded, pagesMerged: 0 };

    let sourceRoot = document;
    let sourceBaseUrl = location.href;
    let pagesMerged = 0;
    const seenUrls = new Set([location.href]);

    while (loaded < wanted) {
      const nextUrl = getNextListPageUrl(sourceRoot, sourceBaseUrl);
      if (!nextUrl || seenUrls.has(nextUrl)) break;
      seenUrls.add(nextUrl);
      try {
        const response = await fetch(nextUrl, { credentials: 'include', cache: 'no-store' });
        if (!response.ok) break;
        const html = await response.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const fetchedTable = findReferenceTable(doc);
        if (!fetchedTable) break;
        const added = appendFetchedReferenceRows(table, fetchedTable, wanted - loaded);
        if (!added) break;
        loaded += added;
        pagesMerged += 1;
        sourceRoot = doc;
        sourceBaseUrl = nextUrl;
      } catch (error) {
        console.warn('[SEMPER OCR] Nie udało się doładować kolejnej strony referencji.', error);
        break;
      }
    }
    return { wanted, loaded, pagesMerged };
  }

  async function continuePendingListPageJump() {
    const target = Number(sessionStorage.getItem(LIST_PAGE_JUMP_KEY) || '0');
    if (!Number.isInteger(target) || target < 1) return false;

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const model = getPagerModel(document);
      if (model.container && model.current) {
        if (model.current === target) {
          sessionStorage.removeItem(LIST_PAGE_JUMP_KEY);
          return false;
        }
        const direct = model.numbers.get(target);
        const control = direct || (target > model.current ? model.next : model.prev);
        if (!control || isPagerDisabled(control)) {
          sessionStorage.removeItem(LIST_PAGE_JUMP_KEY);
          return false;
        }
        const clickable = control.closest?.('a,button,input') || control;
        clickable.click();
        return true;
      }
      await sleep(100);
    }
    return false;
  }

  function createToolbar(table, jobs, listMeta = {}) {
    const existing = document.getElementById('semper-ocr-list-toolbar');
    if (existing) return existing;
    const toolbar = document.createElement('div');
    toolbar.id = 'semper-ocr-list-toolbar';
    toolbar.className = 'semper-ocr-toolbar';

    const analyze = document.createElement('button');
    analyze.type = 'button';
    analyze.className = 'primary';
    analyze.textContent = 'OCR + klasyfikacja widocznych';
    analyze.title = 'Uruchamia OCR dla wszystkich widocznych, jeszcze nieprzeanalizowanych referencji. Dla już przeanalizowanych odświeża klasyfikację bez ponownego OCR.';

    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.textContent = 'Odśwież dane';

    const otworzNieprzypisane = document.createElement('button');
    otworzNieprzypisane.type = 'button';
    otworzNieprzypisane.textContent = 'Otwórz nieprzypisane';
    otworzNieprzypisane.title = 'Otwiera strony kategorii wszystkich wczytanych referencji bez przypisanej kategorii.';

    const filter = document.createElement('select');
    filter.innerHTML = '<option value="all">Wszystkie</option><option value="unanalyzed">Nieanalizowane</option><option value="verify">Do weryfikacji</option><option value="conflict">Rozbieżność kategorii</option><option value="nocat">Bez kategorii</option>';

    const pageSizeLabel = document.createElement('label');
    pageSizeLabel.className = 'semper-list-control';
    pageSizeLabel.append(document.createTextNode('Widocznych: '));
    const pageSize = document.createElement('select');
    pageSize.className = 'semper-list-page-size';
    for (const value of [20, 50, 100]) pageSize.appendChild(new Option(String(value), String(value), false, value === getPreferredListPageSize()));
    pageSizeLabel.appendChild(pageSize);

    const pager = getPagerModel(document);
    const jumpLabel = document.createElement('label');
    jumpLabel.className = 'semper-list-control semper-list-jump';
    jumpLabel.append(document.createTextNode('Strona: '));
    const jumpInput = document.createElement('input');
    jumpInput.type = 'number';
    jumpInput.min = '1';
    jumpInput.step = '1';
    jumpInput.inputMode = 'numeric';
    jumpInput.className = 'semper-list-page-input';
    jumpInput.value = pager.current ? String(pager.current) : '';
    jumpInput.placeholder = pager.current ? String(pager.current) : 'nr';
    const jumpButton = document.createElement('button');
    jumpButton.type = 'button';
    jumpButton.textContent = 'Przejdź';
    jumpLabel.append(jumpInput, jumpButton);

    const dailyCounter = makeDailyCategoryCounter(false);

    const status = document.createElement('span');
    status.className = 'status';
    const extra = listMeta.pagesMerged ? ` · doładowano ${listMeta.pagesMerged} str.` : '';
    status.textContent = `Referencje widoczne: ${jobs.length}${extra}`;

    pageSize.addEventListener('change', () => {
      const value = Number(pageSize.value);
      if (![20, 50, 100].includes(value)) return;
      localStorage.setItem(LIST_PAGE_SIZE_KEY, String(value));
      status.textContent = `Ustawiam ${value} referencji na stronie...`;
      location.reload();
    });

    const goToPage = async () => {
      const target = Number(jumpInput.value);
      if (!Number.isInteger(target) || target < 1) {
        jumpInput.focus();
        return;
      }
      const currentModel = getPagerModel(document);
      if (currentModel.current === target) {
        status.textContent = `Jesteś już na stronie ${target}.`;
        return;
      }
      sessionStorage.setItem(LIST_PAGE_JUMP_KEY, String(target));
      status.textContent = `Przechodzę do strony ${target}...`;
      const direct = currentModel.numbers.get(target);
      const control = direct || (currentModel.current && target > currentModel.current ? currentModel.next : currentModel.prev);
      if (!control || isPagerDisabled(control)) {
        sessionStorage.removeItem(LIST_PAGE_JUMP_KEY);
        status.textContent = `Nie można przejść do strony ${target}.`;
        return;
      }
      (control.closest?.('a,button,input') || control).click();
    };
    jumpButton.addEventListener('click', goToPage);
    jumpInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        goToPage();
      }
    });

    filter.addEventListener('change', () => {
      for (const job of jobs) {
        const rec = job.record || null;
        const assigned = job.assigned || { ids: [] };
        let show = true;
        if (filter.value === 'unanalyzed') show = !rec?.ocrText;
        if (filter.value === 'verify') show = rec?.classification?.level === 'niska' || (rec?.ocrConfidence > 0 && rec.ocrConfidence < 60);
        if (filter.value === 'nocat') show = !assigned.ids?.length;
        if (filter.value === 'conflict') {
          const suggested = String(rec?.classification?.best?.id || '');
          show = Boolean(suggested && assigned.ids?.length && !assigned.ids.includes(suggested));
        }
        job.row.style.display = show ? '' : 'none';
      }
      const visible = jobs.filter((job) => job.row.style.display !== 'none').length;
      status.textContent = `Widoczne po filtrze: ${visible} / ${jobs.length}`;
    });

    otworzNieprzypisane.addEventListener('click', () => {
      const oczekujace = jobs.filter((zadanie) => !zadanie.assigned).length;
      const nieprzypisane = jobs.filter((zadanie) => zadanie.assigned && !zadanie.assigned.ids?.length);
      if (!nieprzypisane.length) {
        status.textContent = oczekujace
          ? `Kategorie są jeszcze wczytywane (${oczekujace}). Spróbuj ponownie za chwilę.`
          : 'Brak nieprzypisanych referencji na tej stronie.';
        return;
      }
      for (const zadanie of nieprzypisane) {
        window.open(`https://www.szkolenia-semper.pl/wavepanel/ref_kat.php?id=${encodeURIComponent(zadanie.id)}`, '_blank', 'noopener');
      }
      status.textContent = `Otwarto nieprzypisane referencje: ${nieprzypisane.length}.`;
    });

    refresh.addEventListener('click', async () => {
      refresh.disabled = true;
      status.textContent = 'Odświeżam tytuły i zapisane kategorie...';
      try {
        await processWithLimit(jobs, 6, async (job) => {
          job.record = await getRecord(job.id);
          if (job.record) job.record = await ensureRecordClassification(job.id, job.record);
          setTitleCell(job.titleCell, job.record);
          setIssueDateCell(job.issueDateCell, job.record);
          setSuggestionCell(job.suggestionCell, job.record);
          setOcrCell(job.ocrCell, job.record);
          try {
            job.assigned = await getAssignedCategories(job.id, true);
            renderPills(job.categoryCell, job.assigned.names, 'Nieprzypisane');
            ustawKolorPrzypisanejReferencji(job);
          } catch (error) {
            job.categoryCell.textContent = 'Błąd odczytu';
            job.categoryCell.title = String(error?.message || error);
          }
        });
        status.textContent = `Odświeżono ${jobs.length} referencji.`;
      } finally {
        refresh.disabled = false;
      }
    });

    analyze.addEventListener('click', async () => {
      analyze.disabled = true;
      refresh.disabled = true;
      pageSize.disabled = true;
      jumpButton.disabled = true;
      const visible = jobs.filter((j) => j.row.style.display !== 'none').slice(0, MAX_VISIBLE_ANALYSIS);
      let done = 0;
      let ocrRun = 0;
      let reclassified = 0;
      let errors = 0;
      for (const job of visible) {
        try {
          job.row.classList.add('semper-ref-row-processing');
          if (job.record?.ocrText) {
            status.textContent = `Klasyfikacja ${done + 1}/${visible.length}: ID ${job.id}`;
            job.record = await ensureRecordClassification(job.id, { ...job.record, classifierVersion: '' });
            reclassified += 1;
          } else {
            status.textContent = `OCR ${done + 1}/${visible.length}: ID ${job.id} – szukam obrazu...`;
            const imageUrl = job.record?.imageUrl || await fetchImageUrlForReference(job.id, job.editUrl);
            if (!imageUrl) throw new Error(`Nie znaleziono pliku graficznego referencji #${job.id} na stronie edycji.`);
            const record = await analyzeReference(job.id, imageUrl, (p) => {
              const percent = Number.isFinite(p.progress) ? ` ${p.progress}%` : '';
              status.textContent = `OCR ${done + 1}/${visible.length}: ID ${job.id} · ${p.status || ''}${percent}`;
            });
            job.record = record;
            ocrRun += 1;
          }
          setTitleCell(job.titleCell, job.record);
          setIssueDateCell(job.issueDateCell, job.record);
          setSuggestionCell(job.suggestionCell, job.record);
          setOcrCell(job.ocrCell, job.record);
        } catch (error) {
          errors += 1;
          job.ocrCell.className = 'semper-ref-ocr-cell semper-ref-status-bad';
          const errorMessage = String(error?.message || error);
          job.ocrCell.textContent = /pliku graficznego|obrazu referencji/i.test(errorMessage) ? 'Brak obrazu' : 'Błąd';
          job.ocrCell.title = errorMessage;
          console.error('[SEMPER OCR] Błąd analizy ID', job.id, error);
        } finally {
          job.row.classList.remove('semper-ref-row-processing');
          done += 1;
        }
      }
      status.textContent = `Gotowe: ${done} · OCR: ${ocrRun} · ponowna klasyfikacja: ${reclassified}${errors ? ` · błędy: ${errors}` : ''}.`;
      analyze.disabled = false;
      refresh.disabled = false;
      pageSize.disabled = false;
      jumpButton.disabled = false;
    });

    toolbar.append(analyze, refresh, otworzNieprzypisane, filter, dailyCounter, status);
    table.parentNode.insertBefore(toolbar, table);

    const bottomControls = document.createElement('div');
    bottomControls.id = 'semper-list-bottom-controls';
    bottomControls.className = 'semper-list-bottom-controls';
    bottomControls.append(pageSizeLabel, jumpLabel);
    const pagerHost = pager.container || getPagerModel(document).container;
    if (pagerHost) {
      pagerHost.classList?.add('semper-original-pager-host');
      pagerHost.insertBefore(bottomControls, pagerHost.firstChild);
    } else if (table.parentNode) {
      table.parentNode.insertBefore(bottomControls, table.nextSibling);
      bottomControls.classList.add('fallback');
    }
    return toolbar;
  }

  async function enhanceReferenceList() {
    const table = findReferenceTable();
    if (!table || table.dataset.semperOcrV2 === '1') return false;
    table.classList.add('semper-ref-table');
    const listMeta = await expandReferenceTableForPreferredSize(table);
    table.dataset.semperOcrV2 = '1';
    const header = findHeaderRow(table);
    if (!header) return false;

    const headerCells = directCells(header);
    const nameHeader = headerCells.find((c) => ['nazwa:', 'nazwa'].includes(c.textContent.trim().toLowerCase()));
    const naglowekSortowania = headerCells.find((c) => normalizeUiText(c.textContent).startsWith('sortowanie'));
    const naglowekOpcji = headerCells.find((c) => normalizeUiText(c.textContent).includes('opcje'));
    if (!nameHeader) return false;
    const nameVisualIndex = getVisualColumnStart(header, nameHeader);
    const indeksSortowania = getVisualColumnStart(header, naglowekSortowania);
    const indeksOpcji = getVisualColumnStart(header, naglowekOpcji);
    const liczbaKolumnOpcji = Math.max(1, Number(naglowekOpcji?.colSpan) || 1);
    if (nameVisualIndex < 0) return false;
    nameHeader.classList.add('semper-ref-name-header');
    if (naglowekSortowania) naglowekSortowania.classList.add('semper-ref-sort-header');
    if (naglowekOpcji) {
      naglowekOpcji.colSpan = 1;
      naglowekOpcji.textContent = 'Flagi';
      naglowekOpcji.classList.add('semper-ref-flagi-naglowek');
      if (liczbaKolumnOpcji > 1) {
        const naglowekAkcji = document.createElement(naglowekOpcji.tagName.toLowerCase());
        naglowekAkcji.className = 'semper-ref-opcje-naglowek';
        naglowekAkcji.colSpan = liczbaKolumnOpcji - 1;
        naglowekAkcji.textContent = 'Akcje';
        insertAfter(naglowekOpcji, naglowekAkcji);
      }
    }

    const titleHeader = document.createElement('th');
    titleHeader.className = 'semper-ref-title-header';
    titleHeader.textContent = 'Tytuł szkolenia';
    insertAfter(nameHeader, titleHeader);

    const issueDateHeader = document.createElement('th');
    issueDateHeader.className = 'semper-ref-date-header';
    issueDateHeader.textContent = 'Data wystawienia';
    insertAfter(titleHeader, issueDateHeader);

    const catHeader = document.createElement('th');
    catHeader.className = 'semper-ref-category-header';
    catHeader.textContent = 'Kategorie';
    const suggestionHeader = document.createElement('th');
    suggestionHeader.className = 'semper-ref-suggestion-header';
    suggestionHeader.textContent = 'Sugestia';
    const ocrHeader = document.createElement('th');
    ocrHeader.className = 'semper-ref-ocr-header';
    ocrHeader.textContent = 'OCR';
    header.append(catHeader, suggestionHeader, ocrHeader);

    const rows = getDataRows(table, header);
    const jobs = [];
    for (const row of rows) {
      const id = getIdFromRow(row);
      const nameCell = findCellAtVisualColumn(row, nameVisualIndex);
      if (!nameCell) continue;
      findCellAtVisualColumn(row, indeksOpcji)?.classList.add('semper-ref-flagi-komorka');
      findCellAtVisualColumn(row, indeksSortowania)?.classList.add('semper-ref-sort-cell');
      nameCell.classList.add('semper-ref-name-cell');
      przywrocPrzyciskiOpcjiWWierszu(row, indeksOpcji, liczbaKolumnOpcji);

      const titleCell = document.createElement('td');
      titleCell.className = 'semper-ref-title-cell';
      titleCell.innerHTML = '<span class="semper-ref-status-wait">Wczytywanie...</span>';
      insertAfter(nameCell, titleCell);

      const issueDateCell = document.createElement('td');
      issueDateCell.className = 'semper-ref-date-cell';
      issueDateCell.innerHTML = '<span class="semper-ref-status-wait">Niewykryta</span>';
      insertAfter(titleCell, issueDateCell);

      const categoryCell = document.createElement('td');
      categoryCell.className = 'semper-ref-category-cell';
      categoryCell.textContent = 'Sprawdzanie...';
      const suggestionCell = document.createElement('td');
      suggestionCell.className = 'semper-ref-suggestion-cell';
      suggestionCell.textContent = '—';
      const ocrCell = document.createElement('td');
      ocrCell.className = 'semper-ref-ocr-cell semper-ref-status-wait';
      ocrCell.textContent = '—';
      row.append(categoryCell, suggestionCell, ocrCell);

      const editUrl = findReferenceEditUrlInRow(row, id);
      jobs.push({ id, row, editUrl, titleCell, issueDateCell, categoryCell, suggestionCell, ocrCell, record: null, assigned: null });
    }

    wlaczZmianeSzerokosciKolumn(table, header);

    createToolbar(table, jobs, listMeta);

    // Dane lokalne (tytuł/OCR) pokazujemy natychmiast; kategorie pobieramy równolegle z limitem.
    await Promise.all(jobs.map(async (job) => {
      job.record = await getRecord(job.id);
      if (job.record) job.record = await ensureRecordClassification(job.id, job.record);
      setTitleCell(job.titleCell, job.record);
      setIssueDateCell(job.issueDateCell, job.record);
      setSuggestionCell(job.suggestionCell, job.record);
      setOcrCell(job.ocrCell, job.record);
    }));

    await processWithLimit(jobs, 6, async (job) => {
      try {
        job.assigned = await getAssignedCategories(job.id);
        renderPills(job.categoryCell, job.assigned.names, 'Nieprzypisane');
        ustawKolorPrzypisanejReferencji(job);
      } catch (error) {
        job.assigned = { ids: [], names: [] };
        job.categoryCell.textContent = 'Błąd odczytu';
        job.categoryCell.title = String(error?.message || error);
      }
    });
    return true;
  }


  async function enhanceReferenceListWithRetry() {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        if (await enhanceReferenceList()) return true;
      } catch (error) {
        console.warn('[SEMPER OCR] Próba rozszerzenia listy nie powiodła się.', error);
      }
      await sleep(250);
    }
    console.warn('[SEMPER OCR] Nie udało się znaleźć właściwej tabeli referencji w wyznaczonym czasie.');
    return false;
  }

  function removePanel() {
    document.getElementById('semper-ocr-panel')?.remove();
    if (document.body) {
      document.body.classList.remove('semper-ocr-sidebar-active', 'semper-ocr-sidebar-resizing');
      document.body.style.removeProperty('--semper-ocr-sidebar-width');
      document.body.style.removeProperty('--semper-ocr-base-padding-right');
    }
  }

  function makeButton(label, primary = false) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `semper-ocr-btn${primary ? ' primary' : ''}`;
    btn.textContent = label;
    return btn;
  }

  function renderClassification(container, classification, options = {}) {
    const selectedIds = options.selectedIds instanceof Set ? options.selectedIds : new Set();
    const onSelectionChange = typeof options.onSelectionChange === 'function' ? options.onSelectionChange : null;

    container.textContent = '';
    const label = document.createElement('div');
    label.className = 'semper-ocr-label';
    label.textContent = 'Proponowane kategorie:';
    container.appendChild(label);

    const resultItems = classification?.results || [];
    const byId = new Map(resultItems.map((item) => [String(item.id), item]));
    const visible = resultItems.filter((item) => item.score >= 15).slice(0, 8);

    for (const id of selectedIds) {
      if (visible.some((item) => String(item.id) === String(id))) continue;
      const category = CATEGORIES.find((item) => String(item.id) === String(id));
      if (!category) continue;
      visible.push(byId.get(String(id)) || { ...category, score: 0, evidence: {}, hits: [] });
    }

    if (!visible.length) {
      const div = document.createElement('div');
      div.className = 'semper-ocr-status';
      div.textContent = 'Brak wiarygodnych kandydatów. Wymagana decyzja użytkownika.';
      container.appendChild(div);
    } else {
      for (const item of visible) {
        const row = document.createElement('label');
        const isMain = classification?.best?.id === item.id;
        row.className = `semper-ocr-class-row selectable${isMain ? ' main' : ''}`;

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'semper-ocr-class-checkbox';
        checkbox.value = String(item.id);
        checkbox.checked = selectedIds.has(String(item.id));
        checkbox.setAttribute('aria-label', `Wybierz kategorię ${item.name}`);

        const name = document.createElement('span');
        name.className = 'semper-ocr-class-name';
        name.textContent = `${item.name}${isMain ? ' [główna]' : ''}`;
        const evidence = item.evidence || {};
        const evidenceParts = [
          evidence.public ? `oferta SEMPER ${evidence.public}` : '',
          evidence.user ? `Twoje decyzje ${evidence.user}` : '',
          evidence.lexical ? `profil językowy ${evidence.lexical}` : '',
          evidence.domain ? `pojęcia ${evidence.domain}` : '',
          item.hits?.length ? `trafienia: ${item.hits.join(', ')}` : ''
        ].filter(Boolean);
        if (evidenceParts.length) name.title = evidenceParts.join(' · ');

        const score = document.createElement('span');
        score.className = 'semper-ocr-class-score';
        score.textContent = `${item.score}/100`;

        checkbox.addEventListener('change', () => {
          if (checkbox.checked) selectedIds.add(String(item.id));
          else selectedIds.delete(String(item.id));
          row.classList.toggle('selected', checkbox.checked);
          onSelectionChange?.(new Set(selectedIds));
        });
        row.classList.toggle('selected', checkbox.checked);
        row.append(checkbox, name, score);
        container.appendChild(row);
      }
    }

    if (classification?.derivedSuggestions?.length) {
      const derived = document.createElement('div');
      derived.className = 'semper-ocr-derived-suggestions';
      for (const suggestion of classification.derivedSuggestions) {
        const item = document.createElement('div');
        item.className = 'semper-ocr-derived-suggestion';
        item.textContent = `Reguła łączona: ${suggestion.name} (${suggestion.score}/100)${suggestion.note ? ` – ${suggestion.note}` : ''}`;
        derived.appendChild(item);
      }
      container.appendChild(derived);
    }

    const meta = document.createElement('div');
    meta.className = 'semper-ocr-status';
    const topScore = classification?.top?.score || 0;
    meta.textContent = classification?.best
      ? `Pewność: ${classification.level}. Status: ${classification.status}. Zaznaczenia możesz zmienić niezależnie od wyniku procentowego.`
      : `Najlepszy kandydat: ${topScore}/100. Status: Wymaga ręcznej weryfikacji (próg kategorii głównej: 70). Możesz zaznaczyć słabszych kandydatów ręcznie.`;
    container.appendChild(meta);

    const knowledge = classification?.knowledge || knowledgeSummary();
    const sourceMeta = document.createElement('div');
    sourceMeta.className = 'semper-ocr-status';
    sourceMeta.textContent = `Klasyfikator 3.2 · baza SEMPER: ${knowledge.publicCount || 0} wzorców · Twoje zatwierdzone przykłady: ${knowledge.userCount || 0}${knowledge.pending ? ` · do zindeksowania: ${knowledge.pending}` : ''}.`;
    container.appendChild(sourceMeta);

    if (classification?.closestPublic?.title && classification.closestPublic.similarity >= 0.46) {
      const similar = document.createElement('div');
      similar.className = 'semper-ocr-status';
      similar.textContent = `Najbliższy tytuł z oferty SEMPER (${Math.round(classification.closestPublic.similarity * 100)}% podobieństwa): ${classification.closestPublic.title}`;
      similar.title = classification.closestPublic.url || '';
      container.appendChild(similar);
    }
  }

  function defaultAfterSaveSortValue() {
    return localCompactDateKey();
  }

  async function enhanceSortFieldWithAfterSaveControl() {
    if (!location.pathname.endsWith('/wavepanel/ref_adm.php')) return null;
    skompaktujNatywnyFormularzReferencji();
    const sortInput = document.querySelector('input[name="params[sort]"]');
    if (!sortInput) return null;

    let control = document.getElementById('semper-after-save-sort-control');
    if (control) return control.querySelector('input[data-role="after-save-sort"]');

    const today = defaultAfterSaveSortValue();
    const stored = await chrome.storage.local.get(AFTER_SAVE_SORT_KEY);
    const storedValue = stored[AFTER_SAVE_SORT_KEY];
    const initialValue = storedValue && typeof storedValue === 'object' && storedValue.dateKey === today
      ? String(storedValue.value || today).trim() || today
      : today;

    sortInput.classList.add('semper-native-sort-input');

    let wrapper = sortInput.closest('.semper-sort-with-after-save');
    if (!wrapper) {
      wrapper = document.createElement('div');
      wrapper.className = 'semper-sort-with-after-save';
      sortInput.parentNode.insertBefore(wrapper, sortInput);
      wrapper.appendChild(sortInput);
    }

    control = document.createElement('span');
    control.id = 'semper-after-save-sort-control';
    control.className = 'semper-after-save-sort-control';

    const label = document.createElement('label');
    label.className = 'semper-after-save-sort-label';
    label.textContent = 'Po zapisie:';

    const afterSaveInput = document.createElement('input');
    afterSaveInput.type = 'text';
    afterSaveInput.inputMode = 'text';
    afterSaveInput.autocomplete = 'off';
    afterSaveInput.className = 'semper-after-save-sort-input';
    afterSaveInput.dataset.role = 'after-save-sort';
    afterSaveInput.value = initialValue;
    afterSaveInput.placeholder = 'RRMMDD';
    afterSaveInput.title = 'Domyślnie dzisiejsza data w formacie RRMMDD (np. 260728). Tę wartość można ręcznie zmienić przed aktualizacją.';

    afterSaveInput.addEventListener('change', async () => {
      const value = String(afterSaveInput.value || '').trim() || defaultAfterSaveSortValue();
      afterSaveInput.value = value;
      await chrome.storage.local.set({ [AFTER_SAVE_SORT_KEY]: { dateKey: localDateKey(), value } });
    });

    control.append(label, afterSaveInput);
    wrapper.appendChild(control);
    return afterSaveInput;
  }

  async function updateReferenceAndSubmit(afterSaveInput, button) {
    if (!location.pathname.endsWith('/wavepanel/ref_adm.php')) return;
    const sortInput = document.querySelector('input[name="params[sort]"]');
    const form = document.getElementById('forma') || sortInput?.closest('form');
    if (!sortInput || !form) {
      window.alert('Nie znaleziono pola „Sortowanie” lub formularza referencji.');
      return;
    }

    const fallback = defaultAfterSaveSortValue();
    const value = String(afterSaveInput?.value || fallback).trim() || fallback;
    if (afterSaveInput) afterSaveInput.value = value;
    await chrome.storage.local.set({ [AFTER_SAVE_SORT_KEY]: { dateKey: localDateKey(), value } });

    sortInput.value = value;
    sortInput.setAttribute('value', value);
    sortInput.dispatchEvent(new Event('input', { bubbles: true }));
    sortInput.dispatchEvent(new Event('change', { bubbles: true }));

    if (button) {
      button.disabled = true;
      button.textContent = 'Aktualizuję…';
    }

    // Korzystamy z natywnego przycisku Wavepanelu, aby zachować jego standardową logikę zapisu.
    const nativeSave = document.getElementById('todo_add');
    if (nativeSave) {
      nativeSave.click();
      return;
    }

    if (typeof form.requestSubmit === 'function') {
      form.requestSubmit();
      return;
    }
    HTMLFormElement.prototype.submit.call(form);
  }

  async function buildAnalysisPanel(id, imageUrl, initialRecord = null) {
    removePanel();
    const panel = document.createElement('aside');
    panel.id = 'semper-ocr-panel';
    panel.setAttribute('aria-label', `OCR referencji${id ? ` ${id}` : ''}`);

    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'semper-ocr-resize-handle';
    resizeHandle.title = 'Przeciągnij, aby zmienić szerokość panelu';

    const panelHeader = document.createElement('div');
    panelHeader.className = 'semper-ocr-panel-header';
    const heading = document.createElement('h2');
    heading.textContent = `OCR REFERENCJI${id ? ` #${id}` : ''}`;
    const headerActions = document.createElement('div');
    headerActions.className = 'semper-ocr-panel-header-actions';
    const updateReference = makeButton('Zaktualizuj referencje');
    updateReference.classList.add('success', 'semper-ocr-update-reference-btn');
    updateReference.hidden = !location.pathname.endsWith('/wavepanel/ref_adm.php');
    const headerDailyCounter = makeDailyCategoryCounter(true);
    headerDailyCounter.classList.add('semper-ocr-header-daily-counter');
    const collapse = document.createElement('button');
    collapse.type = 'button';
    collapse.className = 'semper-ocr-collapse-btn';
    collapse.setAttribute('aria-label', 'Zwiń panel OCR');
    headerActions.append(updateReference, headerDailyCounter, collapse);
    panelHeader.append(heading, headerActions);

    const panelBody = document.createElement('div');
    panelBody.className = 'semper-ocr-panel-body';

    const titleLabel = document.createElement('div');
    titleLabel.className = 'semper-ocr-label semper-ocr-title-label';
    const titleLabelText = document.createElement('span');
    titleLabelText.textContent = 'Tytuł szkolenia:';
    const titleApprovalBadge = document.createElement('span');
    titleApprovalBadge.className = 'semper-ocr-title-approved-badge';
    titleApprovalBadge.textContent = '✓ Zatwierdzony ręcznie';
    titleApprovalBadge.hidden = true;
    titleLabel.append(titleLabelText, titleApprovalBadge);
    const titleInput = document.createElement('textarea');
    titleInput.className = 'semper-ocr-title-input';
    titleInput.placeholder = 'Wykryty lub ręcznie poprawiony tytuł szkolenia';
    const edytorTytulu = document.createElement('div');
    edytorTytulu.className = 'semper-ocr-edytor-tytulu';
    const titleSaveRow = document.createElement('div');
    titleSaveRow.className = 'semper-ocr-field-save-row';
    const save = makeButton('Zapisz tytuł', true);
    save.classList.add('semper-ocr-save-title-btn');
    titleSaveRow.appendChild(save);
    edytorTytulu.append(titleInput, titleSaveRow);

    const issueDateLabel = document.createElement('div');
    issueDateLabel.className = 'semper-ocr-label semper-ocr-date-label';
    const issueDateLabelText = document.createElement('span');
    issueDateLabelText.textContent = 'Data wystawienia dokumentu:';
    const issueDateApprovalBadge = document.createElement('span');
    issueDateApprovalBadge.className = 'semper-ocr-date-approved-badge';
    issueDateApprovalBadge.textContent = '✓ Zatwierdzona ręcznie';
    issueDateApprovalBadge.hidden = true;
    issueDateLabel.append(issueDateLabelText, issueDateApprovalBadge);
    const issueDateRow = document.createElement('div');
    issueDateRow.className = 'semper-ocr-date-editor';
    const issueDateInput = document.createElement('input');
    issueDateInput.type = 'date';
    issueDateInput.className = 'semper-ocr-date-input';
    const noIssueDateLabel = document.createElement('label');
    noIssueDateLabel.className = 'semper-ocr-no-date';
    const noIssueDate = document.createElement('input');
    noIssueDate.type = 'checkbox';
    noIssueDateLabel.append(noIssueDate, document.createTextNode(' Brak'));
    const saveIssueDate = makeButton('Zapisz datę');
    saveIssueDate.classList.add('semper-ocr-save-date-btn');
    const issueDateHint = document.createElement('span');
    issueDateHint.className = 'semper-ocr-date-hint';
    issueDateRow.append(issueDateInput, noIssueDateLabel, saveIssueDate);

    const status = document.createElement('div');
    status.className = 'semper-ocr-status';
    status.textContent = 'Przygotowanie...';

    const classificationBox = document.createElement('div');
    classificationBox.className = 'semper-ocr-classification';
    const przyciskZapiszIZastosujKategorie = makeButton('Zapisz i zastosuj kategorie [Wybrano: 0]', true);
    przyciskZapiszIZastosujKategorie.classList.add('semper-ocr-zapisz-zastosuj-kategorie');

    const ocrLabel = document.createElement('div');
    ocrLabel.className = 'semper-ocr-label';
    ocrLabel.textContent = 'Pełny tekst OCR:';
    const rerun = makeButton('Uruchom OCR ponownie');
    rerun.classList.add('semper-ocr-rerun-inline');
    const toggleOcr = makeButton('▲ Ukryj OCR');
    toggleOcr.classList.add('semper-ocr-text-toggle');
    toggleOcr.setAttribute('aria-expanded', 'true');
    const ocrSectionHeader = document.createElement('div');
    ocrSectionHeader.className = 'semper-ocr-full-text-header';
    ocrSectionHeader.append(ocrLabel, rerun, toggleOcr);

    const ocrText = document.createElement('div');
    ocrText.className = 'semper-ocr-text';
    ocrText.contentEditable = 'true';
    ocrText.spellcheck = false;
    ocrText.setAttribute('role', 'textbox');
    ocrText.setAttribute('aria-multiline', 'true');
    ocrText.dataset.placeholder = 'Tekst OCR pojawi się tutaj. Jest widoczny domyślnie.';
    const ocrSection = document.createElement('section');
    ocrSection.className = 'semper-ocr-full-text-section';
    ocrSection.append(ocrSectionHeader, ocrText);

    const actions = document.createElement('div');
    actions.className = 'semper-ocr-actions semper-ocr-actions-bottom';
    const useSelection = makeButton('Użyj zaznaczony tytuł');
    useSelection.classList.add('success');
    const useDateSelection = makeButton('Użyj zaznaczoną datę');
    useDateSelection.classList.add('semper-ocr-use-date-selection');
    const selectionActions = document.createElement('div');
    selectionActions.className = 'semper-ocr-selection-actions';
    selectionActions.append(useSelection, useDateSelection);
    actions.append(selectionActions);

    panelBody.append(titleLabel, edytorTytulu, issueDateLabel, issueDateRow, issueDateHint, status, classificationBox, przyciskZapiszIZastosujKategorie, ocrSection);
    panel.append(resizeHandle, panelHeader, panelBody, actions);

    const basePaddingRight = Math.max(0, Number.parseFloat(getComputedStyle(document.body).paddingRight) || 0);
    document.body.style.setProperty('--semper-ocr-base-padding-right', `${basePaddingRight}px`);
    document.body.classList.add('semper-ocr-sidebar-active');
    document.body.appendChild(panel);

    const afterSaveSortInput = await enhanceSortFieldWithAfterSaveControl();
    validateEditFormLayout();
    updateReference.addEventListener('click', () => updateReferenceAndSubmit(afterSaveSortInput, updateReference));

    const ui = await chrome.storage.local.get([PANEL_WIDTH_KEY, PANEL_COLLAPSED_KEY]);
    const maxWidth = () => Math.max(PANEL_MIN_WIDTH, Math.min(920, window.innerWidth - 64));
    let savedWidth = Number(ui[PANEL_WIDTH_KEY]) || PANEL_DEFAULT_WIDTH;
    savedWidth = Math.max(PANEL_MIN_WIDTH, Math.min(maxWidth(), savedWidth));
    panel.style.width = `${savedWidth}px`;

    function applyPageLayoutWidth(width) {
      document.body.style.setProperty('--semper-ocr-sidebar-width', `${Math.round(width)}px`);
    }

    async function setCollapsed(collapsed, persist = true) {
      panel.classList.toggle('collapsed', collapsed);
      applyPageLayoutWidth(collapsed ? PANEL_COLLAPSED_WIDTH : savedWidth);
      collapse.textContent = collapsed ? '‹' : '›';
      collapse.title = collapsed ? 'Rozwiń panel OCR' : 'Zwiń panel OCR';
      collapse.setAttribute('aria-label', collapse.title);
      if (persist) await chrome.storage.local.set({ [PANEL_COLLAPSED_KEY]: collapsed });
    }
    await setCollapsed(Boolean(ui[PANEL_COLLAPSED_KEY]), false);

    collapse.addEventListener('click', () => setCollapsed(!panel.classList.contains('collapsed')));

    resizeHandle.addEventListener('pointerdown', (event) => {
      if (panel.classList.contains('collapsed')) return;
      event.preventDefault();
      panel.classList.add('resizing');
      document.body.classList.add('semper-ocr-sidebar-resizing');
      resizeHandle.setPointerCapture?.(event.pointerId);

      const onMove = (moveEvent) => {
        const width = Math.max(PANEL_MIN_WIDTH, Math.min(maxWidth(), window.innerWidth - moveEvent.clientX));
        savedWidth = width;
        panel.style.width = `${Math.round(width)}px`;
        applyPageLayoutWidth(width);
      };
      const onUp = async (upEvent) => {
        resizeHandle.releasePointerCapture?.(upEvent.pointerId);
        resizeHandle.removeEventListener('pointermove', onMove);
        resizeHandle.removeEventListener('pointerup', onUp);
        resizeHandle.removeEventListener('pointercancel', onUp);
        panel.classList.remove('resizing');
        document.body.classList.remove('semper-ocr-sidebar-resizing');
        await chrome.storage.local.set({ [PANEL_WIDTH_KEY]: Math.round(savedWidth) });
      };
      resizeHandle.addEventListener('pointermove', onMove);
      resizeHandle.addEventListener('pointerup', onUp);
      resizeHandle.addEventListener('pointercancel', onUp);
    });

    window.addEventListener('resize', () => {
      if (panel.classList.contains('collapsed')) return;
      savedWidth = Math.max(PANEL_MIN_WIDTH, Math.min(maxWidth(), savedWidth));
      panel.style.width = `${Math.round(savedWidth)}px`;
      applyPageLayoutWidth(savedWidth);
    });

    await initializeClassifier();
    let record = initialRecord || (id ? await getRecord(id) : null) || {};
    if (record?.title || record?.detectedTitle) record = await ensureRecordClassification(id, record);
    const titleDirtyKey = `title:${id || 'current'}`;
    const ocrDirtyKey = `ocr:${id || 'current'}`;
    const issueDateDirtyKey = `issueDate:${id || 'current'}`;
    const panelCategoriesDirtyKey = `panelCategories:${id || 'current'}`;
    let savedTitleValue = '';
    let approvedTitleValue = '';
    let savedOcrValue = '';
    let savedIssueDateValue = '';
    let savedIssueDateState = 'undetected';
    let approvedIssueDateSignature = '';
    let panelSelectedCategoryIds = new Set();
    let panelSavedCategoryIds = new Set();
    let panelCategorySelectionTouched = false;
    let panelCategorySaving = false;
    let czyKategoriePaneluZatwierdzone = false;

    function sameIdSets(a, b) {
      if (a.size !== b.size) return false;
      return [...a].every((value) => b.has(String(value)));
    }

    function updatePanelCategoryDirtyState() {
      const czyWyborBezZmian = sameIdSets(panelSelectedCategoryIds, panelSavedCategoryIds);
      setDirty(panelCategoriesDirtyKey, !czyWyborBezZmian);
      classificationBox.classList.toggle('manual-approved', czyKategoriePaneluZatwierdzone && czyWyborBezZmian);
    }

    function initializeSuggestedSelection(classification) {
      if (panelCategorySelectionTouched || panelSelectedCategoryIds.size || panelSavedCategoryIds.size) return;
      for (const item of [classification?.best, ...(classification?.additional || [])].filter(Boolean)) {
        panelSelectedCategoryIds.add(String(item.id));
      }
    }

    async function savePanelCategories(selectedIds, button) {
      if (!id) {
        status.className = 'semper-ocr-error';
        status.textContent = 'Nie udało się ustalić ID referencji – kategorii nie można zapisać z tego widoku.';
        return;
      }
      panelCategorySaving = true;
      if (button) button.disabled = true;
      status.className = 'semper-ocr-status';
      status.textContent = 'Zapisuję wybrane kategorie…';
      try {
        const verified = await saveCategoriesForReference(id, [...selectedIds]);
        panelSelectedCategoryIds = new Set((verified.ids || []).map(String));
        panelSavedCategoryIds = new Set(panelSelectedCategoryIds);
        panelCategorySelectionTouched = false;
        czyKategoriePaneluZatwierdzone = true;
        updatePanelCategoryDirtyState();
        if (verified.ids.length) await markCategoryAssignmentToday(id);
        window.dispatchEvent(new CustomEvent('semper-categories-saved', {
          detail: { id: String(id), ids: verified.ids.map(String), names: verified.names || [] }
        }));

        const currentRecord = await getRecord(id) || record || {};
        if (currentRecord?.title || currentRecord?.detectedTitle) {
          const approved = {
            ...currentRecord,
            approvedCategoryIds: verified.ids.map(Number).filter(Boolean),
            approvedCategoryNames: verified.names,
            approvedCategoriesAt: Date.now()
          };
          await saveRecord(id, approved);
          await loadLearnedExamples();
          record = await ensureRecordClassification(id, { ...approved, classifierVersion: '' });
        }

        const inlineSection = document.getElementById('semper-inline-categories');
        if (inlineSection) {
          inlineSection.querySelectorAll('input[type="checkbox"]').forEach((input) => {
            input.checked = panelSavedCategoryIds.has(String(input.value));
          });
          const inlineStatus = inlineSection.querySelector('[data-role="category-status"]');
          if (inlineStatus) {
            inlineStatus.className = 'semper-inline-category-status success';
            inlineStatus.textContent = verified.names.length ? `Zapisano: ${verified.names.length} kategorii` : 'Zapisano brak kategorii.';
          }
        }

        status.className = 'semper-ocr-status';
        status.textContent = verified.names.length
          ? `Zapisano kategorie: ${verified.names.join(', ')}.`
          : 'Zapisano brak kategorii.';
        announceRecordUpdate(id, record);
      } catch (error) {
        status.className = 'semper-ocr-error';
        status.textContent = `Nie udało się zapisać kategorii: ${error?.message || error}`;
      } finally {
        panelCategorySaving = false;
        if (button) button.disabled = false;
        renderPanelClassification(record.classification || classify(titleInput.value, getEditableOcrText(ocrText)));
      }
    }

    function renderPanelClassification(classification) {
      initializeSuggestedSelection(classification);
      przyciskZapiszIZastosujKategorie.textContent = `Zapisz i zastosuj kategorie [Wybrano: ${panelSelectedCategoryIds.size}]`;
      przyciskZapiszIZastosujKategorie.disabled = panelCategorySaving || !id;
      renderClassification(classificationBox, classification, {
        selectedIds: panelSelectedCategoryIds,
        onSelectionChange: (selected) => {
          panelSelectedCategoryIds = selected;
          panelCategorySelectionTouched = true;
          updatePanelCategoryDirtyState();
          przyciskZapiszIZastosujKategorie.textContent = `Zapisz i zastosuj kategorie [Wybrano: ${panelSelectedCategoryIds.size}]`;
        }
      });
    }

    przyciskZapiszIZastosujKategorie.addEventListener('click', async () => {
      const listaKategorii = document.querySelector('select[name="params[lista][]"]');
      if (listaKategorii) {
        for (const opcja of listaKategorii.options) {
          opcja.selected = panelSelectedCategoryIds.has(String(opcja.value));
        }
        listaKategorii.dispatchEvent(new Event('change', { bubbles: true }));
        if (id) await chrome.storage.local.remove(categoryCacheKey(id));
      }
      await savePanelCategories(new Set(panelSelectedCategoryIds), przyciskZapiszIZastosujKategorie);
    });

    function updateTitleApprovalStyle() {
      const current = cleanTitle(titleInput.value);
      const approved = Boolean(approvedTitleValue) && normalize(current) === normalize(approvedTitleValue);
      titleInput.classList.toggle('manual-approved', approved);
      titleApprovalBadge.hidden = !approved;
      titleInput.setAttribute('aria-label', approved ? 'Tytuł szkolenia – zatwierdzony ręcznie' : 'Tytuł szkolenia');
    }

    function currentIssueDateState() {
      return noIssueDate.checked ? 'none' : (issueDateInput.value ? 'date' : 'undetected');
    }

    function currentIssueDateSignature() {
      return `${currentIssueDateState()}:${issueDateInput.value || ''}`;
    }

    function updateIssueDateApprovalStyle() {
      const approved = Boolean(approvedIssueDateSignature) && currentIssueDateSignature() === approvedIssueDateSignature;
      issueDateInput.classList.toggle('manual-approved', approved);
      noIssueDateLabel.classList.toggle('manual-approved', approved && noIssueDate.checked);
      issueDateApprovalBadge.hidden = !approved;
    }

    function updateEditorDirtyState() {
      setDirty(titleDirtyKey, cleanTitle(titleInput.value) !== savedTitleValue);
      setDirty(ocrDirtyKey, getEditableOcrText(ocrText) !== savedOcrValue);
      setDirty(issueDateDirtyKey, issueDateInput.value !== savedIssueDateValue || currentIssueDateState() !== savedIssueDateState);
      updateIssueDateApprovalStyle();
    }

    function displayRecord() {
      titleInput.value = record.manualTitle || record.title || record.detectedTitle || '';
      approvedTitleValue = cleanTitle(record.manualTitle || '');
      updateTitleApprovalStyle();
      const manualHighlight = record.manualTitle
        ? titleInput.value
        : (normalize(titleInput.value) !== normalize(record.detectedTitle || '') ? titleInput.value : '');
      const issueState = record.issueDateState || (record.issueDate ? 'date' : 'undetected');
      issueDateInput.value = issueState === 'date' ? (record.issueDate || '') : '';
      noIssueDate.checked = issueState === 'none';
      issueDateInput.disabled = noIssueDate.checked;
      approvedIssueDateSignature = (record.issueDateSource === 'manual' || record.issueDateApprovedAt)
        ? `${issueState}:${issueState === 'date' ? (record.issueDate || '') : ''}`
        : '';
      issueDateHint.textContent = issueState === 'none'
        ? (approvedIssueDateSignature ? '' : 'Dokument oznaczony jako bez daty wystawienia.')
        : record.issueDate
          ? (record.issueDateSource === 'manual' ? '' : `OCR${record.issueDateConfidence ? ` · ${record.issueDateConfidence}%` : ''}`)
          : 'Niewykryta';
      renderOcrWithHighlights(ocrText, record.ocrText || '', record.detectedTitle || record.title || '', manualHighlight, {
        iso: record.issueDate || '',
        raw: record.issueDateRaw || ''
      });
      savedTitleValue = cleanTitle(titleInput.value);
      savedOcrValue = getEditableOcrText(ocrText);
      savedIssueDateValue = issueDateInput.value;
      savedIssueDateState = currentIssueDateState();
      updateEditorDirtyState();
      const ocrConf = record.ocrConfidence || 0;
      const titleConf = record.titleConfidence || 0;
      status.className = 'semper-ocr-status';
      status.textContent = record.ocrText
        ? `OCR: ${ocrConf}% (${record.ocrVariant || 'wariant domyślny'}) · tytuł: ${titleConf}% · źródło: ${record.titleSource || '—'}`
        : 'Brak zapisanego OCR.';
      renderPanelClassification(record.classification || classify(titleInput.value, getEditableOcrText(ocrText)));
    }

    async function run(force = false) {
      if (!imageUrl) {
        status.className = 'semper-ocr-error';
        status.textContent = 'Nie znaleziono adresu obrazu referencji na tej stronie.';
        return;
      }
      if (!force && record?.ocrText) {
        displayRecord();
        return;
      }
      rerun.disabled = true;
      status.className = 'semper-ocr-status';
      status.textContent = 'Uruchamiam OCR...';
      try {
        const fresh = await analyzeReference(id, imageUrl, (progress) => {
          const percent = Number.isFinite(progress.progress) ? ` ${progress.progress}%` : '';
          status.textContent = `${progress.status || 'OCR'}${percent}`;
        });
        record = fresh;
        displayRecord();
        announceRecordUpdate(id, record);
      } catch (error) {
        status.className = 'semper-ocr-error';
        status.textContent = `Błąd OCR: ${error?.message || error}`;
      } finally {
        rerun.disabled = false;
      }
    }

    save.addEventListener('click', async () => {
      const manualTitle = cleanTitle(titleInput.value);
      const currentOcrText = getEditableOcrText(ocrText);
      const classification = classify(manualTitle, currentOcrText);
      record = {
        ...record,
        manualTitle,
        title: manualTitle,
        titleApprovalSource: 'manual-save',
        titleApprovedAt: Date.now(),
        ocrText: currentOcrText,
        classification,
        classifierVersion: CLASSIFIER_VERSION
      };
      if (id) await saveRecord(id, record);
      titleInput.value = manualTitle;
      renderPanelClassification(classification);
      const manualHighlight = manualTitle || '';
      renderOcrWithHighlights(ocrText, currentOcrText, record.detectedTitle || manualTitle || '', manualHighlight, {
        iso: record.issueDate || issueDateInput.value || '',
        raw: record.issueDateRaw || ''
      }, false);
      approvedTitleValue = cleanTitle(manualTitle);
      savedTitleValue = cleanTitle(manualTitle);
      updateTitleApprovalStyle();
      savedOcrValue = getEditableOcrText(ocrText);
      updateEditorDirtyState();
      status.className = 'semper-ocr-status';
      status.textContent = id ? `Zapisano i ręcznie zatwierdzono tytuł referencji #${id}.` : 'Tytuł zatwierdzono ręcznie, ale nie udało się ustalić ID referencji.';
      announceRecordUpdate(id, record);
    });

    async function persistIssueDate(source = 'manual-save', selectedRaw = '') {
      const issueState = currentIssueDateState();
      record = {
        ...record,
        issueDate: issueState === 'date' ? issueDateInput.value : '',
        issueDateState: issueState,
        issueDateSource: issueState === 'undetected' ? '' : 'manual',
        issueDateConfidence: issueState === 'date' ? 100 : 0,
        issueDateRaw: issueState === 'date' ? (selectedRaw || record.issueDateRaw || issueDateInput.value) : '',
        issueDateApprovalSource: source,
        issueDateApprovedAt: Date.now()
      };
      if (id) await saveRecord(id, record);
      savedIssueDateValue = issueDateInput.value;
      savedIssueDateState = issueState;
      approvedIssueDateSignature = currentIssueDateSignature();
      issueDateHint.textContent = '';
      updateEditorDirtyState();
      renderOcrWithHighlights(ocrText, getEditableOcrText(ocrText), record.detectedTitle || record.title || '', record.manualTitle || '', {
        iso: record.issueDate || '',
        raw: record.issueDateRaw || ''
      }, false);
      status.className = 'semper-ocr-status';
      status.textContent = issueState === 'none'
        ? `Zatwierdzono ręcznie brak daty wystawienia${id ? ` dla referencji #${id}` : ''}.`
        : issueState === 'date'
          ? `Zapisano i ręcznie zatwierdzono datę ${formatIssueDate(issueDateInput.value)}${id ? ` dla referencji #${id}` : ''}.`
          : 'Data pozostaje niewykryta.';
      announceRecordUpdate(id, record);
    }

    saveIssueDate.addEventListener('click', () => persistIssueDate('manual-save'));

    rerun.addEventListener('click', () => run(true));
    useSelection.addEventListener('click', async () => {
      const selection = window.getSelection?.();
      const anchorInside = selection?.anchorNode && ocrText.contains(selection.anchorNode);
      const focusInside = selection?.focusNode && ocrText.contains(selection.focusNode);
      const selectedText = anchorInside && focusInside ? String(selection.toString() || '').trim() : '';
      if (!selectedText) {
        status.textContent = 'Najpierw zaznacz fragment tytułu w polu pełnego OCR.';
        return;
      }

      const manualTitle = cleanTitle(selectedText);
      titleInput.value = manualTitle;
      const currentOcrText = getEditableOcrText(ocrText);
      const classification = classify(manualTitle, currentOcrText);
      record = {
        ...record,
        manualTitle,
        title: manualTitle,
        titleApprovalSource: 'ocr-selection',
        titleApprovedAt: Date.now(),
        classification,
        classifierVersion: CLASSIFIER_VERSION
      };
      if (id) await saveRecord(id, record);

      approvedTitleValue = manualTitle;
      savedTitleValue = manualTitle;
      updateTitleApprovalStyle();
      renderPanelClassification(classification);
      renderOcrWithHighlights(ocrText, currentOcrText, record.detectedTitle || '', manualTitle, {
        iso: record.issueDate || issueDateInput.value || '',
        raw: record.issueDateRaw || ''
      }, false);
      updateEditorDirtyState();
      status.className = 'semper-ocr-status';
      status.textContent = id
        ? `Zatwierdzono zaznaczony tytuł i zapisano go dla referencji #${id}.`
        : 'Zatwierdzono zaznaczony tytuł.';
      announceRecordUpdate(id, record);
    });

    useDateSelection.addEventListener('click', async () => {
      const selection = window.getSelection?.();
      const anchorInside = selection?.anchorNode && ocrText.contains(selection.anchorNode);
      const focusInside = selection?.focusNode && ocrText.contains(selection.focusNode);
      const selectedText = anchorInside && focusInside ? String(selection.toString() || '').trim() : '';
      if (!selectedText) {
        status.textContent = 'Najpierw zaznacz datę w polu pełnego OCR.';
        return;
      }
      const parsed = parseSelectedIssueDate(selectedText);
      if (!parsed?.iso) {
        status.className = 'semper-ocr-error';
        status.textContent = 'Zaznaczony fragment nie wygląda jak prawidłowa data (np. 17.01.2020, 2020-01-17 albo 17 stycznia 2020).';
        return;
      }
      issueDateInput.value = parsed.iso;
      issueDateInput.disabled = false;
      noIssueDate.checked = false;
      await persistIssueDate('ocr-selection', parsed.raw || selectedText);
    });

    toggleOcr.addEventListener('click', () => {
      const hidden = ocrText.hidden;
      ocrText.hidden = !hidden;
      toggleOcr.textContent = hidden ? '▲ Ukryj OCR' : '▼ Pokaż OCR';
      toggleOcr.setAttribute('aria-expanded', hidden ? 'true' : 'false');
    });
    issueDateInput.addEventListener('input', () => {
      if (issueDateInput.value) noIssueDate.checked = false;
      issueDateInput.disabled = false;
      issueDateHint.textContent = issueDateInput.value ? 'Niezapisana zmiana – kliknij „Zapisz datę”.' : 'Niewykryta';
      updateEditorDirtyState();
    });
    noIssueDate.addEventListener('change', () => {
      issueDateInput.disabled = noIssueDate.checked;
      if (noIssueDate.checked) {
        issueDateInput.value = '';
        issueDateHint.textContent = 'Brak daty – kliknij „Zapisz datę”.';
      } else {
        issueDateHint.textContent = issueDateInput.value ? 'Niezapisana zmiana – kliknij „Zapisz datę”.' : 'Niewykryta';
      }
      updateEditorDirtyState();
    });

    titleInput.addEventListener('input', () => {
      const currentOcrText = getEditableOcrText(ocrText);
      const previewClassification = classify(titleInput.value, currentOcrText);
      renderPanelClassification(previewClassification);
      updateEditorDirtyState();
      updateTitleApprovalStyle();
      const manualHighlight = approvedTitleValue && normalize(titleInput.value) === normalize(approvedTitleValue) ? titleInput.value : '';
      renderOcrWithHighlights(ocrText, currentOcrText, record.detectedTitle || '', manualHighlight, {
        iso: record.issueDate || '',
        raw: record.issueDateRaw || ''
      }, false);
      announceRecordUpdate(id, { ...record, title: titleInput.value, classification: previewClassification });
    });
    ocrText.addEventListener('input', () => {
      updateEditorDirtyState();
    });

    if (id) {
      try {
        const assigned = await getAssignedCategories(id);
        panelSavedCategoryIds = new Set((assigned?.ids || []).map(String));
        panelSelectedCategoryIds = new Set(panelSavedCategoryIds);
        czyKategoriePaneluZatwierdzone = panelSavedCategoryIds.size > 0;
        updatePanelCategoryDirtyState();
      } catch (error) {
        console.warn('[SEMPER OCR] Nie udało się wczytać zapisanych kategorii do panelu OCR.', error);
      }

      window.addEventListener('semper-categories-saved', (event) => {
        if (String(event.detail?.id || '') !== String(id)) return;
        panelSavedCategoryIds = new Set((event.detail?.ids || []).map(String));
        panelSelectedCategoryIds = new Set(panelSavedCategoryIds);
        panelCategorySelectionTouched = false;
        czyKategoriePaneluZatwierdzone = true;
        updatePanelCategoryDirtyState();
        const currentClassification = record?.classification || classify(titleInput.value, getEditableOcrText(ocrText));
        renderPanelClassification(currentClassification);
      });
    }

    await run(false);
  }

  async function handleImageOrEditPage() {
    const id = getCurrentId();
    let imageUrl = location.pathname.includes('/__template/img/upload/') ? location.href : findImageUrlInDocument(document);
    if (!imageUrl && id) imageUrl = await fetchImageUrlForReference(id);
    let initialRecord = id ? await getRecord(id) : null;
    if (initialRecord) initialRecord = await ensureRecordClassification(id, initialRecord);

    if (location.pathname.endsWith('/wavepanel/ref_adm.php') && id) {
      utrzymajNatywnyEdytorOpisuUkryty(imageUrl);
      const results = await Promise.allSettled([
        buildAnalysisPanel(id, imageUrl, initialRecord),
        buildInlineCategoryEditor(id)
      ]);
      for (const result of results) {
        if (result.status === 'rejected') console.warn('[SEMPER OCR] Nie udało się zbudować części interfejsu edycji:', result.reason);
      }
      return;
    }

    await buildAnalysisPanel(id, imageUrl, initialRecord);
  }

  async function handleCategoryPage() {
    const id = getCurrentId();
    if (!id) return;
    let record = await getRecord(id);
    if (record) record = await ensureRecordClassification(id, record);
    let imageUrl = record?.imageUrl || await fetchImageUrlForReference(id);
    utworzLubAktualizujPodgladOryginalu(imageUrl);
    if (!record?.ocrText) {
      if (imageUrl) {
        try { record = await analyzeReference(id, imageUrl); } catch (error) { console.warn('[SEMPER OCR]', error); }
      }
    }
    imageUrl = record?.imageUrl || imageUrl;
    utworzLubAktualizujPodgladOryginalu(imageUrl);
    await buildAnalysisPanel(id, imageUrl, record);

    const panel = document.getElementById('semper-ocr-panel');
    const select = document.querySelector('select[name="params[lista][]"]');
    if (!panel || !select) return;


    const pendingLearningKey = `semper_category_learning_pending_${id}`;
    if (sessionStorage.getItem(pendingLearningKey) === '1' && record?.title) {
      try {
        const assigned = await getAssignedCategories(id, true);
        record = {
          ...record,
          approvedCategoryIds: assigned.ids.map(Number).filter(Boolean),
          approvedCategoryNames: assigned.names,
          approvedCategoriesAt: Date.now()
        };
        await saveRecord(id, record);
        await loadLearnedExamples();
        record = await ensureRecordClassification(id, { ...record, classifierVersion: '' });
        sessionStorage.removeItem(pendingLearningKey);
      } catch (error) {
        console.warn('[SEMPER OCR] Nie udało się zapisać decyzji kategorii jako przykładu uczącego.', error);
      }
    }

    const invalidateCategoryCache = () => {
      chrome.storage.local.remove(categoryCacheKey(id)).catch((error) => {
        console.warn('[SEMPER OCR] Nie udało się unieważnić cache kategorii', id, error);
      });
    };
    select.addEventListener('change', invalidateCategoryCache);
    const categoryForm = select.closest('form');
    categoryForm?.addEventListener('submit', () => {
      invalidateCategoryCache();
      sessionStorage.setItem(pendingLearningKey, '1');
      const requestedIds = [...select.options]
        .filter((option) => option.selected)
        .map((option) => String(option.value || ''))
        .filter(Boolean);
      sessionStorage.setItem(PENDING_CATEGORY_SAVE_KEY, JSON.stringify({
        id: String(id),
        requestedIds,
        submittedAt: Date.now()
      }));
    }, { capture: true });

  }

  async function boot() {
    try {
      const stanWtyczki = (await chrome.storage.local.get(KLUCZ_STANU_WTYCZKI))[KLUCZ_STANU_WTYCZKI];
      const wylaczenieBezterminowe = stanWtyczki?.tryb === 'bezterminowo';
      const wylaczenieCzasowe = stanWtyczki?.tryb === 'czasowo'
        && Number(stanWtyczki.wylaczoneDo) > Date.now();
      if (wylaczenieCzasowe) {
        const opoznienie = Math.min(Number(stanWtyczki.wylaczoneDo) - Date.now() + 250, 2147483647);
        setTimeout(() => location.reload(), opoznienie);
      }
      if (wylaczenieBezterminowe || wylaczenieCzasowe) return;

      await processPendingCategorySaveCounter();
      if (location.pathname.endsWith('/wavepanel/ref.php')) {
        if (await continuePendingListPageJump()) return;
        await initializeClassifier();
        await enhanceReferenceListWithRetry();
        return;
      }
      await initializeClassifier();
      if (location.pathname.endsWith('/wavepanel/ref_kat.php')) {
        await handleCategoryPage();
        return;
      }
      if (location.pathname.endsWith('/wavepanel/ref_adm.php') || location.pathname.includes('/__template/img/upload/')) {
        await handleImageOrEditPage();
      }
    } catch (error) {
      console.error('[SEMPER OCR] Błąd uruchomienia', error);
    }
  }

  chrome.storage.onChanged.addListener((zmiany, obszar) => {
    if (obszar === 'local' && zmiany[KLUCZ_STANU_WTYCZKI]) location.reload();
  });

  boot();
})();
