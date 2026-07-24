SEMPER – Referencje OCR v0.3.6

NOWOŚĆ: Klasyfikator 3.0
- nie opiera się na prostym exact-match słów;
- uwzględnia polskie odmiany i podobne rdzenie wyrazów (np. budowlane / budowlanych / budowlanego);
- używa fuzzy matching i n-gramów, dzięki czemu toleruje część błędów OCR;
- porównuje tytuł referencji z lokalnie indeksowanymi tytułami z publicznej oferty SEMPER;
- etykiety dla wzorców pobiera ze stron szczegółowych szkoleń, gdzie SEMPER publikuje rzeczywiste przypisania kategorii;
- automatycznie buduje profile językowe kategorii z najczęściej charakterystycznych rdzeni i fraz;
- uczy się z kategorii jawnie zapisanych przez użytkownika w Wavepanelu;
- kategorie szczegółowe (np. KPA, BDO, prawo energetyczne) mają pierwszeństwo przed ogólnymi;
- kategoria główna jest sugerowana dopiero od wyniku 70/100; słabsze wyniki są pokazywane jako kandydaci do ręcznej weryfikacji.

Baza publiczna SEMPER synchronizuje się stopniowo w tle i jest zapisywana w chrome.storage.local.
W jednej sesji indeksowanych jest maksymalnie 70 stron szczegółowych, aby nie obciążać serwisu.
Kolejne wejścia do Wavepanelu kontynuują synchronizację.

Instalacja:
1. Rozpakuj ZIP.
2. Otwórz chrome://extensions.
3. Włącz Tryb dewelopera.
4. Kliknij „Załaduj rozpakowane”.
5. Wskaż folder semper_referencje_ocr_mv3_v0.3.6.




NOWOŚCI v0.3.5:
- dodano dzienny licznik „Dzisiaj przypisano kategorie”, widoczny na liście referencji;
- licznik zlicza unikalne referencje, którym danego dnia skutecznie zapisano co najmniej jedną kategorię;
- ponowny zapis tej samej referencji tego samego dnia nie zwiększa wyniku;
- zapis z wbudowanej sekcji kategorii na ref_adm.php aktualizuje licznik natychmiast;
- zapis z natywnej strony ref_kat.php jest po przejściu/odświeżeniu weryfikowany na serwerze i dopiero wtedy doliczany;
- mały licznik „Dzisiaj” jest również widoczny w sekcji kategorii na stronie edycji.

NOWOŚCI v0.3.3:
- naprawiono zbiorczy OCR z listy referencji: rozszerzenie pobiera teraz właściwą stronę edycji ref_adm.php?id=...&opc=edit;
- batch wykorzystuje także rzeczywisty adres edycji znaleziony w wierszu listy;
- dodano kilka ścieżek awaryjnych wyszukiwania strony edycji i pliku /__template/img/upload/...;
- w konsoli zapisywana jest diagnostyka: strona, z której znaleziono obraz, oraz końcowy adres pliku;
- brak obrazu jest odróżniany w kolumnie OCR od ogólnego błędu OCR.

NOWOŚCI v0.3.2:
- zielony przycisk „Użyj zaznaczenia OCR”;
- szersze kolumny Kategorie i Sugestia;
- nowa kolumna „Data wystawienia”;
- automatyczne wykrywanie daty wystawienia z OCR z odróżnianiem dat realizacji szkolenia;
- ręczna korekta daty w panelu OCR oraz opcja „Brak”, gdy dokument nie ma daty wystawienia;
- status „Niewykryta” na liście, gdy OCR nie znajdzie wiarygodnej daty.


v0.3.2:
- zbiorczy OCR + klasyfikacja wszystkich widocznych referencji (do 100),
- wybór liczby widocznych rekordów: 20 / 50 / 100 (50/100 doładowuje kolejne strony listy),
- pole przejścia do dowolnego numeru strony; przy dalekiej stronie rozszerzenie przechodzi przez paginację automatycznie,
- już przeanalizowane rekordy nie są ponownie OCR-owane w trybie zbiorczym; klasyfikacja jest odświeżana.


Zmiany v0.3.5:
- kandydaci kategorii w panelu OCR mają checkboxy; można zaznaczać także wyniki poniżej progu 70%,
- zapis zaznaczonych kategorii bezpośrednio z panelu OCR,
- wybór 20/50/100 i skok do numeru strony przeniesione obok dolnego paginatora Wavepanelu,
- usunięto dolny przycisk „Zwiń panel” (pozostaje strzałka w nagłówku),
- „Ukryj OCR” przeniesiono do nagłówka sekcji pełnego OCR i dodano strzałkę,
- trzy dolne akcje mają nowy układ; „Użyj zaznaczenia OCR” pozostaje zielony.


NOWOŚCI v0.3.6:
- tytuł ręcznie zapisany jest wyświetlany w panelu OCR na zielonym tle z oznaczeniem „Zatwierdzony ręcznie”;
- kliknięcie „Użyj zaznaczenia OCR” jest traktowane jako ręczne zatwierdzenie: zaznaczony tytuł zostaje zapisany od razu i otrzymuje zielony status;
- dalsza edycja zatwierdzonego tytułu usuwa zielony status do czasu ponownego zapisu;
- przebudowano układ kategorii z CSS multi-column na stabilną siatkę dwóch kolumn, dzięki czemu pozycje nie nachodzą na siebie;
- kategorie pozostają ułożone alfabetycznie kolumnami; kategorie specjalne nadal są oddzielone separatorem;
- checkbox oraz nazwa kategorii są wyśrodkowane względem siebie w wierszu, a długie nazwy bezpiecznie zawijają się w obrębie własnej komórki.
