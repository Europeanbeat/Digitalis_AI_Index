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
    (7, 'Agritourism', 'experience authentic rural life and local farming'),
    (8, 'Waterfront recreation / beach', 'enjoy the lakeshore, beaches and waterfront recreation')
ON CONFLICT (interest_group_id) DO UPDATE SET
    interest_type = EXCLUDED.interest_type,
    motivation = EXCLUDED.motivation;


INSERT INTO travel_interests (
    interest_id,
    interest_group_id,
    season_name,
    motivation,
    travel_time_frame
) VALUES
    (1, 1, 'Summer', 'relax, unwind and recharge through wellness and spa experiences', 'between June and August'),
    (2, 1, 'Autumn', 'relax, unwind and recharge through wellness and spa experiences', 'between September and November'),
    (3, 1, 'Winter', 'relax, unwind and recharge through wellness and spa experiences', 'between December and February'),
    (4, 1, 'Spring', 'relax, unwind and recharge through wellness and spa experiences', 'between March and May'),
    (5, 2, 'Summer', 'experience local food, wine and culinary traditions', 'between June and August'),
    (6, 2, 'Autumn', 'experience local food, wine and culinary traditions', 'between September and November'),
    (7, 2, 'Winter', 'experience local food, wine and culinary traditions', 'between December and February'),
    (8, 2, 'Spring', 'experience local food, wine and culinary traditions', 'between March and May'),
    (9, 3, 'Summer', 'be physically active and enjoy outdoor sport and adventure', 'between June and August'),
    (10, 3, 'Autumn', 'be physically active and enjoy outdoor sport and adventure', 'between September and November'),
    (11, 3, 'Winter', 'be physically active and enjoy outdoor sport and adventure', 'between December and February'),
    (12, 3, 'Spring', 'be physically active and enjoy outdoor sport and adventure', 'between March and May'),
    (13, 4, 'Summer', 'improve my health and recovery through medical, thermal or healing treatments', 'between June and August'),
    (14, 4, 'Autumn', 'improve my health and recovery through medical, thermal or healing treatments', 'between September and November'),
    (15, 4, 'Winter', 'improve my health and recovery through medical, thermal or healing treatments', 'between December and February'),
    (16, 4, 'Spring', 'improve my health and recovery through medical, thermal or healing treatments', 'between March and May'),
    (17, 5, 'Summer', 'discover culture, heritage, history and local events', 'between June and August'),
    (18, 5, 'Autumn', 'discover culture, heritage, history and local events', 'between September and November'),
    (19, 5, 'Winter', 'discover culture, heritage, history and local events', 'between December and February'),
    (20, 5, 'Spring', 'discover culture, heritage, history and local events', 'between March and May'),
    (21, 6, 'Summer', 'connect with nature, scenery and the outdoors', 'between June and August'),
    (22, 6, 'Autumn', 'connect with nature, scenery and the outdoors', 'between September and November'),
    (23, 6, 'Winter', 'connect with nature, scenery and the outdoors', 'between December and February'),
    (24, 6, 'Spring', 'connect with nature, scenery and the outdoors', 'between March and May'),
    (25, 7, 'Summer', 'experience authentic rural life and local farming', 'between June and August'),
    (26, 7, 'Autumn', 'experience authentic rural life and local farming', 'between September and November'),
    (27, 7, 'Winter', 'experience authentic rural life and local farming', 'between December and February'),
    (28, 7, 'Spring', 'experience authentic rural life and local farming', 'between March and May'),
    (29, 8, 'Summer', 'swim, sunbathe and relax on the lakeshore beaches', 'between June and August'),
    (30, 8, 'Autumn', 'enjoy late-season swims and relaxed strolls along the lakeshore', 'between September and November'),
    (31, 8, 'Winter', 'take winter lakeshore walks and enjoy the calm waterfront scenery', 'between December and February'),
    (32, 8, 'Spring', 'enjoy waterfront walks and the first swims of the season along the lakeshore', 'between March and May')
ON CONFLICT (interest_id) DO UPDATE SET
    interest_group_id = EXCLUDED.interest_group_id,
    season_name = EXCLUDED.season_name,
    motivation = EXCLUDED.motivation,
    travel_time_frame = EXCLUDED.travel_time_frame;
