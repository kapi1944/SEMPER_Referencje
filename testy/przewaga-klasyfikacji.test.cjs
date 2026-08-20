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
const { classify, obliczPrzewageKlasyfikacji } = kontekst.__SEMPER_CLASSIFIER_V3__;
const kategoria = (identyfikator, wynik) => ({ id: identyfikator, name: `kategoria ${identyfikator}`, score: wynik });
const klasyfikacja = (pierwszyWynik, drugiWynik) => ({
  top: kategoria(1, pierwszyWynik),
  best: pierwszyWynik >= 70 ? kategoria(1, pierwszyWynik) : null,
  second: drugiWynik === null ? null : kategoria(2, drugiWynik)
});

for (const [pierwszyWynik, drugiWynik, oczekiwanaRoznica, malaPrzewaga] of [
  [90, 90, 0, true],
  [90, 89, 1, true],
  [90, 85, 5, true],
  [90, 80, 10, false],
  [93, 71, 22, false],
  [95, 64, 31, false]
]) {
  const przewaga = obliczPrzewageKlasyfikacji(klasyfikacja(pierwszyWynik, drugiWynik));
  asercja.equal(przewaga.roznicaPunktowProcentowych, oczekiwanaRoznica);
  asercja.equal(przewaga.malaPrzewaga, malaPrzewaga);
}

asercja.equal(obliczPrzewageKlasyfikacji(klasyfikacja(90, null)), null, 'brak TOP2 nie tworzy przewagi');
asercja.equal(obliczPrzewageKlasyfikacji(null), null, 'brak klasyfikacji nie powoduje błędu');
asercja.equal(klasyfikacja(69, 68).best, null, 'TOP1 poniżej progu zachowuje status wymagający weryfikacji');
asercja.equal(obliczPrzewageKlasyfikacji(klasyfikacja(69, 68)).roznicaPunktowProcentowych, 1);
const klasyfikacjaPonizejProgu = classify('');
asercja.equal(klasyfikacjaPonizejProgu.best, null);
asercja.notEqual(klasyfikacjaPonizejProgu.top.id, klasyfikacjaPonizejProgu.second.id, 'TOP2 nie może ponownie wskazywać TOP1');
asercja.match(kod, /TOP1–TOP2: \+\$\{przewaga\.roznicaPunktowProcentowych\} p\.p\./, 'interfejs pokazuje różnicę w punktach procentowych');
asercja.match(kod, /⚠ \$\{tekstPrzewagi\}/, 'mała przewaga ma dodatkowy sygnał poza kolorem');

console.log('OK: przewaga TOP1 nad TOP2 i przypadki brzegowe.');
