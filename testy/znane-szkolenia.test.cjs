const asercja = require('node:assert/strict');
const systemPlikow = require('node:fs');
const sciezka = require('node:path');
const maszynaWirtualna = require('node:vm');

const sciezkaSkryptu = sciezka.join(__dirname, '..', 'content', 'content.js');
const kod = systemPlikow.readFileSync(sciezkaSkryptu, 'utf8');
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
  normalizujTytulZnaneSzkolenie,
  zbudujIndeksZnanychSzkolen,
  znajdzZnaneSzkolenie
} = kontekst.__SEMPER_CLASSIFIER_V3__;

const historia = [{
  id: '101',
  title: 'Prawo budowlane – najnowsze zmiany 2025',
  categories: [11, 8],
  categoryNames: ['budownictwo', 'prawo'],
  approvedAt: 123456
}];
const indeks = zbudujIndeksZnanychSzkolen(historia);

const dokladne = znajdzZnaneSzkolenie('Prawo budowlane – najnowsze zmiany 2025', indeks);
asercja.equal(dokladne.znaleziono, true, 'identyczny tytuł zostaje znaleziony');
asercja.equal(dokladne.rodzaj, 'dokladne');
asercja.equal(dokladne.podtyp, 'identyczne');
asercja.equal(dokladne.podobienstwo, 1);
asercja.deepEqual(JSON.parse(JSON.stringify(dokladne.kategorie)), [11, 8]);
asercja.deepEqual(JSON.parse(JSON.stringify(dokladne.nazwyKategorii)), ['budownictwo', 'prawo']);

const poNormalizacji = znajdzZnaneSzkolenie('  PRAWO   BUDOWLANE - NAJNOWSZE ZMIANY 2025  ', indeks);
asercja.equal(poNormalizacji.znaleziono, true, 'wielkość liter, odstępy i separator nie blokują dopasowania');
asercja.equal(poNormalizacji.rodzaj, 'dokladne');
asercja.equal(poNormalizacji.podtyp, 'po-normalizacji');
asercja.equal(
  normalizujTytulZnaneSzkolenie('  PRAWO   BUDOWLANE - NAJNOWSZE ZMIANY 2025  '),
  normalizujTytulZnaneSzkolenie(historia[0].title)
);

const drobnaRoznica = znajdzZnaneSzkolenie('Prawo budowlane – najważniejsze zmiany w 2025 roku', indeks);
asercja.equal(drobnaRoznica.znaleziono, true, 'drobna różnica słowna może utworzyć near-match');
asercja.equal(drobnaRoznica.rodzaj, 'przyblizone');
asercja.ok(drobnaRoznica.podobienstwo >= 0.72 && drobnaRoznica.podobienstwo < 1);

const zmienionyRok = znajdzZnaneSzkolenie('Prawo budowlane – najnowsze zmiany 2026', indeks);
asercja.equal(zmienionyRok.znaleziono, true, 'zmieniony rok pozostaje dopasowaniem przybliżonym');
asercja.equal(zmienionyRok.rodzaj, 'przyblizone');

const innyTemat = znajdzZnaneSzkolenie('Prawo energetyczne – najnowsze zmiany 2025', indeks);
asercja.equal(innyTemat.znaleziono, false, 'podobny szablon nazwy z innym tematem nie tworzy dopasowania');

const brakDopasowania = znajdzZnaneSzkolenie('Skuteczne negocjacje handlowe z klientem', indeks);
asercja.equal(brakDopasowania.znaleziono, false, 'wyraźnie inne szkolenie nie jest znanym szkoleniem');

const historiaUnijna = zbudujIndeksZnanychSzkolen([
  {
    id: '201',
    title: 'Rozliczanie projektów unijnych oraz kwalifikowalność wydatków – edycja 2024',
    categories: [13],
    categoryNames: ['tematyka unijna'],
    approvedAt: 201
  },
  {
    id: '202',
    title: 'Rozliczanie projektów unijnych oraz kwalifikowalność wydatków – edycja 2025',
    categories: [13],
    categoryNames: ['tematyka unijna'],
    approvedAt: 202
  },
  {
    id: '203',
    title: 'Rozliczanie projektów unijnych oraz kwalifikowalność wydatków – najnowsza wersja 2025',
    categories: [13],
    categoryNames: ['tematyka unijna'],
    approvedAt: 203
  }
]);
const kilkaPrzyblizonych = znajdzZnaneSzkolenie(
  'Rozliczanie projektów unijnych oraz kwalifikowalność wydatków – edycja 2026',
  historiaUnijna
);
asercja.equal(kilkaPrzyblizonych.rodzaj, 'przyblizone');
asercja.equal(kilkaPrzyblizonych.dopasowania.length, 3, 'zwracanych jest kilka najlepszych near-matchy');
asercja.equal(kilkaPrzyblizonych.zgodnoscPelna, true);
asercja.equal(kilkaPrzyblizonych.wiekszosc.liczba, 3);
asercja.deepEqual(JSON.parse(JSON.stringify(kilkaPrzyblizonych.kategorie)), [13]);

