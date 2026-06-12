# AI Visibility mérés — Futtatási paraméterek és módszertani döntések
**Projekt:** Digitális AI Index — Balaton AI-láthatóság audit
**Állapot:** 2026-06-12 · OpenAI-fázis indítás előtt · Claude- és Gemini-fázis tervezett
**Dokumentum célja:** vezetői áttekintés a mérési konfigurációról, a meghozott döntésekről és azok védhetőségéről, valamint a jóváhagyást igénylő nyitott pontokról.

---

## 1. Vezetői összefoglaló

A mérési pipeline működőképes és élesben tesztelt (sikeres teljes session, jó minőségű,
forrásolt válaszokkal). A pilot-mérések feltárták a fő költséghajtót: a modell
lekérdezésenként **8–17 szabad webkeresést** futtat, ami hívásonként 42–93 ezer tokent
és keresési darabdíjat termel — a teljes futás (2 520 hívás) így kontrollálatlan
költségű és ~84 órás lenne. A javasolt konfiguráció **egyetlen tudatos
kontrollparaméterrel** (keresési keret: max. 6/lekérdezés) és **explicit földrajzi
horgonnyal** kiszámíthatóvá teszi a futást, miközben minden más paraméter
szolgáltatói alapértelmezésen marad. Minden döntés előzetesen rögzített, egységesen
alkalmazott, és kontroll-almintával validált — ez a bírálóbiztos eljárásrend.

**Jóváhagyást igényel:** (1) a földrajzi horgony országa (GB vagy DE), (2) a
költségkeret a mért session-ár alapján, (3) a keresési keret validálási
forgatókönyve (6 → tartalék: 8).

---

## 2. A teljes paramétertábla (OpenAI-fázis)

### 2.1. Generálási paraméterek — szolgáltatói alapértelmezésen, dokumentálva

| Paraméter | Érték | Ki állítja | Mit csinál |
|---|---|---|---|
| Modell | `gpt-5.5` → **gpt-5.5-2026-04-23** | mi (alias) / API (verzió) | a vizsgált rendszer; a feloldott verzió a reprodukálhatóság horgonya |
| Top P | 0.98 | default | mintavételezési véletlenszerűség (nucleus sampling) — ez indokolja az 5 ismétlést |
| Reasoning effort | medium | default | a válasz előtti belső gondolkodás mélysége |
| Verbosity | medium | default | a válasz célzott terjedelme |
| Válaszformátum | text | default | szabad szöveg (a fogyasztói élmény modellezése; az NER-fázis bemenete) |
| max_output_tokens | nincs | default | válaszhossz-sapka nincs; a verbosity tartja kordában |

**Védés:** "minden generálási paraméter szolgáltatói alapértelmezésen futott" — a
legkevésbé támadható pozíció; a defaultok értékei dokumentálva, így egy későbbi
default-változás detektálható.

### 2.2. Webkeresési paraméterek — itt vannak a tudatos döntések

| Paraméter | Érték | Ki állítja | Indoklás |
|---|---|---|---|
| web_search tool | bekapcsolva | **mi** | élő webes információ — e nélkül csak tréningtudásból válaszolna |
| tool_choice | **required** | **mi** | minden válasz kötelezően keresés-alapú → a RAG-felületet mérjük (D1 döntés) |
| search_context_size | medium | default | mérés igazolta: a low körönként nem olcsóbb (D3 döntés) |
| **max_tool_calls** | **6** | **mi** | az egyetlen kontrollparaméter — keresési keret (D2 döntés) |
| **user_location** | **GB vagy DE — DÖNTÉS VÁR** | **mi** | explicit földrajzi horgony a default US helyett (D4 döntés) |
| include: sources | bekapcsolva | mi | a felkeresett források mentése (forráselemzési fejezet nyersanyaga) |

### 2.3. Kontextus- és futtatási architektúra

| Elem | Megoldás | Indoklás |
|---|---|---|
| Kontextuskezelés | kézi (kliens-oldali) üzenetlista | pontosan dokumentálható, mit látott a modell minden hívásnál — audit-követelmény |
| Szálszerkezet | 6 prompt: L1 baseline → 4 szezonális ág + 1 összehasonlító ág (csillag-topológia) | a szezonális válaszok egymást nem szennyezik (anti carry-over) |
| Izoláció | minden session független; 5 ismétlés sessionönként | sztochasztikus zaj kezelése |
| Adattárolás | PostgreSQL, tranzakcionális (7 sor/session, mind-vagy-semmi) | nem létezhet csonka session az adatban; integritás-ellenőrzés az exportban |

