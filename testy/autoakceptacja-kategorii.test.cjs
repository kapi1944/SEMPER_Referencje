const asercja = require('node:assert/strict');
const systemPlikow = require('node:fs');
const sciezka = require('node:path');
const maszynaWirtualna = require('node:vm');

const sciezkaSkryptu = sciezka.join(__dirname, '..', 'content', 'content.js');
const sciezkaPopupu = sciezka.join(__dirname, '..', 'popup', 'popup.js');
const sciezkaHtmlPopupu = sciezka.join(__dirname, '..', 'popup', 'popup.html');
const kod = systemPlikow.readFileSync(sciezkaSkryptu, 'utf8');
const kodPopupu = systemPlikow.readFileSync(sciezkaPopupu, 'utf8');
const htmlPopupu = systemPlikow.readFileSync(sciezkaHtmlPopupu, 'utf8');
const kontekst = {
  console: { warn() {}, error() {}, debug() {}, log() {} },
  setTimeout() { return 0; },
  clearTimeout() {},
  chrome: {
    storage: {
      local: {
        async get(klucz) { return { [klucz]: { tryb: 'bezterminowo' } }; }
      },
      onChanged: { addListener() {} }
    }
  },
  addEventListener() {},
  postMessage() {}
};
kontekst.window = kontekst;

maszynaWirtualna.runInNewContext(kod, kontekst, { filename: sciezkaSkryptu });
const {
  ocenWarunkiAutoakceptacji,
  sprobujAutomatycznieZatwierdzicKategorie,
  KONFIGURACJA_AUTOAKCEPTACJI,
  wyliczStanReferencji,
  zbudujIndeksZnanychSzkolen,
  znajdzZnaneSzkolenie,
  obliczWynikiZatwierdzonychPrzykladow
} = kontekst.__SEMPER_CLASSIFIER_V3__;

const konfiguracjaWlaczona = { ...KONFIGURACJA_AUTOAKCEPTACJI, wlaczona: true };
asercja.deepEqual(JSON.parse(JSON.stringify(KONFIGURACJA_AUTOAKCEPTACJI)), {
  wlaczona: false,
  minimalnaPewnoscOcr: 95,
  minimalnaPewnoscTytulu: 95,
  minimalnyWynikKategoriiGlownej: 95,
  minimalnaPrzewagaPunktowProcentowych: 15
}, 'wszystkie progi mają jedno centralne źródło');

function utworzRekord({
  wynikGlowny = 98,
  wynikDrugi = 60,
  pewnoscOcr = 98,
  pewnoscTytulu = 98,
  stanKlasyfikacji = 'Sklasyfikowana',
  konflikt = false,
  bezDrugiego = false
} = {}) {
  const glowna = { id: 11, name: 'budownictwo', score: wynikGlowny };
  const druga = bezDrugiego ? null : { id: 8, name: 'prawo', score: wynikDrugi };
  return {
    imageUrl: 'https://www.szkolenia-semper.pl/referencja.jpg',
    ocrText: 'REFERENCJE\nPrawo budowlane – najnowsze zmiany',
    ocrConfidence: pewnoscOcr,
    ocrVariant: 'kontrast',
    ocrAttempts: [{ variant: 'kontrast', confidence: pewnoscOcr, quality: 100, length: 240 }],
    ocrZakonczonyAt: 100,
    bladOcr: '',
    detectedTitle: 'Prawo budowlane – najnowsze zmiany',
    title: 'Prawo budowlane – najnowsze zmiany',
    titleConfidence: pewnoscTytulu,
    titleSource: 'linia-tematyczna',
    titleCandidates: [{ title: 'Prawo budowlane – najnowsze zmiany', score: 100, source: 'linia-tematyczna' }],
    classifierVersion: '3.2.6',
    klasyfikacjaUtworzonaAt: 100,
    classification: {
      version: '3.2.6',
      title: 'Prawo budowlane – najnowsze zmiany',
      best: glowna,
      top: glowna,
      second: druga,
      additional: druga ? [druga, { ...druga }] : [],
      results: druga ? [glowna, druga] : [glowna],
      status: stanKlasyfikacji,
      znaneSzkolenie: { znaleziono: konflikt, konflikt, dopasowania: [] }
    }
  };
}

function ocen(rekord, dodatkowe = {}) {
  return ocenWarunkiAutoakceptacji(rekord, {
    konfiguracja: konfiguracjaWlaczona,
    ...dodatkowe
  });
}

const bardzoPewny = utworzRekord();
asercja.equal(ocenWarunkiAutoakceptacji(bardzoPewny).powod, 'funkcja-wylaczona', 'funkcja jest domyślnie wyłączona');
asercja.equal(ocen(bardzoPewny).mozliwa, true, '98% / TOP2 60% / dobry OCR może przejść');
asercja.deepEqual(JSON.parse(JSON.stringify(ocen(bardzoPewny).identyfikatoryKategorii)), ['11', '8'], 'kategorie nie są duplikowane');

