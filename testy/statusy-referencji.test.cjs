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
const wyliczStan = kontekst.__SEMPER_CLASSIFIER_V3__.wyliczStanReferencji;
const kategoria = (identyfikator, wynik) => ({ id: identyfikator, name: `kategoria ${identyfikator}`, score: wynik });
const klasyfikacjaJednoznaczna = {
  version: '3.2.4',
  best: kategoria(1, 91),
  top: kategoria(1, 91),
  second: kategoria(2, 62),
  status: 'Sklasyfikowana'
};

const scenariusze = [
  {
    nazwa: 'nowa nieprzetworzona referencja',
    wejscie: { rekord: null, przypisaneKategorie: { ids: [], names: [] } },
    oczekiwany: 'Nieprzypisana'
  },
  {
    nazwa: 'kategorie przypisane ręcznie bez danych skryptu',
    wejscie: { rekord: null, przypisaneKategorie: { ids: ['1'], names: ['kategoria 1'] } },
    oczekiwany: 'Przypisana bez OCR'
  },
  {
    nazwa: 'OCR zakończony poprawnie bez klasyfikacji',
    wejscie: { rekord: { ocrText: 'rozpoznany tekst', ocrConfidence: 88 }, przypisaneKategorie: { ids: [], names: [] } },
    oczekiwany: 'OCR gotowy'
  },
  {
    nazwa: 'wynik sklasyfikowany bez zatwierdzenia',
    wejscie: {
      rekord: { ocrText: 'rozpoznany tekst', ocrConfidence: 88, classification: klasyfikacjaJednoznaczna, classifierVersion: '3.2.4' },
      przypisaneKategorie: { ids: [], names: [] }
    },
    oczekiwany: 'Sklasyfikowana'
  },
  {
    nazwa: 'wynik świadomie zatwierdzony',
    wejscie: {
      rekord: {
        ocrText: 'rozpoznany tekst',
        classification: klasyfikacjaJednoznaczna,
        classifierVersion: '3.2.4',
        approvedCategoryIds: [1],
        approvedCategoriesAt: 123456
      },
      przypisaneKategorie: { ids: ['1'], names: ['kategoria 1'] }
    },
    oczekiwany: 'Zweryfikowana'
  },
  {
    nazwa: 'błąd OCR',
    wejscie: { rekord: { bladOcr: 'Nie udało się odczytać obrazu' }, przypisaneKategorie: { ids: [], names: [] } },
    oczekiwany: 'Błąd OCR'
  },
  {
    nazwa: 'niejednoznaczna klasyfikacja',
    wejscie: {
      rekord: {
        ocrText: 'rozpoznany tekst',
        classifierVersion: '3.2.4',
        classification: { version: '3.2.4', best: null, top: kategoria(1, 69), status: 'Wymaga decyzji' }
      },
      przypisaneKategorie: { ids: [], names: [] }
    },
    oczekiwany: 'Wymaga decyzji'
  },
  {
    nazwa: 'legacy Sortowanie 111 bez kategorii i procesu',
    wejscie: { rekord: null, przypisaneKategorie: { ids: [], names: [] }, sortowanieLegacy: '111' },
    oczekiwany: 'Nieprzypisana'
  },
  {
    nazwa: 'legacy Sortowanie 111 z kategoriami bez danych skryptu',
    wejscie: { rekord: null, przypisaneKategorie: { ids: ['2'], names: ['kategoria 2'] }, sortowanieLegacy: '111' },
    oczekiwany: 'Przypisana bez OCR'
  }
];

for (const scenariusz of scenariusze) {
  const stan = wyliczStan(scenariusz.wejscie);
  asercja.equal(stan.etykieta, scenariusz.oczekiwany, scenariusz.nazwa);
}

const malaPrzewaga = wyliczStan({
  rekord: {
    ocrText: 'rozpoznany tekst',
    classifierVersion: '3.2.4',
    classification: {
      version: '3.2.4',
      best: kategoria(1, 88),
      top: kategoria(1, 88),
      second: kategoria(2, 82),
      status: 'Sklasyfikowana'
    }
  },
  przypisaneKategorie: { ids: [], names: [] }
});
asercja.equal(malaPrzewaga.etykieta, 'Wymaga decyzji', 'mała przewaga TOP1 nad TOP2 wymaga decyzji');

const niskaPewnoscOcr = wyliczStan({
  rekord: { ocrText: 'niepewny tekst', ocrConfidence: 48, classification: klasyfikacjaJednoznaczna, classifierVersion: '3.2.4' },
  przypisaneKategorie: { ids: [], names: [] }
});
asercja.equal(niskaPewnoscOcr.etykieta, 'Wymaga decyzji', 'niska pewność OCR wymaga ręcznej kontroli');

const rozbieznoscKategorii = wyliczStan({
  rekord: { ocrText: 'rozpoznany tekst', ocrConfidence: 88, classification: klasyfikacjaJednoznaczna, classifierVersion: '3.2.4' },
  przypisaneKategorie: { ids: ['2'], names: ['kategoria 2'] }
});
asercja.equal(rozbieznoscKategorii.etykieta, 'Wymaga decyzji', 'rozbieżność zapisanej kategorii z TOP1 wymaga decyzji');

const niezgodneZatwierdzenie = wyliczStan({
  rekord: {
    ocrText: 'rozpoznany tekst',
    classification: klasyfikacjaJednoznaczna,
    classifierVersion: '3.2.4',
    approvedCategoryIds: [1],
    approvedCategoriesAt: 123456
  },
  przypisaneKategorie: { ids: ['2'], names: ['kategoria 2'] }
});
asercja.equal(niezgodneZatwierdzenie.etykieta, 'Wymaga decyzji', 'zmiana kategorii po zatwierdzeniu unieważnia stan zweryfikowany i wymaga decyzji');

const legacy = wyliczStan({ rekord: null, przypisaneKategorie: { ids: [], names: [] }, sortowanieLegacy: 111 });
asercja.equal(legacy.sygnaly.sortowanieLegacy, '111', 'wartość legacy jest zachowana jako sygnał diagnostyczny');
asercja.equal(legacy.etykieta, 'Nieprzypisana', 'wartość 111 sama nie udaje zakończonego pipeline');

console.log(`OK: statusy referencji (${scenariusze.length + 5} scenariuszy).`);