---

## 3. Meghozott döntések és védésük

### D1 — Kötelező webkeresés: a RAG-felületet mérjük
**Döntés:** minden hívás kötelezően webkereséssel fut (`tool_choice: required`).
**Védés:** a tanulmány explicit kimondja, hogy a keresővel integrált, fogyasztói
AI-élményt auditálja (nem a modell "emlékezetét"). Ez a felület az, amellyel az
utazók ténylegesen találkoznak. A módszertan 3.10. fejezete a felületi validitást
így rögzíti.

### D2 — Keresési keret: max. 6 keresés / lekérdezés
**Döntés:** `max_tool_calls: 6` (Claude-fázisban: `max_uses: 6`).
**A szám levezetése:** a promptok 5 ajánlást kérnek → 1 feltáró keresés +
ajánlásonként 1 ellenőrző keresés (5+1=6).
**Mérési bizonyíték a szükségességére:** keret nélkül a modell 8–17 keresést futtat
hívásonként; a többlet-keresések zömmel ár/nyitvatartás-verifikációk, amelyek a
mért jelhez (desztináció-említések) nem járulnak hozzá. Költséghatás: a 17 körös
hívás ~90e token; kerettel ~35–40e.
**Validálás (kötelező, indítás előtt):** keret nélküli kontroll-almintával
igazoljuk, hogy a megnevezett helyszínek köre és sorrendje a kerettől független.
**Tartalék-forgatókönyv:** ha az említések nem stabilak 6-nál → keret = 8
(= a pilotban megfigyelt minimum; csak a kilengéseket vágja).

### D3 — Search context: medium (default) — a low elvetve, méréssel
**Döntés:** a kontextusméret szolgáltatói defaulton marad.
**Mérési bizonyíték:** azonos prompton low vs. medium futás: körönkénti fogyasztás
~6,8e vs. ~6,6e token — **a low körönként nem olcsóbb** (API-ból visszakérve
igazoltuk, hogy a teszt ténylegesen low-val futott). A költséget a keresések
darabszáma hajtja, nem a körönkénti méret — ezt kezeli a D2.
**További érv:** a low csak az OpenAI-nál létezik → bevezetése aszimmetriát vinne a
szolgáltatók közti összehasonlításba.

### D4 — Földrajzi horgony: explicit, a default US helyett ⚠ DÖNTÉST IGÉNYEL
**Felfedezés:** beállítás nélkül az OpenAI keresése **USA-horgonnyal** fut (API-ból
visszakérve igazolva) — ez eddig kontrollálatlan változó volt.
**Döntés:** a `user_location` explicit beállítása minden hívásnál, egységesen.
**Két védhető opció a vezetői döntésre:**
- **GB:** nyelv–lokáció koherencia (angol lekérdezések, európai piac) — a
  módszertan angol-standardizálási elvéhez illeszkedik;
- **DE:** a Balaton elsődleges külföldi küldőpiacának perspektívája —
  turizmus-szakmai indoklás.
**Anti-opció:** HU kizárva — belföldi horgony a nemzetközi láthatóság mérését
torzítaná (hazai pálya).
**Hatás-jelleg:** a horgony a keresési *rangsorolást* tolja el (nem nyelvváltó);
hatása a verseny-összehasonlító (L3) és felfedező promptoknál érdemi, ezért kell
rögzíteni. A választott horgony hatásmérete egy tesztfutás forrás-domain
elemzésével számszerűsíthető.

### D5 — A lokáció NEM variálódik profilonként/ismétlésenként
**Döntés:** mind a 420 session egyetlen, azonos horgonnyal fut.
**Védés:** a 12 profil egyetlen dimenzió (családi életciklus) mentén különbözik;
egy második, profilonként változó tényező (lokáció) szétválaszthatatlanul
összemosná a szegmens-hatást és a piaci hatást (confounding). A küldőpiaci hatás
külön, célzott almintában vizsgálandó (1 rögzített profil × 3 lokáció) — ezt a
módszertan korlátok-fejezete eleve így irányozza elő.

### D6 — Érzékenységi alminták (a védelmi rendszer)
1. **Keret nélküli kontroll-alminta** — igazolja, hogy a D2 keret nem változtatja
   az említéseket (első darabjai a pilot-futásokból már megvannak);
2. **Lokáció-alminta** (futás után): 1 profil × GB/DE/US — a horgony-érzékenység
   számszerűsítése;
3. Mindkettő a tanulmány saját elve szerint (3.7.2: előzetes rögzítés +
   érzékenységvizsgálat).

