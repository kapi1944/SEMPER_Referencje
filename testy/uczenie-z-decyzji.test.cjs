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
  classify,
  zbudujIndeksZnanychSzkolen,
  znajdzZnaneSzkolenie,
  obliczWynikiZatwierdzonychPrzykladow
} = kontekst.__SEMPER_CLASSIFIER_V3__;

const tytul = 'Prawo budowlane – najnowsze zmiany 2026';
const bezHistorii = classify(tytul, '', { indeksHistorii: zbudujIndeksZnanychSzkolen([]) });
const sugerowanaPrzedKorekta = bezHistorii.top?.id;
asercja.ok(sugerowanaPrzedKorekta, 'klasyfikator tworzy początkową sugestię A');

const kategoriaPoKorekcie = sugerowanaPrzedKorekta === 37 ? 11 : 37;
const zatwierdzonaKorekta = [{
  id: '301',
  title: tytul,
  categories: [kategoriaPoKorekcie],
  categoryNames: ['kategoria po ręcznej korekcie'],
  approvedAt: 301,
  source: 'user'
}];
const indeksPoKorekcie = zbudujIndeksZnanychSzkolen(zatwierdzonaKorekta);
const podobnyTytul = 'Prawo budowlane – najnowsze zmiany 2027';
const podobnyBezHistorii = classify(podobnyTytul, '', { indeksHistorii: zbudujIndeksZnanychSzkolen([]) });
const poKorekcie = classify(podobnyTytul, '', { indeksHistorii: indeksPoKorekcie });
asercja.notEqual(kategoriaPoKorekcie, sugerowanaPrzedKorekta, 'B jest rzeczywistą korektą wcześniejszej sugestii A');
asercja.equal(poKorekcie.znaneSzkolenie.znaleziono, true);
asercja.equal(poKorekcie.znaneSzkolenie.konflikt, false);
asercja.equal(poKorekcie.best?.id, kategoriaPoKorekcie, 'dla bardzo podobnego tytułu zatwierdzona korekta B wygrywa z dawną sugestią A');
asercja.ok(
  poKorekcie.results.find((wynik) => wynik.id === kategoriaPoKorekcie).evidence.user > 0,
  'zatwierdzona korekta B wpływa na wynik podobnego tytułu'
);
asercja.ok(
  poKorekcie.results.find((wynik) => wynik.id === kategoriaPoKorekcie).score
    > (podobnyBezHistorii.results.find((wynik) => wynik.id === kategoriaPoKorekcie)?.score || 0),
  'historyczna decyzja B rzeczywiście podnosi wynik B'
);

const surowaSugestia = zbudujIndeksZnanychSzkolen([{
  id: '302',
  title: tytul,
  categories: [sugerowanaPrzedKorekta],
  source: 'user'
}]);
asercja.equal(surowaSugestia.przyklady.length, 0, 'niezatwierdzona sugestia automatyczna nie trafia do historii');

const zgodneDopasowania = [1, 2, 3].map((id) => ({
  id: String(id),
  podobienstwo: 0.92,
  kategorie: [kategoriaPoKorekcie]
}));
const wynikiZgodne = obliczWynikiZatwierdzonychPrzykladow(zgodneDopasowania);
asercja.ok(wynikiZgodne.get(kategoriaPoKorekcie) > 90, 'kilka zgodnych decyzji daje mocny sygnał historyczny');

const wynikiKonfliktu = obliczWynikiZatwierdzonychPrzykladow([
  { podobienstwo: 1, kategorie: [11] },
  { podobienstwo: 1, kategorie: [37] }
]);
asercja.equal(Math.round(wynikiKonfliktu.get(11)), 75);
asercja.equal(Math.round(wynikiKonfliktu.get(37)), 75, 'remis konfliktowy osłabia obie rekomendacje jednakowo');

const wynikiWiekszosci = obliczWynikiZatwierdzonychPrzykladow([
  { podobienstwo: 1, kategorie: [11] },
  { podobienstwo: 1, kategorie: [11] },
  { podobienstwo: 1, kategorie: [37] }
]);
asercja.ok(wynikiWiekszosci.get(11) > wynikiWiekszosci.get(37), 'większość ma silniejszy sygnał niż decyzja mniejszościowa');

const konflikt = znajdzZnaneSzkolenie(tytul, zbudujIndeksZnanychSzkolen([
  { id: '401', title: tytul, categories: [11], approvedAt: 401, source: 'user' },
  { id: '402', title: tytul, categories: [37], approvedAt: 402, source: 'user' }
]));
asercja.equal(konflikt.konflikt, true, 'dokładny konflikt pozostaje jawnie oznaczony');
const klasyfikacjaKonfliktowa = classify(tytul, '', { indeksHistorii: zbudujIndeksZnanychSzkolen([
  { id: '401', title: tytul, categories: [11], approvedAt: 401, source: 'user' },
  { id: '402', title: tytul, categories: [37], approvedAt: 402, source: 'user' }
]) });
asercja.equal(klasyfikacjaKonfliktowa.status, 'Wymaga decyzji', 'konflikt blokuje wiarygodny status automatyczny');

asercja.equal(obliczWynikiZatwierdzonychPrzykladow([]).size, 0, 'klasyfikacja działa bez historii');
asercja.equal(znajdzZnaneSzkolenie(tytul, indeksPoKorekcie).rodzaj, 'dokladne');
asercja.equal(znajdzZnaneSzkolenie(podobnyTytul, indeksPoKorekcie).rodzaj, 'przyblizone');

asercja.match(kod, /approvedCategoriesAt/, 'wiarygodność przykładu wymaga śladu zatwierdzenia');
asercja.match(kod, /await getAssignedCategories\(id, true\)/, 'zapisane kategorie są ponownie odczytywane z serwera');
asercja.match(kod, /approvedCategoryIds: zweryfikowane\.ids/, 'lokalny przykład używa zweryfikowanego wyniku zapisu');

console.log('OK: deterministyczne uczenie z zatwierdzonych decyzji i korekt użytkownika.');
