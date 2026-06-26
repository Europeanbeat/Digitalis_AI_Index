-- Read-only verification after running 007_add_waterfront_recreation.sql

SELECT COUNT(*) AS interest_groups_count
FROM interest_groups;

SELECT COUNT(*) AS travel_interests_count
FROM travel_interests;

SELECT interest_group_id, interest_type, motivation
FROM interest_groups
ORDER BY interest_group_id;

SELECT interest_id, interest_group_id, season_name, motivation, travel_time_frame
FROM travel_interests
WHERE interest_group_id = 8
ORDER BY interest_id;
