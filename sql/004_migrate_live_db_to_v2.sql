-- Live migration for the existing digital_ai_index_db schema.
-- Purpose:
-- 1. introduce interest_groups
-- 2. link seasonal travel_interests rows to a stable interest_group_id
-- 3. introduce session_runs
-- 4. add metadata fields needed by the updated session_flow.js


-- 1. Stable product-group table
CREATE TABLE IF NOT EXISTS interest_groups (
    interest_group_id INT PRIMARY KEY,
    interest_type VARCHAR(255) NOT NULL UNIQUE,
    interest_attributes TEXT,
    motivation TEXT
);

ALTER TABLE interest_groups
ADD COLUMN IF NOT EXISTS motivation TEXT;

INSERT INTO interest_groups (
    interest_group_id,
    interest_type,
    interest_attributes,
    motivation
) VALUES
    (1, 'Wellness', 'massage salons, sauna world, relaxation, and spa hotels', 'relax, unwind and recharge through wellness and spa experiences'),
    (2, 'Gastronomy', 'wineries, farmers markets, fine dining, and local specialties', 'experience local food, wine and culinary traditions'),
    (3, 'Active tourism', 'cycling, sailing, hiking trails, and water sports', 'be physically active and enjoy outdoor sport and adventure'),
    (4, 'Health tourism', 'thermal water, medical rehabilitation, healing treatments, and physiotherapy', 'improve my health and recovery through medical, thermal or healing treatments'),
    (5, 'Culture and events', 'castles, festivals, museums, historical landmarks, and churches', 'discover culture, heritage, history and local events'),
    (6, 'Nature and ecotourism', 'national parks, nature trails, birdwatching, untouched landscapes, and camping', 'connect with nature, scenery and the outdoors'),
    (7, 'Agritourism', 'farm stays, grape harvest experiences, craft workshops, and rural lifestyle activities', 'experience authentic rural life and local farming')
ON CONFLICT (interest_group_id) DO UPDATE SET
    interest_type = EXCLUDED.interest_type,
    interest_attributes = EXCLUDED.interest_attributes,
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
ALTER COLUMN repeat_index SET DEFAULT 1;

ALTER TABLE comparison_prompt_results
ALTER COLUMN interest_id DROP NOT NULL;
