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
const { odczytajProcent, tekstProcentu, wynikiSugestiiKlasyfikacji } = kontekst.__SEMPER_CLASSIFIER_V3__;
const kategoria = (identyfikator, nazwa, wynik) => ({ id: identyfikator, name: nazwa, score: wynik });

asercja.equal(tekstProcentu(88), '88%', 'kompletny OCR zachowuje swój wynik');
asercja.equal(tekstProcentu(34), '34%', 'słaby OCR nie jest ukrywany');
asercja.equal(tekstProcentu(0), '0%', 'rzeczywiste zero pozostaje wartością');
asercja.equal(tekstProcentu(undefined), '—', 'brak metryki nie staje się zerem');
asercja.equal(tekstProcentu(null), '—', 'legacy null jest neutralnym brakiem');
asercja.equal(tekstProcentu('94'), '94%', 'legacy liczba tekstowa jest obsługiwana');
asercja.equal(odczytajProcent('brak'), null, 'nieprawidłowa wartość legacy jest odrzucana');

const pelnaKlasyfikacja = {
  best: kategoria(1, 'prawo', 91),
  top: kategoria(1, 'prawo', 91),
  additional: [kategoria(2, 'administracja', 72)]
};
const rekordKompletny = { ocrConfidence: 88, titleConfidence: 94, classification: pelnaKlasyfikacja };
const rekordDobreOcrNiskaKlasyfikacja = {
  ocrConfidence: 93,
  titleConfidence: 89,
  classification: { best: null, top: kategoria(1, 'prawo', 42) }
};
const rekordBezJednejMetryki = { ocrConfidence: 87, classification: pelnaKlasyfikacja };
asercja.equal(tekstProcentu(rekordKompletny.ocrConfidence), '88%');
asercja.equal(tekstProcentu(rekordKompletny.titleConfidence), '94%');
asercja.equal(tekstProcentu(rekordDobreOcrNiskaKlasyfikacja.ocrConfidence), '93%');
asercja.equal(tekstProcentu(rekordBezJednejMetryki.titleConfidence), '—');
asercja.deepEqual(
  JSON.parse(JSON.stringify(wynikiSugestiiKlasyfikacji(pelnaKlasyfikacja).map(({ name, score }) => [name, score]))),
  [['prawo', 91], ['administracja', 72]],
  'pełna klasyfikacja zachowuje właściwe wyniki kategorii'
);
asercja.deepEqual(
  JSON.parse(JSON.stringify(wynikiSugestiiKlasyfikacji(rekordDobreOcrNiskaKlasyfikacja.classification))),
  [],
  'niski wynik klasyfikacji nie staje się automatyczną sugestią'
);
asercja.deepEqual(
  JSON.parse(JSON.stringify(wynikiSugestiiKlasyfikacji(null))),
  [],
  'brak klasyfikacji jest obsługiwany'
);
asercja.match(kod, /Wykrycie tytułu: \$\{tekstProcentu\(pewnoscWykryciaTytulu\)\}/, 'tytuł ma jednoznaczną etykietę');
asercja.match(kod, /OCR: \$\{tekstProcentu\(pewnoscOcr\)\}/, 'OCR ma jednoznaczną etykietę');
asercja.match(kod, /Sugestia klasyfikacji/, 'kolumna sugestii wskazuje klasyfikację');
asercja.doesNotMatch(kod, /Sugestie OCR:/, 'wynik klasyfikacji nie jest nazywany sugestią OCR');

console.log('OK: prezentacja OCR, tytułu, klasyfikacji i danych legacy.');
