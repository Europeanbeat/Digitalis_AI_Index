-- Live migration for the existing digital_ai_index_db schema.
-- Purpose:
-- 1. introduce interest_groups
-- 2. link seasonal travel_interests rows to a stable interest_group_id
-- 3. introduce session_runs
-- 4. add metadata fields needed by the updated session_flow.js
-- Follow-up cleanup / extensions live in later scripts:
--   006_remove_interest_attributes.sql
--   007_add_waterfront_recreation.sql


-- 1. Stable product-group table
CREATE TABLE IF NOT EXISTS interest_groups (
    interest_group_id INT PRIMARY KEY,
    interest_type VARCHAR(255) NOT NULL UNIQUE,
    motivation TEXT
);

ALTER TABLE interest_groups
ADD COLUMN IF NOT EXISTS motivation TEXT;

ALTER TABLE interest_groups
DROP COLUMN IF EXISTS interest_attributes;

INSERT INTO interest_groups (
    interest_group_id,
    interest_type,
    motivation
) VALUES
    (1, 'Wellness', 'relax, unwind and recharge through wellness and spa experiences'),
    (2, 'Gastronomy', 'experience local food, wine and culinary traditions'),
    (3, 'Active tourism', 'be physically active and enjoy outdoor sport and adventure'),
    (4, 'Health tourism', 'improve my health and recovery through medical, thermal or healing treatments'),
    (5, 'Culture and events', 'discover culture, heritage, history and local events'),
    (6, 'Nature and ecotourism', 'connect with nature, scenery and the outdoors'),
    (7, 'Agritourism', 'experience authentic rural life and local farming')
ON CONFLICT (interest_group_id) DO UPDATE SET
    interest_type = EXCLUDED.interest_type,
    motivation = EXCLUDED.motivation;


-- 2. Add group reference to the existing seasonal rows
ALTER TABLE travel_interests
ADD COLUMN IF NOT EXISTS interest_group_id INT;

UPDATE travel_interests
SET interest_group_id = 1
WHERE interest_type = 'Wellness';

UPDATE travel_interests
SET interest_group_id = 2
WHERE interest_type = 'Gastronomy';

UPDATE travel_interests
SET interest_group_id = 3
WHERE interest_type = 'Active tourism';

UPDATE travel_interests
SET interest_group_id = 4
WHERE interest_type = 'Health tourism';

UPDATE travel_interests
SET interest_group_id = 5
WHERE interest_type = 'Culture and events';

UPDATE travel_interests
SET interest_group_id = 6
WHERE interest_type = 'Nature and ecotourism';

UPDATE travel_interests
SET interest_group_id = 7
WHERE interest_type = 'Agritourism';


