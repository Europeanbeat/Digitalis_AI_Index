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


INSERT INTO travel_interests (
    interest_id,
    interest_group_id,
    season_name,
    travel_time_frame
) VALUES
    (1, 1, 'Summer', 'between June and August'),
    (2, 1, 'Autumn', 'between September and November'),
    (3, 1, 'Winter', 'between December and February'),
    (4, 1, 'Spring', 'between March and May'),
    (5, 2, 'Summer', 'between June and August'),
    (6, 2, 'Autumn', 'between September and November'),
    (7, 2, 'Winter', 'between December and February'),
    (8, 2, 'Spring', 'between March and May'),
    (9, 3, 'Summer', 'between June and August'),
    (10, 3, 'Autumn', 'between September and November'),
    (11, 3, 'Winter', 'between December and February'),
    (12, 3, 'Spring', 'between March and May'),
    (13, 4, 'Summer', 'between June and August'),
    (14, 4, 'Autumn', 'between September and November'),
    (15, 4, 'Winter', 'between December and February'),
    (16, 4, 'Spring', 'between March and May'),
    (17, 5, 'Summer', 'between June and August'),
    (18, 5, 'Autumn', 'between September and November'),
    (19, 5, 'Winter', 'between December and February'),
    (20, 5, 'Spring', 'between March and May'),
    (21, 6, 'Summer', 'between June and August'),
    (22, 6, 'Autumn', 'between September and November'),
    (23, 6, 'Winter', 'between December and February'),
    (24, 6, 'Spring', 'between March and May'),
    (25, 7, 'Summer', 'between June and August'),
    (26, 7, 'Autumn', 'between September and November'),
    (27, 7, 'Winter', 'between December and February'),
    (28, 7, 'Spring', 'between March and May')
ON CONFLICT (interest_id) DO UPDATE SET
    interest_group_id = EXCLUDED.interest_group_id,
    season_name = EXCLUDED.season_name,
    travel_time_frame = EXCLUDED.travel_time_frame;
