-- Egy darab mintaprofil beszúrása a profiles táblába.
-- Itt szándékosan "prompt-ready" értékek szerepelnek,
-- hogy később könnyen be lehessen rakni template literalba.

INSERT INTO profiles (
    profile_id,
    profile_name,
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
    'Young couple (male)',
    'EN',
    25,
    'Male',
    'with my partner',
    3,
    100.00,
    'medium',
    'Lake Balaton'
);
