CREATE TABLE IF NOT EXISTS claude_batch_runs (
    batch_run_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    batch_id VARCHAR(255) NOT NULL UNIQUE,
    pass_type VARCHAR(50) NOT NULL,
    destination_name VARCHAR(255),
    provider_name VARCHAR(100),
    model_name VARCHAR(100),
    run_notes TEXT,
    processing_status VARCHAR(50) NOT NULL,
    request_counts_json JSONB,
    raw_batch_json JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP,
    synced_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS claude_batch_runs_status_idx
ON claude_batch_runs (processing_status, created_at DESC);

CREATE TABLE IF NOT EXISTS claude_batch_requests (
    batch_request_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    batch_id VARCHAR(255),
    custom_id VARCHAR(255) NOT NULL UNIQUE,
    pass_type VARCHAR(50) NOT NULL,
    session_id VARCHAR(255) NOT NULL,
    profile_id INT NOT NULL REFERENCES profiles(profile_id),
    interest_group_id INT NOT NULL REFERENCES interest_groups(interest_group_id),
    interest_id INT REFERENCES travel_interests(interest_id),
    request_order INT NOT NULL,
    request_kind VARCHAR(50) NOT NULL,
    branch_label VARCHAR(255),
    interest_type VARCHAR(255),
    season_name VARCHAR(100),
    travel_time_frame VARCHAR(255),
    repeat_index INT NOT NULL DEFAULT 1,
    destination_name VARCHAR(255),
    provider_name VARCHAR(100),
    model_name VARCHAR(100),
    run_notes TEXT,
    status VARCHAR(50) NOT NULL DEFAULT 'queued',
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