asercja.equal(ocen(utworzRekord({ wynikGlowny: 95, wynikDrugi: 80, pewnoscOcr: 95, pewnoscTytulu: 95 })).mozliwa, true, 'wszystkie progi są domknięte');
asercja.equal(ocen(utworzRekord({ pewnoscOcr: 95 })).mozliwa, true, 'OCR równy 95% przechodzi');
asercja.equal(ocen(utworzRekord({ pewnoscTytulu: 95 })).mozliwa, true, 'wykrycie tytułu równe 95% przechodzi');
asercja.equal(ocen(utworzRekord({ wynikGlowny: 95 })).mozliwa, true, 'TOP1 równy 95% przechodzi');
asercja.equal(ocen(utworzRekord({ wynikGlowny: 95, wynikDrugi: 81 })).powod, 'za-mala-przewaga', '14 p.p. nie wystarcza');
asercja.equal(ocen(utworzRekord({ wynikGlowny: 96, wynikDrugi: 93 })).mozliwa, false, '96% / 93% nie przechodzi');
asercja.equal(ocen(utworzRekord({ wynikGlowny: 94 })).powod, 'za-slaba-kategoria-glowna', 'TOP1 94% nie przechodzi');
asercja.equal(ocen(utworzRekord({ pewnoscOcr: 94 })).powod, 'za-slaby-ocr', 'OCR poniżej 95% blokuje');
asercja.equal(ocen(utworzRekord({ pewnoscTytulu: 94 })).powod, 'za-slabe-wykrycie-tytulu', 'wykrycie tytułu poniżej 95% blokuje');
asercja.equal(ocen(utworzRekord({ konflikt: true })).powod, 'konflikt-historyczny', 'konflikt historii blokuje');
asercja.equal(ocen(utworzRekord({ stanKlasyfikacji: 'Wymaga decyzji' })).powod, 'wymaga-decyzji', 'stan Wymaga decyzji blokuje');
asercja.equal(ocen(utworzRekord({ bezDrugiego: true })).mozliwa, true, 'brak TOP2 nie tworzy sztucznej metryki');

const zBledemOcr = { ...bardzoPewny, bladOcr: 'awaria OCR' };
asercja.equal(ocen(zBledemOcr).powod, 'blad-ocr');
const zRecznymTytulem = { ...bardzoPewny, manualTitle: bardzoPewny.title };
asercja.equal(ocen(zRecznymTytulem).powod, 'tytul-reczny', 'auto-akceptacja wymaga automatycznie wykrytego tytułu');
const niepelny = { ...bardzoPewny, ocrAttempts: [] };
asercja.equal(ocen(niepelny).powod, 'niepelne-dane', 'brak pełnego śladu OCR blokuje');
asercja.equal(ocen({ ...bardzoPewny, ocrAttempts: {} }).powod, 'niepelne-dane', 'uszkodzony ślad OCR blokuje bez wyjątku');
asercja.equal(ocen(bardzoPewny, { przypisaneKategorie: { ids: ['11'], names: ['budownictwo'] } }).powod, 'istniejace-kategorie', 'istniejące kategorie nie są nadpisywane');
asercja.equal(ocen({ ...bardzoPewny, approvedCategoriesAt: 123 }).powod, 'juz-zatwierdzona', 'ponowne uruchomienie nie zatwierdza drugi raz');
asercja.equal(ocen(utworzRekord({ wynikGlowny: 94, pewnoscOcr: 94, konflikt: true })).mozliwa, false, 'kombinacja kilku blokad pozostaje bezpieczna');

const stanAutomatyczny = wyliczStanReferencji({
  rekord: {
    ...bardzoPewny,
    approvedCategoryIds: [11, 8],
    approvedCategoriesAt: 200,
    zrodloZatwierdzeniaKategorii: 'automatyczne'
  },
  przypisaneKategorie: { ids: ['11', '8'], names: ['budownictwo', 'prawo'] }
});
asercja.equal(stanAutomatyczny.klucz, 'auto-zatwierdzona', 'UI rozpoznaje auto-akceptację');
const stanBleduZapisu = wyliczStanReferencji({
  rekord: { ...bardzoPewny, bladAutoakceptacji: 'awaria backendu' },
  przypisaneKategorie: { ids: [], names: [] }
});
asercja.equal(stanBleduZapisu.klucz, 'wymaga-decyzji', 'błąd zapisu nie daje statusu sukcesu');

