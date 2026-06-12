# Beszélgetés-jegyzőkönyv — Digitalis AI Index projekt
**Dátum:** 2026-06-12 · **Forrás:** Claude Code (web) session összefoglaló
**Cél:** teljes kontextus-átadás a lokális Claude Code sessionnek és a projektgazdának.

---

## 1. A projekt

AI Visibility kutatási pipeline a **Balaton** turisztikai desztinációra:
- **Módszertan** (PwC tanulmány + AI_Visibility_prompt_library_motivacio_v2_1.xlsx):
  12 családi-életciklus (FLC) profil × 7 tematikus termékcsoport × 6-promptos
  beszélgetési szál (1 általános L1 + 4 szezonális megkötéses L2 + 1 összehasonlító L3),
  5 heurisztikus ismétlés, 3 modell (ChatGPT/Gemini/Claude) — **jelenlegi szűkített
  scope: csak ChatGPT (gpt-5.5) + csak Balaton.**
- **Kód:** Node.js (scripts/session_flow.js, model_batch.js, explorer_batch.js,
  export_db_to_excel.js), PostgreSQL `digital_ai_index_db` (7+1 tábla).
- **Matek (ellenőrizve, helyes):** 12×7×5 = 420 session/modell/desztináció,
  ×6 prompt = 2 520 hívás; ×3 modell = 7 560; 8 desztináció = 60 480.
  DB: 7 sor/session (1 session_runs + 1 general + 4 constraint + 1 comparison).

## 2. A szál-logika (lezárt döntés)

A 6 prompt NEM lineáris lánc, hanem **csillag/fork**: az L1 general válasz közös
baseline, ebből ágazik le a 4 szezonális L2 és az L3 — az ágak egymást nem látják
(anti carry-over). A heurisztikus ismétlés session-szintű: minden repeatnél új L1
baseline. **A projektgazda döntése: ez így marad, módszertanilag védhető.**
Az L1 megosztása a 7 termékcsoport között (≈14% költségmegtakarítás) felmerült,
de elvetve — minden szál önálló, zárt egység.

## 3. Git-térkép

| Commit | Dátum | Tartalom |
|---|---|---|
| `b953192` "final form" | jún 08 | régi kód: Chat Completions + gpt-4o-search-preview |
| `0466ee0` "Document and clean up" | jún 11 22:08 | **Responses API + gpt-5.5 + tool_choice:required**; README (1171 sor); .env.example; explorer_batch; export-szkriptek; jelszó/kulcs-fallbackek törölve |
| `9384f2d` (mellék-ág: claude/optimistic-archimedes-42jtob) | jún 11/12 | 3 célzott javítás (lásd 5. pont) |

A jún 10-i jó explorer-futás kódja commitolatlan volt, de lényegében = `0466ee0`
(másnap este commitolva). **A gépen ezen felül commitolatlan lokális módosítások
vannak (pl. `max_tool_calls: 2`), amik EGYIK commitban sincsenek** — a jún 11-éjjeli
problémás futás ezt az ismeretlen változatot futtatta.

## 4. Munkaszabályok (a projektgazda által kikényszerítve — KÖTELEZŐ)

1. **JAVÍTÁS, nem refaktor.** Minimális, célzott diff. Új fájl, új DB-oszlop,
   migráció, szerkezeti átírás CSAK explicit jóváhagyással.
2. **Diff bemutatása commit ELŐTT; commit/push csak jóváhagyás után.**
3. A DB-séma a projektgazdáé; a kódnak a jelenlegi élő séma ellen kell futnia.
4. Soha két mentő futás egyszerre; smoke test mindig `--no-save`-vel
   (a main.js ALAPBÓL MENT!).
5. Minden működő állapot azonnal commitolandó.

*Előzmény: egy korábbi körben túl széles refaktor készült (helper-modul + új
resolved_model oszlopok + 006-os migráció) — a projektgazda elvetette, teljes
visszaállítás történt 0466ee0-ra, majd a 3 javítás minimál-diffel újra.*

