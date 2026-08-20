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
const pobierzWyniki = kontekst.__SEMPER_CLASSIFIER_V3__.wynikiSugestiiKlasyfikacji;
const kolejkujPrzypisanie = kontekst.__SEMPER_CLASSIFIER_V3__.kolejkujPrzypisanieKategorii;
const kategoria = (identyfikator, nazwa, wynik) => ({ id: identyfikator, name: nazwa, score: wynik });
const nazwyIWyniki = (klasyfikacja) => JSON.parse(JSON.stringify(
  pobierzWyniki(klasyfikacja).map(({ name: nazwa, score: wynik }) => [nazwa, wynik])
));

asercja.deepEqual(nazwyIWyniki({ best: kategoria(1, 'główna', 96) }), [['główna', 96]]);
asercja.deepEqual(nazwyIWyniki({
  best: kategoria(1, 'główna', 96),
  additional: [kategoria(2, 'druga', 82)]
}), [['główna', 96], ['druga', 82]]);
asercja.deepEqual(nazwyIWyniki({
  best: kategoria(1, 'główna', 96),
  additional: [kategoria(2, 'druga', 82), kategoria(3, 'trzecia', 61), kategoria(4, 'czwarta', 50)]
}), [['główna', 96], ['druga', 82], ['trzecia', 61], ['czwarta', 50]]);
asercja.deepEqual(nazwyIWyniki({
  best: kategoria(1, 'główna', 96),
  additional: [kategoria(5, 'piąta', 51), kategoria(3, 'trzecia', 74), kategoria(2, 'druga', 82), kategoria(4, 'czwarta', 63)]
}), [['główna', 96], ['druga', 82], ['trzecia', 74], ['czwarta', 63]]);
asercja.deepEqual(nazwyIWyniki({
  best: kategoria(1, 'główna', 96),
  additional: [kategoria(2, 'druga', 82), kategoria(3, 'trzecia', 61), kategoria(4, 'poniżej progu', 44)]
}), [['główna', 96], ['druga', 82], ['trzecia', 61]]);
asercja.deepEqual(nazwyIWyniki({ best: kategoria(1, 'do weryfikacji', 69) }), []);
asercja.deepEqual(nazwyIWyniki({ best: kategoria(1, 'stary TOP1', 88) }), [['stary TOP1', 88]]);
asercja.deepEqual(nazwyIWyniki(null), []);

async function sprawdzPrzypisywanie() {
  let zapisaneId = [];
  const wywolaniaZapisu = [];
  let wymuszonyBlad = '';
  const zadanie = {
    id: '77',
    assigned: { ids: [], names: [] },
    oczekujaceKategorie: new Set(),
    bledyKategorii: new Map(),
    kolejkaKategorii: Promise.resolve()
  };
  const zapisz = async (identyfikatorReferencji, zadaneId) => {
    asercja.equal(identyfikatorReferencji, '77');
    wywolaniaZapisu.push([...zadaneId]);
    await Promise.resolve();
    if (wymuszonyBlad) throw new Error(wymuszonyBlad);
    zapisaneId = [...zadaneId];
    return { ids: [...zapisaneId], names: zapisaneId.map((identyfikator) => `kategoria ${identyfikator}`) };
  };

  const pierwszyZapis = kolejkujPrzypisanie(zadanie, '1', zapisz);
  asercja.equal(zadanie.assigned.ids.includes('1'), false);
  asercja.equal(zadanie.oczekujaceKategorie.has('1'), true);
  asercja.equal(await pierwszyZapis, true);
  asercja.deepEqual(zapisaneId, ['1']);

  const drugiZapis = kolejkujPrzypisanie(zadanie, '2', zapisz);
  const trzeciZapis = kolejkujPrzypisanie(zadanie, '3', zapisz);
  asercja.deepEqual(await Promise.all([drugiZapis, trzeciZapis]), [true, true]);
  asercja.deepEqual(wywolaniaZapisu.slice(-2), [['1', '2'], ['1', '2', '3']]);

  const liczbaZapisowPrzedDuplikatem = wywolaniaZapisu.length;
  asercja.equal(await kolejkujPrzypisanie(zadanie, '2', zapisz), false);
  asercja.equal(wywolaniaZapisu.length, liczbaZapisowPrzedDuplikatem);

  const szybkiZapis = kolejkujPrzypisanie(zadanie, '4', zapisz);
  const powtorzonySzybkiZapis = kolejkujPrzypisanie(zadanie, '4', zapisz);
  asercja.equal(await powtorzonySzybkiZapis, false);
  asercja.equal(await szybkiZapis, true);
  asercja.equal(wywolaniaZapisu.filter((identyfikatory) => identyfikatory.includes('4')).length, 1);

  wymuszonyBlad = 'awaria backendu';
  asercja.equal(await kolejkujPrzypisanie(zadanie, '5', zapisz), false);
  asercja.equal(zadanie.assigned.ids.includes('5'), false);
  asercja.equal(zadanie.bledyKategorii.get('5'), 'awaria backendu');

  wymuszonyBlad = '';
  const zadaniePoOdswiezeniu = {
    id: '77',
    assigned: { ids: [...zapisaneId], names: zapisaneId.map((identyfikator) => `kategoria ${identyfikator}`) }
  };
  const liczbaZapisowPrzedOdswiezeniem = wywolaniaZapisu.length;
  asercja.equal(await kolejkujPrzypisanie(zadaniePoOdswiezeniu, '4', zapisz), false);
  asercja.equal(wywolaniaZapisu.length, liczbaZapisowPrzedOdswiezeniem);
}

sprawdzPrzypisywanie()
  .then(() => console.log('OK: prezentacja oraz kolejka przypisywania kategorii.'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
