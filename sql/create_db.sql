CREATE TABLE profiles (
    profile_id INT PRIMARY KEY, -- profilazonosító
    profile_name VARCHAR(255) NOT NULL, -- pl. "Young couple (male)"
    profile_language VARCHAR(50), -- prompt nyelve, pl. EN
    age INT, -- életkor
    gender VARCHAR(100), -- nem / identitás
    travel_party VARCHAR(100), -- utazótárs típusa, pl. with my partner
    stay_nights INT, -- tartózkodás hossza éjszakában
    budget_per_day_eur DECIMAL(10, 2), -- napi költségkeret euróban
    price_sensitivity VARCHAR(100), -- árérzékenység, pl. low / medium / high
    destination_name VARCHAR(255) -- utazási desztináció
);


CREATE TABLE interest_groups (
    interest_group_id INT PRIMARY KEY, -- fő termékcsoport azonosító
    interest_type VARCHAR(255) NOT NULL UNIQUE, -- pl. Wellness, Gastronomy
    motivation TEXT -- v2 prompt logika szerinti utazási motivációs kifejezés
);


CREATE TABLE travel_interests (
    interest_id INT PRIMARY KEY, -- szezonális variáns azonosító
    interest_group_id INT NOT NULL REFERENCES interest_groups(interest_group_id),
    season_name VARCHAR(100) NOT NULL, -- pl. Summer, Autumn, Winter, Spring
    motivation TEXT, -- szezonális L2 motiváció; ha NULL, a csoportszintű motivation az alapértelmezés
    travel_time_frame VARCHAR(255) NOT NULL, -- pl. "between June and August"
    UNIQUE (interest_group_id, season_name)
);