## 5. A 3 elfogadott javítás (9384f2d, a mellék-ágon)

Mindkét futtatóban (session_flow.js, explorer_batch.js), helyben:
1. **`new OpenAI({ apiKey, maxRetries: 0 })`** — az SDK rejtett belső 2 retry-a
   kikapcsolva; a saját 4-lépéses exponenciális backoff-loop az egyetlen retry.
2. **Retry-feltétel:** a halott `error?.name === "AbortError"` helyett
   `error instanceof OpenAI.APIUserAbortError || error instanceof OpenAI.APIConnectionError`
   — a timeout mostantól ténylegesen retry-olódik (előtte a timeout azonnal
   megölte a sessiont és eldobta a kifizetett hívásokat).
3. **`extractWebSources` újraírt törzse:** az ÖSSZES web_search_call forrása +
   az ÖSSZES url_citation, URL-re deduplikálva, `origins: ["search"/"citation"]`
   címkével. (A régi first-return logika csak az első keresés forrásait mentette,
   a citációkat eldobta.) Mock-teszttel igazolva.

**Nincs DB-változás, nincs új fájl.** A `resolved_model` mentése a projektgazda
saját, nyitott vállalása (új nullable oszlopot igényelne — az ő döntése).

## 6. Tranzakció-garancia (kérdésre tisztázva)

runSession: BEGIN → INSERT session_runs('running') → 6 API-hívás, mindegyik után
azonnali INSERT → UPDATE 'completed' → COMMIT. **Vagy mind a 7 sor, vagy semmi.**
Hiba esetén ROLLBACK + külön 'failed' jelölősor. Kill/áramszünet: a PG magától
visszagörget. A DB-írás MEGELŐZI az első API-hívást → halott DB mellett nulla
költés. DB-halál futás közben: max 1 session hívásai vesznek el, a batch leáll.
Az export Summary "Integrity mismatches" = 0 ellenőrzi utólag (1+4+1/session).

## 7. A jún 11-éjjeli hiba diagnózisa

Tünet: a batch "állt", se FAILED, se kimenet; az OpenAI logban a hívások mentek.
**Okok (valószínűségi sorrendben):**
1. **Két párhuzamos mentő futás** (smoke test `--no-save` nélkül + batch) ütközött
   ugyanazon (profil 1, Wellness, repeat 1) kulcson → a partial unique index lockján
   a második INSERT csendben várakozott → "fagyás". A unique index a régi kódban is
   megvolt — nem az új kód hibája.
2. **A lokális `max_tool_calls: 2`** (commitolatlan Codex-módosítás) potenciálisan
   csonka/üres válaszokat okozhat a `tool_choice:"required"` mellett.
3. A platform-logban a `<no output>` **UI-artifact** — a jó jún 10-i futásnál is
   az látszik; a válasz valójában megvan (DB-ből/részletnézetből ellenőrizhető).

**Tiszta újraindítás:** `pkill -f "node scripts/"` → beragadt
'idle in transaction' PG-kapcsolatok kilövése (pg_stat_activity →
pg_terminate_backend) → EGYETLEN futás.

## 8. Az élő futás igazolt eredményei (jún 12 reggel)

- **A modell érvényes:** `gpt-5.5` → feloldva **`gpt-5.5-2026-04-23`** ← EZT
  FELJEGYEZNI (reprodukálhatóság; DB-ben nincs tárolva!).
- **A válaszminőség kiváló:** teljes, forrásolt, friss árakkal/nyitvatartásokkal,
  URL-citációkkal (Hévíz, LUA, Anna Spa, Kehida, Annagora példák).
- **A szál-kontextus működik:** az L2 hívás vitte a general Q+A-t.
- **Sebesség: ~2 perc/hívás** (reasoning + ~11 webkeresés/hívás).
- **Tokenek: ~94k total/hívás** (~65k input) — a belső agentic loop minden
  lépésben újraolvassa a felhalmozott keresési kontextust; prompt-caching
  kedvezmény mérsékli a tényleges költséget.
