const asercja = require('node:assert/strict');
const systemPlikow = require('node:fs');
const sciezka = require('node:path');
const maszynaWirtualna = require('node:vm');

const sciezkaSkryptu = sciezka.join(__dirname, '..', 'content', 'content.js');
const sciezkaStylu = sciezka.join(__dirname, '..', 'content', 'style.css');
const kod = systemPlikow.readFileSync(sciezkaSkryptu, 'utf8');
const styl = systemPlikow.readFileSync(sciezkaStylu, 'utf8');
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
const { uzasadnienieWynikuKlasyfikacji } = kontekst.__SEMPER_CLASSIFIER_V3__;

const kpa = uzasadnienieWynikuKlasyfikacji({
  hits: ['KPA', 'postępowanie administracyjne'],
  evidence: { domain: 92, public: 76, user: 0, lexical: 64 }
});
const kadry = uzasadnienieWynikuKlasyfikacji({
  hits: ['prawo pracy', 'akta osobowe'],
  evidence: { domain: 88, user: 81 }
});
asercja.match(kpa, /„KPA”/);
asercja.match(kpa, /pojęcia dziedzinowe 92%/);
asercja.match(kpa, /oferty SEMPER 76%/);
asercja.match(kadry, /„prawo pracy”/);
asercja.doesNotMatch(kadry, /KPA/);
asercja.equal(uzasadnienieWynikuKlasyfikacji({}), '', 'brak evidence jest neutralny');
asercja.equal(uzasadnienieWynikuKlasyfikacji(null), '', 'brak wyniku nie powoduje błędu');

const dlugieUzasadnienie = uzasadnienieWynikuKlasyfikacji({
  hits: Array.from({ length: 12 }, (_, indeks) => `bardzo długi fragment uzasadnienia numer ${indeks} ${'x'.repeat(90)}`),
  evidence: { domain: 99, public: 98, user: 97, lexical: 96 }
});
asercja.ok(dlugieUzasadnienie.length < 430, 'długie uzasadnienie pozostaje zwarte');
asercja.match(dlugieUzasadnienie, /…/);
asercja.doesNotMatch(dlugieUzasadnienie, /numer 5/, 'liczba trafień jest ograniczona');

asercja.match(kod, /addEventListener\('mouseenter'/, 'tooltip działa na hover');
asercja.match(kod, /addEventListener\('focus'/, 'tooltip działa z klawiatury');
asercja.match(kod, /addEventListener\('click', \(\) => ukryjTooltipUzasadnienia/, 'tooltip nie przechwytuje akcji kategorii');
asercja.match(kod, /addEventListener\('scroll', \(\) => ukryjTooltipUzasadnienia\(\), true\)/, 'scroll zamyka tooltip');
asercja.match(kod, /tooltip\.dataset\.cel !== element\.dataset\.identyfikatorTooltipu/, 'zdarzenie starego celu nie zamyka nowego tooltipu');
asercja.match(kod, /Brak zapisanego uzasadnienia dla tej kategorii\./, 'brak uzasadnienia ma neutralny komunikat');
asercja.match(kod, /ukryjTooltipUzasadnienia\(\);\s*cell\.textContent = '';/, 'rerender usuwa aktywny tooltip');
asercja.match(styl, /\.semper-tooltip-uzasadnienia[\s\S]*?pointer-events:\s*none;/, 'tooltip nie przechwytuje kliknięć');
asercja.match(styl, /position:\s*fixed;/, 'tooltip pozostaje niezależny od wysokości wiersza');

console.log('OK: uzasadnienia klasyfikacji i interakcje tooltipu.');