---

## 4. Három szolgáltató — harmonizációs terv

**Elv:** *harmonizálunk, ahol lehet; dokumentálunk, ahol nem.* A vizsgálat
keresővel integrált AI-rendszereket hasonlít össze termékként — tökéletes
paraméter-azonosság elvileg sem lehetséges (eltérő keresőindex, retrieval,
citációs formátum).

| Paraméter | OpenAI (gpt-5.5) | Claude | Gemini |
|---|---|---|---|
| Webkeresés kötelezővé tétele | ✅ tool_choice: required | ✅ (tool-használat kikényszeríthető) | részben — implementáláskor ellenőrizendő |
| **Keresési keret** | ✅ max_tool_calls: 6 | ✅ **max_uses: 6** (natív paraméter) | ❌ nincs ismert sapka → dokumentált eltérés |
| **Földrajzi horgony** | ✅ user_location (param) | ✅ user_location (param) | ❌ nincs paraméter — a hívó **IP-címe** horgonyozhat |
| Kontextusméret | medium (default) | n/a (nincs ilyen gomb) | n/a |
| Izolált szálak, angol nyelv, azonos promptok, 5 ismétlés | ✅ | ✅ | ✅ |

**Gemini-fázis kritikus teendői (előzetesen rögzítve):**
1. A lokáció-horgonyt valószínűleg a futtató gép IP-je adja → **a futtatás a
   választott horgony-országban lévő felhő-VM-ről történjen** (így mindhárom
   szolgáltató azonos földrajzi nézőpontra kerül); a futtatási környezet a
   tanulmányban dokumentálandó;
2. A tényleges horgony empirikusan ellenőrizendő a visszaadott forrás-domainek
   összetételéből;
3. Keresésszám-sapka hiányában a Gemini keresési viselkedése szabadon fut —
   nevesített eltérésként dokumentálva.

**Claude-fázis:** a konfiguráció 1:1 tükrözhető (max_uses, user_location) —
paraméter-szinten harmonizált mérés.

---

## 5. Mért tények (a döntések bizonyíték-háttere)

| Mérés | Eredmény |
|---|---|
| Feloldott modellverzió | gpt-5.5-2026-04-23 (minden eddigi hívásnál azonos) |
| Keresésszám keret nélkül | 8–17 / hívás (azonos kontextus mellett is 2,1× költségszórás) |
| Tokenfogyasztás / keresési kör | ~6 600 (medium) ≈ ~6 800 (low) — a low nem olcsóbb |
| L1 hívás előzmény nélkül | 92 730 input token, 14 keresés → a költséget a keresési ciklus termeli, nem a szálkontextus |
| Hívásidő | ~2 perc / hívás → ~12 perc / session (6 hívás) |
| Teljes futás keret nélkül | 420 session ≈ ~84 óra + kontrollálatlan költség |
| Teljes futás kerettel (becslés) | nagyságrendileg feleződő token- és darabdíj-költség; pontos szám: 1 keretes session mért ára × 420 |
| Default lokáció | US (Magyarországról indított hívásnál is — API-ból igazolva) |
| Válaszminőség | teljes, forrásolt, friss árakkal; helyszín-említések futások közt stabilak |

---

## 6. Vezetői döntést igénylő pontok

| # | Kérdés | Opciók | Javaslat |
|---|---|---|---|
| 1 | Földrajzi horgony | GB / DE / US explicit | GB vagy DE (európai versenytér-perspektíva) |
| 2 | Költségkeret | a keretes próba-session mért ára × 420 alapján | jóváhagyás a mérés után |
| 3 | Keret-validálás kimenetele | 6 marad / 8-ra emelés / keret nélkül (drága) | 6, validálva; tartalék: 8 |
| 4 | Kiszolgált modellverzió DB-tárolása | igen (1 oszlop) / futási jegyzetben | nyitott (jelenleg jegyzetben rögzítve) |

## 7. Indítási sorrend (a jóváhagyás után)

1. Konfiguráció kódba égetése (keret + lokáció + induló konfig-naplózás) — commit;
2. Keret-validáló futás → említés-stabilitás ellenőrzése;
3. Korábbi, eltérő konfigurációjú teszt-sessionök eltávolítása az éles adatbázisból
   (pilot/kontroll-almintaként dokumentálva maradnak);
4. Éles futás profilonként darabolva, naplózva, DB-mentéssel (pg_dump előtte/utána);
5. A teljes paramétertábla és a futtatási környezet a tanulmány mellékletébe.
