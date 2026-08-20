(() => {
  'use strict';

  const KLUCZ_STANU_WTYCZKI = 'semper_stan_wtyczki_v1';
  const KLUCZ_AUTOAKCEPTACJI_KATEGORII = 'semper_autoakceptacja_kategorii_v1';
  const poleStanu = document.getElementById('stan');
  const przyciskWlaczenia = document.getElementById('wlacz');
  const poleAutoakceptacji = document.getElementById('autoakceptacja-kategorii');

  function formatujDate(czas) {
    return new Intl.DateTimeFormat('pl-PL', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(czas));
  }

  async function pokazStan() {
    const zapis = await chrome.storage.local.get([KLUCZ_STANU_WTYCZKI, KLUCZ_AUTOAKCEPTACJI_KATEGORII]);
    const stan = zapis[KLUCZ_STANU_WTYCZKI];
    const autoakceptacja = zapis[KLUCZ_AUTOAKCEPTACJI_KATEGORII];
    const czasWylaczenia = Number(stan?.wylaczoneDo) || 0;
    const wylaczonaBezterminowo = stan?.tryb === 'bezterminowo';
    const wylaczonaCzasowo = stan?.tryb === 'czasowo' && czasWylaczenia > Date.now();

    poleStanu.classList.toggle('wylaczona', wylaczonaBezterminowo || wylaczonaCzasowo);
    przyciskWlaczenia.hidden = !wylaczonaBezterminowo && !wylaczonaCzasowo;

    if (wylaczonaBezterminowo) poleStanu.textContent = 'Wtyczka wyłączona do ponownego włączenia';
    else if (wylaczonaCzasowo) poleStanu.textContent = `Wtyczka wyłączona do ${formatujDate(czasWylaczenia)}`;
    else poleStanu.textContent = 'Wtyczka jest włączona';
    poleAutoakceptacji.checked = autoakceptacja?.wlaczona === true;
  }

  async function ustawAutoakceptacje() {
    await chrome.storage.local.set({
      [KLUCZ_AUTOAKCEPTACJI_KATEGORII]: {
        wlaczona: poleAutoakceptacji.checked,
        zmienionoAt: Date.now()
      }
    });
  }

  async function wylaczCzasowo(minuty) {
    await chrome.storage.local.set({
      [KLUCZ_STANU_WTYCZKI]: {
        tryb: 'czasowo',
        wylaczoneDo: Date.now() + minuty * 60 * 1000
      }
    });
    await pokazStan();
  }

  async function wylaczBezterminowo() {
    await chrome.storage.local.set({
      [KLUCZ_STANU_WTYCZKI]: { tryb: 'bezterminowo' }
    });
    await pokazStan();
  }

  async function wlacz() {
    await chrome.storage.local.remove(KLUCZ_STANU_WTYCZKI);
    await pokazStan();
  }

  document.querySelectorAll('[data-minuty]').forEach((przycisk) => {
    przycisk.addEventListener('click', () => wylaczCzasowo(Number(przycisk.dataset.minuty)));
  });
  document.getElementById('wylacz-bezterminowo').addEventListener('click', wylaczBezterminowo);
  przyciskWlaczenia.addEventListener('click', wlacz);
  poleAutoakceptacji.addEventListener('change', ustawAutoakceptacje);

  pokazStan();
})();