-- 3. Session-level run table for one full profile x group x repeat run
CREATE TABLE IF NOT EXISTS session_runs (
    session_id VARCHAR(255) PRIMARY KEY,
    profile_id INT NOT NULL REFERENCES profiles(profile_id),
    interest_group_id INT NOT NULL REFERENCES interest_groups(interest_group_id),
    repeat_index INT NOT NULL DEFAULT 1,
    destination_name VARCHAR(255),
    provider_name VARCHAR(100),
    model_name VARCHAR(100),
    status VARCHAR(50) NOT NULL DEFAULT 'running',
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE session_runs
ADD COLUMN IF NOT EXISTS provider_name VARCHAR(100);

ALTER TABLE session_runs
ADD COLUMN IF NOT EXISTS run_notes TEXT;

ALTER TABLE session_runs
ADD COLUMN IF NOT EXISTS status VARCHAR(50);

ALTER TABLE session_runs
ADD COLUMN IF NOT EXISTS error_message TEXT;

UPDATE session_runs
SET status = 'completed'
WHERE status IS NULL;

ALTER TABLE session_runs
ALTER COLUMN status SET DEFAULT 'running';

CREATE UNIQUE INDEX IF NOT EXISTS session_runs_active_unique_idx
ON session_runs (
    profile_id,
    interest_group_id,
    repeat_index,
    provider_name,
    model_name
)
WHERE status IN ('running', 'completed');


-- 4. General prompt answer metadata
ALTER TABLE general_prompt_answers
ADD COLUMN IF NOT EXISTS completion_id VARCHAR(255);

ALTER TABLE general_prompt_answers
ADD COLUMN IF NOT EXISTS sources_json JSONB;

ALTER TABLE general_prompt_answers
ADD COLUMN IF NOT EXISTS repeat_index INT;

ALTER TABLE general_prompt_answers
ADD COLUMN IF NOT EXISTS provider_name VARCHAR(100);

UPDATE general_prompt_answers g
SET repeat_index = sr.repeat_index
FROM session_runs sr
WHERE g.session_id = sr.session_id
  AND g.repeat_index IS NULL;

UPDATE general_prompt_answers
SET repeat_index = 1
WHERE repeat_index IS NULL;

UPDATE general_prompt_answers
SET provider_name = 'openai'
WHERE provider_name IS NULL;

ALTER TABLE general_prompt_answers
ALTER COLUMN repeat_index SET DEFAULT 1;

CREATE UNIQUE INDEX IF NOT EXISTS general_prompt_answers_session_unique_idx
ON general_prompt_answers (session_id);


-- 5. Constraint prompt answer metadata and stable group reference
ALTER TABLE constraint_prompt_answers
ADD COLUMN IF NOT EXISTS interest_group_id INT;

UPDATE constraint_prompt_answers c
SET interest_group_id = ti.interest_group_id
FROM travel_interests ti
WHERE c.interest_id = ti.interest_id
  AND c.interest_group_id IS NULL;

ALTER TABLE constraint_prompt_answers
ADD COLUMN IF NOT EXISTS completion_id VARCHAR(255);

ALTER TABLE constraint_prompt_answers
ADD COLUMN IF NOT EXISTS sources_json JSONB;

ALTER TABLE constraint_prompt_answers
ADD COLUMN IF NOT EXISTS repeat_index INT;

ALTER TABLE constraint_prompt_answers
ADD COLUMN IF NOT EXISTS provider_name VARCHAR(100);

UPDATE constraint_prompt_answers c
SET repeat_index = sr.repeat_index
FROM session_runs sr
WHERE c.session_id = sr.session_id
  AND c.repeat_index IS NULL;

UPDATE constraint_prompt_answers
SET repeat_index = 1
WHERE repeat_index IS NULL;

UPDATE constraint_prompt_answers
SET provider_name = 'openai'
WHERE provider_name IS NULL;

ALTER TABLE constraint_prompt_answers
ALTER COLUMN repeat_index SET DEFAULT 1;

CREATE UNIQUE INDEX IF NOT EXISTS constraint_prompt_answers_session_interest_unique_idx
ON constraint_prompt_answers (session_id, interest_id);


-- 6. Comparison prompt answer metadata and stable group reference
ALTER TABLE comparison_prompt_results
ADD COLUMN IF NOT EXISTS interest_group_id INT;

UPDATE comparison_prompt_results c
SET interest_group_id = ti.interest_group_id
FROM travel_interests ti
WHERE c.interest_id = ti.interest_id
  AND c.interest_group_id IS NULL;

ALTER TABLE comparison_prompt_results
ADD COLUMN IF NOT EXISTS completion_id VARCHAR(255);

ALTER TABLE comparison_prompt_results
ADD COLUMN IF NOT EXISTS sources_json JSONB;

ALTER TABLE comparison_prompt_results
ADD COLUMN IF NOT EXISTS repeat_index INT;

ALTER TABLE comparison_prompt_results
ADD COLUMN IF NOT EXISTS provider_name VARCHAR(100);

UPDATE comparison_prompt_results c
SET repeat_index = sr.repeat_index
FROM session_runs sr
WHERE c.session_id = sr.session_id
  AND c.repeat_index IS NULL;

UPDATE comparison_prompt_results
SET repeat_index = 1
WHERE repeat_index IS NULL;

UPDATE comparison_prompt_results
SET provider_name = 'openai'
WHERE provider_name IS NULL;

ALTER TABLE comparison_prompt_results
ADD COLUMN IF NOT EXISTS provider_name VARCHAR(100);

ALTER TABLE comparison_prompt_results
ALTER COLUMN repeat_index SET DEFAULT 1;

CREATE UNIQUE INDEX IF NOT EXISTS comparison_prompt_results_session_unique_idx
ON comparison_prompt_results (session_id);

ALTER TABLE comparison_prompt_results
ALTER COLUMN interest_id DROP NOT NULL;


-- 7. Live per-request logging for thread-like inspection and token usage
CREATE TABLE IF NOT EXISTS request_logs (
    request_log_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id VARCHAR(255) NOT NULL,
    profile_id INT,
    interest_group_id INT,
    interest_id INT,
    request_order INT NOT NULL,
    request_kind VARCHAR(50) NOT NULL,
    branch_label VARCHAR(255),
    season_name VARCHAR(100),
    travel_time_frame VARCHAR(255),
    repeat_index INT NOT NULL DEFAULT 1,
    destination_name VARCHAR(255),
    provider_name VARCHAR(100),
    model_name VARCHAR(100),
    run_notes TEXT,
    status VARCHAR(50) NOT NULL DEFAULT 'started',
    prompt_text TEXT,
    message_history_json JSONB,
    completion_id VARCHAR(255),
    provider_request_id VARCHAR(255),
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
