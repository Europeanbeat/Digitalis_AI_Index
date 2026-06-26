# Digitális AI Index — Architecture

Research data-collection pipeline that queries AI models about lakeside tourism
recommendations across profiles, thematic groups, seasons, and providers, then
stores the structured outputs in PostgreSQL for downstream analysis.

All diagrams below are [Mermaid.js](https://mermaid.js.org/) and render directly
on GitHub / most Markdown viewers.

---

## 1. Module & dependency layout

How the three scripts, the SQL layer, and external services fit together.

```mermaid
flowchart TB
    subgraph ENTRY["Entry points (scripts/)"]
        MAIN["main.js<br/><i>single-session test runner</i>"]
        BATCH["model_batch.js<br/><i>large batch runner</i>"]
    end

    subgraph CORE["Core engine"]
        FLOW["session_flow.js<br/><i>orchestration + DB I/O + prompts</i>"]
    end

    subgraph CONFIG["Configuration"]
        ENV[".env<br/>PG* + OPENAI_API_KEY<br/>OPENAI_MODEL / AI_PROVIDER"]
        PKG["package.json<br/>openai · pg · dotenv"]
    end

    subgraph SQL["sql/ (schema & seeds)"]
        CREATE["create_db.sql<br/><i>base schema v1</i>"]
        MIG["004_migrate_live_db_to_v2.sql<br/><i>live migration</i>"]
        SEEDP["002_insert_sample_profile.sql"]
        SEEDI["003_seed_travel_interests.sql"]
    end

    subgraph EXT["External services"]
        OPENAI["OpenAI Chat Completions API<br/>gpt-4o-search-preview<br/>web_search_options"]
        PG[("PostgreSQL<br/>digital_ai_index_db")]
    end

    MAIN -->|runSession| FLOW
    BATCH -->|"getAllProfiles / getInterestGroupRows / runSession"| FLOW
    FLOW -->|reads| ENV
    FLOW -->|chat.completions.create| OPENAI
    FLOW -->|"pg Client (per session)"| PG
    BATCH -->|"pg Client (skip checks)"| PG

    CREATE -.defines.-> PG
    MIG -.alters.-> PG
    SEEDP -.seeds.-> PG
    SEEDI -.seeds.-> PG
    PKG -.deps.-> FLOW
```

---

## 2. Session logic — the 6-prompt branched thread

One session = 1 profile × 1 thematic group × 1 repeat × 1 model. The general
answer establishes a baseline; each follow-up forks from that baseline so seasons
never see each other (anti carry-over). Total = 6 API calls regardless of branching.

```mermaid
flowchart TD
    START([runSession]) --> LOADP["getProfile(profileId)"]
    LOADP --> LOADI["getTravelInterests<br/>(4 seasonal rows for group)"]
    LOADI --> SID["createSessionId<br/>session_PID_GID_REPEAT_timestamp"]
    SID --> INSROW["INSERT session_runs<br/>status = running"]

    INSROW --> GP["Build GENERAL prompt"]
    GP --> GCALL["API call #1"]
    GCALL --> GANS["general answer"]
    GANS --> SAVEG[("save general_prompt_answers")]
    GANS --> BASE["base = [general Q, general A]<br/><i>cloned snapshot</i>"]

    BASE --> B1["base + Summer prompt"]
    BASE --> B2["base + Autumn prompt"]
    BASE --> B3["base + Winter prompt"]
    BASE --> B4["base + Spring prompt"]
    BASE --> B5["base + Comparison prompt"]

    B1 --> C1["API #2"] --> S1[("constraint_prompt_answers")]
    B2 --> C2["API #3"] --> S2[("constraint_prompt_answers")]
    B3 --> C3["API #4"] --> S3[("constraint_prompt_answers")]
    B4 --> C4["API #5"] --> S4[("constraint_prompt_answers")]
    B5 --> C5["API #6"] --> S5[("comparison_prompt_results")]

    S1 & S2 & S3 & S4 & S5 --> DONE["UPDATE session_runs<br/>status = completed"]
    DONE --> END([return result + trace])

    GCALL -. on error .-> FAIL["UPDATE session_runs<br/>status = failed + error_message"]
    C1 -. on error .-> FAIL
    FAIL --> ENDERR([throw])

    classDef api fill:#e8f0fe,stroke:#4285f4;
    classDef db fill:#e6f4ea,stroke:#34a853;
    classDef err fill:#fce8e6,stroke:#ea4335;
    class GCALL,C1,C2,C3,C4,C5 api;
    class SAVEG,S1,S2,S3,S4,S5,INSROW,DONE db;
    class FAIL,ENDERR err;
```

> Note: the 5 follow-ups each fork from `base` (general Q+A only). Seasonal
> answers are **not** visible to each other or to the comparison prompt.

---

## 3. Batch runner — combinatorial loop with skip/resume

`model_batch.js` iterates profile × group × repeat for one model/provider
(set via env). Destination comes from the profile row; the model from `.env`.

```mermaid
flowchart TD
    BSTART([model_batch.js]) --> CONN["connect pg Client"]
    CONN --> LP["getAllProfiles()"]
    LP --> LG["getInterestGroupRows()"]
    LG --> CALC["totalSessions =<br/>profiles × groups × REPEAT_COUNT"]

    CALC --> OUTER{"for each<br/>profile"}
    OUTER --> MID{"for each<br/>interest group"}
    MID --> INNER{"for repeat =<br/>1..REPEAT_COUNT"}

    INNER --> SKIP{"--save &&<br/>session already<br/>completed?"}
    SKIP -->|yes| COUNTSKIP["skipped++ ; continue"]
    SKIP -->|no| RUN["runSession(...)"]

    RUN -->|success| OK["successful++"]
    RUN -->|throws| CATCH["failed++ ; log error ; continue"]

    OK --> DELAY{"SESSION_DELAY_MS<br/>> 0 ?"}
    CATCH --> DELAY
    COUNTSKIP --> INNER
    DELAY -->|sleep| INNER
    DELAY -->|next| INNER

    INNER -->|done| MID
    MID -->|done| OUTER
    OUTER -->|done| REPORT["print successful /<br/>skipped / failed /<br/>elapsed"]
    REPORT --> BEND([end])

    classDef warn fill:#fef7e0,stroke:#f9ab00;
    class SKIP,DELAY warn;
```

Skip key (`sessionAlreadyExists`): `profile_id + interest_group_id +
repeat_index + provider_name + model_name` where `status = 'completed'`.
Failed sessions are **not** skipped → they retry on rerun.

---

## 4. Database schema (ER diagram)

7 tables. `session_runs` is the audit header; the three answer tables are
intentionally denormalized for Excel export.

```mermaid
erDiagram
    profiles ||--o{ session_runs : "profile_id"
    interest_groups ||--o{ travel_interests : "interest_group_id"
    interest_groups ||--o{ session_runs : "interest_group_id"
    session_runs ||--|| general_prompt_answers : "1 per session"
    session_runs ||--o{ constraint_prompt_answers : "4 per session"
    session_runs ||--|| comparison_prompt_results : "1 per session"
    travel_interests ||--o{ constraint_prompt_answers : "interest_id"

    profiles {
        int profile_id PK
        varchar profile_name
        varchar profile_language
        int age
        varchar gender
        varchar travel_party
        int stay_nights
        decimal budget_per_day_eur
        varchar price_sensitivity
        varchar destination_name
    }

    interest_groups {
        int interest_group_id PK
        varchar interest_type UK
        text motivation
    }

    travel_interests {
        int interest_id PK
        int interest_group_id FK
        varchar season_name
        text motivation
        varchar travel_time_frame
    }

    session_runs {
        varchar session_id PK
        int profile_id FK
        int interest_group_id FK
        int repeat_index
        varchar destination_name
        varchar provider_name
        varchar model_name
        varchar status
        text error_message
        timestamp created_at
    }

    general_prompt_answers {
        int general_answer_id PK
        varchar session_id FK
        int profile_id FK
        varchar destination_name
        int repeat_index
        varchar provider_name
        varchar model_name
        text prompt_text
        text general_prompt_answer
        varchar completion_id
        jsonb sources_json
        timestamp created_at
    }

    constraint_prompt_answers {
        int constraint_answer_id PK
        varchar session_id FK
        int profile_id FK
        int interest_id FK
        int interest_group_id FK
        varchar destination_name
        varchar interest_type
        varchar season_name
        varchar travel_time_frame
        int repeat_index
        varchar provider_name
        varchar model_name
        text prompt_text
        text constraint_prompt_answer
        varchar completion_id
        jsonb sources_json
        timestamp created_at
    }

    comparison_prompt_results {
        int comparison_answer_id PK
        varchar session_id FK
        int profile_id FK
        int interest_group_id FK
        varchar destination_name
        varchar interest_type
        int repeat_index
        varchar provider_name
        varchar model_name
        text prompt_text
        text comparison_prompt_answer
        varchar completion_id
        jsonb sources_json
        timestamp created_at
    }
```

---

## 5. End-to-end research pipeline (collection → analysis)

Where the code stops (data collection) and where the methodology's later
phases begin (extraction, scoring, benchmarking — not yet implemented).

```mermaid
flowchart LR
    subgraph DIM["Research dimensions"]
        P["P profiles"]
        D["D destinations"]
        G["G groups"]
        M["M models"]
        R["R repeats"]
    end

    DIM --> GEN["Combinatorial<br/>session generation<br/>P×D×G×M×R"]
    GEN --> COLLECT["session_flow.js<br/>6 prompts / session"]
    COLLECT --> STORE[("PostgreSQL<br/>7 rows / session")]

    STORE --> EXPORT["Excel / CSV export"]
    STORE -.future.-> NER["Entity extraction<br/>(NER) + normalization"]
    NER -.future.-> RANK["Rank + co-occurrence<br/>structuring"]
    RANK -.future.-> SCORE["AI Visibility Score<br/>5 dimensions"]
    SCORE -.future.-> BENCH["Benchmarking vs.<br/>competitor destinations"]

    classDef impl fill:#e6f4ea,stroke:#34a853;
    classDef future fill:#f1f3f4,stroke:#9aa0a6,stroke-dasharray:4 3;
    class GEN,COLLECT,STORE,EXPORT impl;
    class NER,RANK,SCORE,BENCH future;
```

Solid = implemented in this repo. Dashed = later research phases described in
the methodology but not yet in code.