const wynikiTylkoAutomatyczne = obliczWynikiZatwierdzonychPrzykladow([{
  podobienstwo: 1,
  kategorie: [11],
  zrodloZatwierdzenia: 'automatyczne'
}]);
asercja.equal(wynikiTylkoAutomatyczne.size, 0, 'auto-akceptacja nie wzmacnia klasyfikatora');
const konfliktZDecyzjaAutomatyczna = znajdzZnaneSzkolenie(bardzoPewny.title, zbudujIndeksZnanychSzkolen([
  { id: 'r', title: bardzoPewny.title, categories: [11], approvedAt: 1, zrodloZatwierdzenia: 'reczne' },
  { id: 'a', title: bardzoPewny.title, categories: [37], approvedAt: 2, zrodloZatwierdzenia: 'automatyczne' }
]));
asercja.equal(konfliktZDecyzjaAutomatyczna.konflikt, true, 'auto-akceptacja pozostaje widoczna dla wykrywania konfliktów');

async function sprawdzSciezkeZapisu() {
  let liczbaZapisow = 0;
  let liczbaUtrwalen = 0;
  const zaleznosci = {
    konfiguracja: konfiguracjaWlaczona,
    async pobierzPrzypisaneKategorie() { return { ids: [], names: [] }; },
    async zapiszKategorie(identyfikator, identyfikatoryKategorii) {
      liczbaZapisow += 1;
      asercja.equal(identyfikator, 'nowa');
      asercja.deepEqual(JSON.parse(JSON.stringify(identyfikatoryKategorii)), ['11', '8']);
      return { ids: ['11', '8'], names: ['budownictwo', 'prawo'] };
    },
    async utrwalKategorie(identyfikator, zweryfikowane, rekord, opcje) {
      liczbaUtrwalen += 1;
      asercja.equal(opcje.zrodloZatwierdzenia, 'automatyczne');
      return {
        ...rekord,
        approvedCategoryIds: zweryfikowane.ids.map(Number),
        approvedCategoriesAt: 200,
        zrodloZatwierdzeniaKategorii: opcje.zrodloZatwierdzenia
      };
    }
  };

  const zatwierdzony = await sprobujAutomatycznieZatwierdzicKategorie('nowa', bardzoPewny, zaleznosci);
  asercja.equal(zatwierdzony.zrodloZatwierdzeniaKategorii, 'automatyczne');
  asercja.equal(liczbaZapisow, 1);
  asercja.equal(liczbaUtrwalen, 1);

  await sprobujAutomatycznieZatwierdzicKategorie('nowa', zatwierdzony, zaleznosci);
  asercja.equal(liczbaZapisow, 1, 'odświeżenie lub ponowne wywołanie nie zapisuje ponownie');

  let utrwaleniaPoBledzie = 0;
  await asercja.rejects(
    sprobujAutomatycznieZatwierdzicKategorie('blad', bardzoPewny, {
      ...zaleznosci,
      async zapiszKategorie() { throw new Error('awaria backendu'); },
      async utrwalKategorie() { utrwaleniaPoBledzie += 1; }
    }),
    /awaria backendu/
  );
  asercja.equal(utrwaleniaPoBledzie, 0, 'błąd serwera nie tworzy lokalnego statusu sukcesu');

  let zapisyRownolegle = 0;
  const zaleznosciRownolegle = {
    ...zaleznosci,
    async zapiszKategorie() {
      zapisyRownolegle += 1;
      await Promise.resolve();
      return { ids: ['11', '8'], names: ['budownictwo', 'prawo'] };
    }
  };
  await Promise.all([
    sprobujAutomatycznieZatwierdzicKategorie('rownolegle', bardzoPewny, zaleznosciRownolegle),
    sprobujAutomatycznieZatwierdzicKategorie('rownolegle', bardzoPewny, zaleznosciRownolegle)
  ]);
  asercja.equal(zapisyRownolegle, 1, 'równoległe wywołania dla rekordu są idempotentne');
}

asercja.match(kod, /await saveRecord\(id, record\);\s*try \{\s*record = await sprobujAutomatycznieZatwierdzicKategorie\(id, record\)/, 'auto-akceptacja działa dopiero po świeżym OCR');
asercja.match(kod, /zrodloZatwierdzeniaKategorii: zrodloZatwierdzenia/, 'stan rozróżnia auto i manual');
asercja.match(kod, /bladAutoakceptacji/, 'błąd zapisu ma osobny stan bez fałszywego sukcesu');
asercja.match(kodPopupu, /semper_autoakceptacja_kategorii_v1/);
asercja.match(htmlPopupu, /id="autoakceptacja-kategorii"/);

sprawdzSciezkeZapisu()
  .then(() => console.log('OK: bezpieczna auto-akceptacja kategorii.'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