const indeksPrzedZatwierdzeniem = zbudujIndeksZnanychSzkolen([]);
asercja.equal(znajdzZnaneSzkolenie(historia[0].title, indeksPrzedZatwierdzeniem).znaleziono, false);
const indeksPoZatwierdzeniu = zbudujIndeksZnanychSzkolen(historia);
asercja.equal(
  znajdzZnaneSzkolenie(historia[0].title, indeksPoZatwierdzeniu).znaleziono,
  true,
  'nowo zatwierdzony rekord jest dostępny po odświeżeniu lokalnego indeksu'
);

const historiaSprzeczna = zbudujIndeksZnanychSzkolen([
  ...historia,
  {
    id: '102',
    title: 'PRAWO BUDOWLANE – NAJNOWSZE ZMIANY 2025',
    categories: [37, 8],
    categoryNames: ['prawo energetyczne', 'prawo'],
    approvedAt: 123457
  }
]);
const konflikt = znajdzZnaneSzkolenie(historia[0].title, historiaSprzeczna);
asercja.equal(konflikt.znaleziono, true);
asercja.equal(konflikt.konflikt, true, 'sprzeczne zatwierdzone kategorie są ujawniane');
asercja.equal(konflikt.grupyKategorii.length, 2);
asercja.deepEqual(JSON.parse(JSON.stringify(konflikt.kategorie)), [], 'konflikt nie wybiera arbitralnie jednego zestawu');
asercja.equal(konflikt.dopasowania.length, 2);
asercja.equal(konflikt.wiekszosc, null, 'remis sprzecznych decyzji nie jest przedstawiany jako większość');

const konfliktZWiekoscia = znajdzZnaneSzkolenie(historia[0].title, zbudujIndeksZnanychSzkolen([
  ...historia,
  {
    id: '104',
    title: historia[0].title,
    categories: [11, 8],
    categoryNames: ['budownictwo', 'prawo'],
    approvedAt: 123458
  },
  {
    id: '105',
    title: historia[0].title,
    categories: [37, 8],
    categoryNames: ['prawo energetyczne', 'prawo'],
    approvedAt: 123459
  }
]));
asercja.equal(konfliktZWiekoscia.konflikt, true);
asercja.equal(konfliktZWiekoscia.wiekszosc.liczba, 2, 'konflikt pokazuje liczebność większości');
asercja.equal(konfliktZWiekoscia.wiekszosc.zeWszystkich, 3);
asercja.deepEqual(JSON.parse(JSON.stringify(konfliktZWiekoscia.wiekszosc.kategorie)), [11, 8]);

const bezBiezacegoRekordu = znajdzZnaneSzkolenie(historia[0].title, indeks, { pominId: '101' });
asercja.equal(bezBiezacegoRekordu.znaleziono, false, 'rekord nie dopasowuje się sam do siebie');

const niewiarygodnaHistoria = zbudujIndeksZnanychSzkolen([{
  id: '103',
  title: historia[0].title,
  categories: [11, 8],
  source: 'user'
}]);
asercja.equal(niewiarygodnaHistoria.przyklady.length, 0, 'lokalny przykład bez śladu zatwierdzenia nie trafia do indeksu');

const duzaHistoria = zbudujIndeksZnanychSzkolen(Array.from({ length: 500 }, (_, indeksRekordu) => ({
  id: String(indeksRekordu + 1),
  title: `Specjalistyczne szkolenie dziedzinowe numer ${indeksRekordu + 1}`,
  categories: [8],
  categoryNames: ['prawo']
})));
asercja.equal(duzaHistoria.przyklady.length, 500);
asercja.equal(
  znajdzZnaneSzkolenie('Specjalistyczne szkolenie dziedzinowe numer 317', duzaHistoria).rodzaj,
  'dokladne',
  'indeks exact działa dla maksymalnej realnej wielkości lokalnej historii'
);

asercja.match(kod, /value\?\.approvedCategoriesAt/, 'historia lokalna wymaga śladu zatwierdzenia kategorii');
asercja.match(kod, /chrome\.storage\.local\.get\(null\)/, 'historia jest pobierana jednym odczytem storage');
asercja.match(kod, /if \(classification\?\.znaneSzkolenie\?\.konflikt\) return;/, 'konflikt historii nie zaznacza automatycznie kategorii');
asercja.match(kod, /historiaZatwierdzonaAt/, 'klasyfikacja śledzi świeżość lokalnego indeksu zatwierdzeń');

console.log('OK: znane szkolenia, near-match, konflikty i indeks 500 rekordów.');