CREATE TABLE session_runs (
    session_id VARCHAR(255) PRIMARY KEY, -- egy teljes 6 promptos session azonosítója
    profile_id INT NOT NULL REFERENCES profiles(profile_id),
    interest_group_id INT NOT NULL REFERENCES interest_groups(interest_group_id),
    repeat_index INT NOT NULL DEFAULT 1, -- heurisztikus ismétlés sorszáma
    destination_name VARCHAR(255), -- a futáskor használt desztináció neve
    provider_name VARCHAR(100), -- pl. openai / anthropic / google
    model_name VARCHAR(100), -- melyik modell futott
    run_notes TEXT, -- szabad szöveges megjegyzés a futtatáshoz
    status VARCHAR(50) NOT NULL DEFAULT 'running', -- running / completed / failed
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS session_runs_active_unique_idx
ON session_runs (
    profile_id,
    interest_group_id,
    repeat_index,
    provider_name,
    model_name
)
WHERE status IN ('running', 'completed');


CREATE TABLE request_logs (
    request_log_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id VARCHAR(255) NOT NULL, -- intentionally not FK: live request logs must survive before/after session transaction boundaries
    profile_id INT,
    interest_group_id INT,
    interest_id INT,
    request_order INT NOT NULL,
    request_kind VARCHAR(50) NOT NULL, -- general / constraint / comparison
    branch_label VARCHAR(255),
    season_name VARCHAR(100),
    travel_time_frame VARCHAR(255),
    repeat_index INT NOT NULL DEFAULT 1,
    destination_name VARCHAR(255),
    provider_name VARCHAR(100),
    model_name VARCHAR(100),
    run_notes TEXT,
    status VARCHAR(50) NOT NULL DEFAULT 'started', -- started / completed / failed
    prompt_text TEXT,
    message_history_json JSONB, -- exact saved input context sent to the provider
    completion_id VARCHAR(255),
    provider_request_id VARCHAR(255), -- e.g. Anthropic req_* when available
    answer_text TEXT,
    sources_json JSONB,
    usage_json JSONB,
    response_meta_json JSONB,
    error_message TEXT,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS request_logs_session_idx
ON request_logs (session_id, request_order);
CREATE INDEX IF NOT EXISTS request_logs_completion_idx
ON request_logs (completion_id);
CREATE INDEX IF NOT EXISTS request_logs_started_idx
ON request_logs (started_at DESC);


CREATE TABLE claude_batch_runs (
    batch_run_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    batch_id VARCHAR(255) NOT NULL UNIQUE,
    pass_type VARCHAR(50) NOT NULL, -- general / branch
    destination_name VARCHAR(255),
    provider_name VARCHAR(100),
    model_name VARCHAR(100),
    run_notes TEXT,
    processing_status VARCHAR(50) NOT NULL, -- in_progress / canceling / ended
    request_counts_json JSONB,
    raw_batch_json JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP,
    synced_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS claude_batch_runs_status_idx
ON claude_batch_runs (processing_status, created_at DESC);


CREATE TABLE claude_batch_requests (
    batch_request_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    batch_id VARCHAR(255),
    custom_id VARCHAR(255) NOT NULL UNIQUE,
    pass_type VARCHAR(50) NOT NULL, -- general / branch
    session_id VARCHAR(255) NOT NULL,
    profile_id INT NOT NULL REFERENCES profiles(profile_id),
    interest_group_id INT NOT NULL REFERENCES interest_groups(interest_group_id),
    interest_id INT REFERENCES travel_interests(interest_id),
    request_order INT NOT NULL,
    request_kind VARCHAR(50) NOT NULL, -- general / constraint / comparison
    branch_label VARCHAR(255),
    interest_type VARCHAR(255),
    season_name VARCHAR(100),
    travel_time_frame VARCHAR(255),
    repeat_index INT NOT NULL DEFAULT 1,
    destination_name VARCHAR(255),
    provider_name VARCHAR(100),
    model_name VARCHAR(100),
    run_notes TEXT,
    status VARCHAR(50) NOT NULL DEFAULT 'queued', -- submitting / queued / succeeded / errored / canceled / expired
    prompt_text TEXT NOT NULL,
    message_history_json JSONB NOT NULL,
    completion_id VARCHAR(255),
    provider_request_id VARCHAR(255),
    answer_text TEXT,
    sources_json JSONB,
    usage_json JSONB,
    response_meta_json JSONB,
    raw_result_json JSONB,
    error_json JSONB,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMP,
    finalized_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS claude_batch_requests_session_idx
ON claude_batch_requests (session_id, request_order);
CREATE INDEX IF NOT EXISTS claude_batch_requests_batch_idx
ON claude_batch_requests (batch_id, status);
CREATE INDEX IF NOT EXISTS claude_batch_requests_status_idx
ON claude_batch_requests (status, request_kind);


CREATE TABLE general_prompt_answers (
    general_answer_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id VARCHAR(255) NOT NULL REFERENCES session_runs(session_id),
    profile_id INT NOT NULL REFERENCES profiles(profile_id),
    destination_name VARCHAR(255),
    repeat_index INT NOT NULL DEFAULT 1,
    provider_name VARCHAR(100),
    model_name VARCHAR(100),
    prompt_text TEXT,
    general_prompt_answer TEXT,
    completion_id VARCHAR(255), -- OpenAI completion / response azonosító
    sources_json JSONB, -- a web source lista nyers JSON formában
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS general_prompt_answers_session_unique_idx
ON general_prompt_answers (session_id);


CREATE TABLE constraint_prompt_answers (
    constraint_answer_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id VARCHAR(255) NOT NULL REFERENCES session_runs(session_id),
    profile_id INT NOT NULL REFERENCES profiles(profile_id),
    interest_id INT NOT NULL REFERENCES travel_interests(interest_id),
    interest_group_id INT NOT NULL REFERENCES interest_groups(interest_group_id),
    destination_name VARCHAR(255),
    interest_type VARCHAR(255),
    season_name VARCHAR(100),
    travel_time_frame VARCHAR(255),
    repeat_index INT NOT NULL DEFAULT 1,
    provider_name VARCHAR(100),
    model_name VARCHAR(100),
    prompt_text TEXT,
    constraint_prompt_answer TEXT,
    completion_id VARCHAR(255),
    sources_json JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS constraint_prompt_answers_session_interest_unique_idx
ON constraint_prompt_answers (session_id, interest_id);


CREATE TABLE comparison_prompt_results (
    comparison_answer_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id VARCHAR(255) NOT NULL REFERENCES session_runs(session_id),
    profile_id INT NOT NULL REFERENCES profiles(profile_id),
    interest_group_id INT NOT NULL REFERENCES interest_groups(interest_group_id),
    destination_name VARCHAR(255),
    interest_type VARCHAR(255),
    repeat_index INT NOT NULL DEFAULT 1,
    provider_name VARCHAR(100),
    model_name VARCHAR(100),
    prompt_text TEXT,
    comparison_prompt_answer TEXT,
    completion_id VARCHAR(255),
    sources_json JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS comparison_prompt_results_session_unique_idx
ON comparison_prompt_results (session_id);

CREATE TABLE explorer_prompt_results (
    explorer_result_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    explorer_run_id VARCHAR(255) NOT NULL,
    prompt_id INT NOT NULL,
    repeat_index INT NOT NULL,
    provider_name VARCHAR(100),
    model_name VARCHAR(100),
    prompt_text TEXT NOT NULL,
    answer_text TEXT,
    completion_id VARCHAR(255),
    sources_json JSONB,
    UNIQUE (explorer_run_id, prompt_id, repeat_index)
);
CREATE INDEX IF NOT EXISTS explorer_prompt_results_lookup_idx
ON explorer_prompt_results (prompt_id, repeat_index, provider_name, model_name);