- **Kiszolgált default paraméterek (a tanulmány mellékletébe!):**
  top_p 0.98 · reasoning effort medium · verbosity medium · search context medium
  · tool_choice required. Ezek defaultok — modellfrissítésnél csendben
  változhatnak; opció: explicit beégetésük a requestbe (3 sor, döntés nyitott).

## 9. Idő- és költségmatek (mért alapon)

| | |
|---|---|
| 1 hívás | ~2 perc, ~94k token |
| 1 session (6 hívás) | ~12 perc |
| PROFILE_ID=1 darab (35 session) | ~7 óra |
| **Teljes batch (420 session)** | **~84 óra ≈ 3,5 nap folyamatos** |

**A döntő szám:** 1 session dollárköltsége a usage dashboardról × 420.

**Gyorsítási/olcsósítási karok (1-1 sessionnel A/B mérni, aztán FIXÁLNI):**
1. `WEB_SEARCH_CONTEXT_SIZE=low` (eredetileg ez volt) — kevesebb keresési token;
2. `max_tool_calls: 3-4` — kevesebb keresés (a lokális "2" túl agresszív);
3. `reasoning: { effort: "low" }` — gyorsabb, olcsóbb, sekélyebb.
Bármelyik változat fut, az adatát NEM szabad keverni a medium-os adatokkal,
és a végleges beállítást commitolni kell a 420-as futás előtt.

## 10. Futtatási recept

```bash
# előfeltételek: .env-ben OPENAI_API_KEY ÉS PGPASSWORD; Postgres fut (pg_isready)
# smoke test (NEM ment!):
node scripts/main.js 1 4 Wellness 1 --no-save
# éles darab, egyszerre CSAK EZ fusson:
caffeinate -dimsu env PROFILE_ID=1 node scripts/model_batch.js --save | tee outputs/run_p1.log
# darab után: grep FAILED outputs/run_p1.log ; export + Integrity mismatches = 0?
node scripts/export_db_to_excel.js
# megszakadás után: UGYANAZ a parancs újra — skip/resume folytatja
# a nagy futás előtt és után: pg_dump backup!
```

## 11. Nyitott kérdések (a projektgazda döntései)

1. A 9384f2d fixek merge-ölése main-be (jóváhagyva volt, merge státusza kérdéses).
2. A lokális commitolatlan módosítások sorsa (patch-be mentve? mi értékes belőlük?).
3. resolved_model (kiszolgált modellverzió) DB-mentése — 1 nullable oszlop kellene.
4. Default paraméterek explicit beégetése (top_p/reasoning/verbosity) — 3 sor.
5. Költség-kar választás (low context / max_tool_calls / reasoning) mérés után.
6. L1 prompt "for me/for us" betoldása vs. a kanonikus Excel-könyvtár — szinkron.
7. Explorer: 2-es és 4-es prompt karakterre azonos (PDF-hiba), 9. prompt hiányzik.
8. JÖVŐRE (versenytárs-tavak előtt KÖTELEZŐ): destination_name a unique indexbe
   és a skip-kulcsba — enélkül a 2. desztináció futása csendben "kész"-nek jelenti magát.

## 12. Indító prompt a lokális Claude Code-hoz

> Diagnózist kérek, SEMMIT ne módosíts és ne refaktorálj, csak jelents.
> Olvasd el a CONVERSATION_LOG.md-t (teljes előzmény) — a munkaszabályok 4. pontja
> rád is vonatkozik. Feladatok (csak a beszélgetési szál érdekel, explorer nem):
> 1. `git diff 0466ee0 -- scripts/session_flow.js scripts/model_batch.js` — minden
>    lokális eltérés listája + viselkedési hatása (különösen max_tool_calls).
> 2. DB: a jún 12 0:15–0:40 sessionök státusza + van-e értelmes szöveg a válaszokban.
> 3. Beragadt PG-kapcsolatok ellenőrzése.
> 4. Verdikt: mi okozta az éjjeli elakadást; mit kell visszavonni; használhatók-e
>    az éjjeli adatok. Javítás CSAK külön jóváhagyással, minimál-diffel.
