-- Egy darab mintaprofil beszúrása a profiles táblába.
-- Itt szándékosan "prompt-ready" értékek szerepelnek,
-- hogy később könnyen be lehessen rakni template literalba.

INSERT INTO profiles (
    profile_id,
    profile_name,
    origin_country,
    profile_language,
    age,
    gender,
    travel_party,
    stay_nights,
    budget_per_day_eur,
    price_sensitivity,
    destination_name
) VALUES (
    1,
    'Fiatal pár (férfi)',
    'Magyarországról',
    'HU',
    25,
    'Férfi',
    'párommal',
    2,
    100.00,
    'közepes',
    'Balatonra'
);
