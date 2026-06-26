-- Aligns the live DB with "AI_Visibility_prompt_library_motivacio_v2.xlsx".
-- 1. adds a motivation phrase per thematic group (used by L3 and as the default L2 fallback)
-- 2. replaces the profiles with the 12 motivation-library FLC profiles (Lake Balaton)

-- 1. Motivation phrase per product group --------------------------------------
ALTER TABLE interest_groups
ADD COLUMN IF NOT EXISTS motivation TEXT;

UPDATE interest_groups SET motivation = 'relax, unwind and recharge through wellness and spa experiences'        WHERE interest_group_id = 1; -- Wellness
UPDATE interest_groups SET motivation = 'experience local food, wine and culinary traditions'                   WHERE interest_group_id = 2; -- Gastronomy
UPDATE interest_groups SET motivation = 'be physically active and enjoy outdoor sport and adventure'            WHERE interest_group_id = 3; -- Active tourism
UPDATE interest_groups SET motivation = 'improve my health and recovery through medical, thermal or healing treatments' WHERE interest_group_id = 4; -- Health tourism
UPDATE interest_groups SET motivation = 'discover culture, heritage, history and local events'                  WHERE interest_group_id = 5; -- Culture and events
UPDATE interest_groups SET motivation = 'connect with nature, scenery and the outdoors'                         WHERE interest_group_id = 6; -- Nature and ecotourism
UPDATE interest_groups SET motivation = 'experience authentic rural life and local farming'                     WHERE interest_group_id = 7; -- Agritourism
UPDATE interest_groups SET motivation = 'enjoy the lakeshore, beaches and waterfront recreation'                WHERE interest_group_id = 8; -- Waterfront recreation / beach

-- 2. The 12 motivation-library profiles (all anchored to Lake Balaton) ---------
-- travel_party stores the final prompt-ready English phrase used directly in the template literal.
INSERT INTO profiles (
    profile_id, profile_name, profile_language, age, gender,
    travel_party, stay_nights, budget_per_day_eur, price_sensitivity, destination_name
) VALUES
    (1,  'Fiatal egyedülálló',             'EN', 25, 'man',   'on my own',                                                                 3, 100.00, 'közepes',  'Lake Balaton'),
    (2,  'Fiatal pár, gyermektelen',       'EN', 30, 'woman', 'with my partner',                                                           3, 200.00, 'alacsony', 'Lake Balaton'),
    (3,  'Család kisgyermekkel',           'EN', 34, 'man',   'with my partner and our young child',                                       7,  50.00, 'magas',    'Lake Balaton'),
    (4,  'Család iskoláskorú gyermekkel',  'EN', 42, 'man',   'with my partner and our children',                                          7, 100.00, 'közepes',  'Lake Balaton'),
    (5,  'Egyedülálló szülő',              'EN', 38, 'woman', 'with my child, as a single parent',                                         5,  50.00, 'magas',    'Lake Balaton'),
    (6,  'Fiatal baráti társaság',         'EN', 25, 'man',   'with a group of friends',                                                   3, 100.00, 'közepes',  'Lake Balaton'),
    (7,  'Középkorú pár, gyermektelen',    'EN', 48, 'woman', 'with my partner',                                                           5, 200.00, 'alacsony', 'Lake Balaton'),
    (8,  'Üres fészek, aktív (dolgozó)',   'EN', 56, 'man',   'with my partner',                                                           7, 200.00, 'alacsony', 'Lake Balaton'),
    (9,  'Nyugdíjas pár',                  'EN', 67, 'woman', 'with my partner',                                                           7, 100.00, 'közepes',  'Lake Balaton'),
    (10, 'Idős egyedülálló',               'EN', 72, 'woman', 'on my own',                                                                 4, 100.00, 'közepes',  'Lake Balaton'),
    (11, 'Többgenerációs család',          'EN', 45, 'woman', 'as a three-generation family, together with grandparents, parents and children', 7, 100.00, 'közepes',  'Lake Balaton'),
    (12, 'Aktív szenior baráti társaság',  'EN', 62, 'man',   'with a group of friends',                                                   5, 100.00, 'közepes',  'Lake Balaton')
ON CONFLICT (profile_id) DO UPDATE SET
    profile_name       = EXCLUDED.profile_name,
    profile_language   = EXCLUDED.profile_language,
    age                = EXCLUDED.age,
    gender             = EXCLUDED.gender,
    travel_party       = EXCLUDED.travel_party,
    stay_nights        = EXCLUDED.stay_nights,
    budget_per_day_eur = EXCLUDED.budget_per_day_eur,
    price_sensitivity  = EXCLUDED.price_sensitivity,
    destination_name   = EXCLUDED.destination_name;
