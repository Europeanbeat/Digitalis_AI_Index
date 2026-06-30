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
