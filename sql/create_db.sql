

CREATE TABLE profiles (
    profile_id INT PRIMARY KEY, -- profilazonosító : P01, P02, stb 
    profile_name VARCHAR(255) NOT NULL, -- pl. "Fiatal pár"
    origin_country VARCHAR(255), -- származási ország
    profile_language VARCHAR(50), -- prompt nyelve pl HU 
    age INT, -- életkor
    gender VARCHAR(100), -- nem / identitás
    travel_party VARCHAR(100), -- utazótárs típusa, pl. párban, egyedül, családdal, barátokkal
    stay_nights INT, -- tartózkodás hossza éjszakában
    budget_per_day_eur DECIMAL(10, 2), -- napi költségkeret euróban 
    price_sensitivity VARCHAR(100), -- árérzékenység, pl. alacsony / közepes / magas
    destination_name VARCHAR(255) -- útazási desztináció
);


CREATE TABLE travel_interests (
    interest_id INT PRIMARY KEY, -- Motivációs id 
    interest_type VARCHAR(255) NOT NULL, -- pl. wellness, gasztronómia
    interest_attributes TEXT, -- pl. spa, szauna, borászat, túraútvonalak
    season_name VARCHAR(100), -- pl. nyár, ősz, tél, tavasz
    travel_time_frame VARCHAR(255) -- pl. "Június és Augusztus között"
);


CREATE TABLE general_prompt_answers (
    general_answer_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, -- automatikusan generált válaszazonosító
    profile_id INT NOT NULL REFERENCES profiles(profile_id), -- melyik profilhoz tartozik
    destination_name VARCHAR(255), -- a futáskor használt desztináció neve
    model_name VARCHAR(100), -- melyik modell adta a választ, pl. GPT / Gemini
    session_id VARCHAR(255), -- az adott futás közös session / thread azonosítója
    prompt_text TEXT, -- a ténylegesen elküldött általános prompt
    general_prompt_answer TEXT, -- a modell nyers válasza
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP -- mentés időpontja
);


CREATE TABLE constraint_prompt_answers (
    constraint_answer_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, -- automatikusan generált válaszazonosító
    profile_id INT NOT NULL REFERENCES profiles(profile_id), -- melyik profilhoz tartozik
    interest_id INT NOT NULL REFERENCES travel_interests(interest_id), -- melyik érdeklődési / szezon variánshoz tartozik
    destination_name VARCHAR(255), -- Általános promptban lévő desztináció neve
    interest_type VARCHAR(255), -- érdeklődési típus, pl. wellness
    season_name VARCHAR(100), -- szezon neve, pl. nyár
    travel_time_frame VARCHAR(255), -- időablak, pl. "Június és Augusztus között"
    model_name VARCHAR(100), -- melyik modell adta a választ
    session_id VARCHAR(255), -- az adott 6 promptos futás közös session / thread azonosítója
    prompt_text TEXT, -- a ténylegesen elküldött követő prompt
    constraint_prompt_answer TEXT, -- a modell nyers válasza
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP -- mentés időpontja
);


CREATE TABLE comparison_prompt_results (
    comparison_answer_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, -- automatikusan generált válaszazonosító
    profile_id INT NOT NULL REFERENCES profiles(profile_id), -- melyik profilhoz tartozik
    interest_id INT NOT NULL REFERENCES travel_interests(interest_id), -- melyik USP / szezon logikához kapcsolódik
    destination_name VARCHAR(255), -- kiinduló desztináció, pl. Balaton
    interest_type VARCHAR(255), -- összehasonlított érdeklődési típus
    season_name VARCHAR(100), -- szezon neve
    travel_time_frame VARCHAR(255), -- időablak
    model_name VARCHAR(100), -- melyik modell adta a választ
    session_id VARCHAR(255), -- az adott 6 promptos futás közös session / thread azonosítója
    prompt_text TEXT, -- a ténylegesen elküldött összehasonlító prompt
    comparison_prompt_answer TEXT, -- a modell nyers válasza
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP -- mentés időpontja
);
