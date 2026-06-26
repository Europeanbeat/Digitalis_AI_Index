-- Adds the Waterfront recreation / beach group and the seasonal L2
-- motivations needed by the v3 prompt library.
-- Safe to run manually after taking a backup.

ALTER TABLE travel_interests
ADD COLUMN IF NOT EXISTS motivation TEXT;

INSERT INTO interest_groups (
    interest_group_id,
    interest_type,
    motivation
) VALUES (
    8,
    'Waterfront recreation / beach',
    'enjoy the lakeshore, beaches and waterfront recreation'
)
ON CONFLICT (interest_group_id) DO UPDATE SET
    interest_type = EXCLUDED.interest_type,
    motivation = EXCLUDED.motivation;

-- Keep the first 7 groups explicit too, so L2 prompt wording remains
-- materialized at the seasonal-row level after the cleanup/migration path.
UPDATE travel_interests ti
SET motivation = ig.motivation
FROM interest_groups ig
WHERE ig.interest_group_id = ti.interest_group_id
  AND ti.interest_group_id BETWEEN 1 AND 7;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'travel_interests'
          AND column_name = 'interest_type'
    ) THEN
        INSERT INTO travel_interests (
            interest_id,
            interest_type,
            season_name,
            travel_time_frame,
            interest_group_id,
            motivation
        ) VALUES
            (29, 'Waterfront recreation / beach', 'Summer', 'between June and August', 8, 'swim, sunbathe and relax on the lakeshore beaches'),
            (30, 'Waterfront recreation / beach', 'Autumn', 'between September and November', 8, 'enjoy late-season swims and relaxed strolls along the lakeshore'),
            (31, 'Waterfront recreation / beach', 'Winter', 'between December and February', 8, 'take winter lakeshore walks and enjoy the calm waterfront scenery'),
            (32, 'Waterfront recreation / beach', 'Spring', 'between March and May', 8, 'enjoy waterfront walks and the first swims of the season along the lakeshore')
        ON CONFLICT (interest_id) DO UPDATE SET
            interest_type = EXCLUDED.interest_type,
            season_name = EXCLUDED.season_name,
            travel_time_frame = EXCLUDED.travel_time_frame,
            interest_group_id = EXCLUDED.interest_group_id,
            motivation = EXCLUDED.motivation;
    ELSE
        INSERT INTO travel_interests (
            interest_id,
            interest_group_id,
            season_name,
            motivation,
            travel_time_frame
        ) VALUES
            (29, 8, 'Summer', 'swim, sunbathe and relax on the lakeshore beaches', 'between June and August'),
            (30, 8, 'Autumn', 'enjoy late-season swims and relaxed strolls along the lakeshore', 'between September and November'),
            (31, 8, 'Winter', 'take winter lakeshore walks and enjoy the calm waterfront scenery', 'between December and February'),
            (32, 8, 'Spring', 'enjoy waterfront walks and the first swims of the season along the lakeshore', 'between March and May')
        ON CONFLICT (interest_id) DO UPDATE SET
            interest_group_id = EXCLUDED.interest_group_id,
            season_name = EXCLUDED.season_name,
            motivation = EXCLUDED.motivation,
            travel_time_frame = EXCLUDED.travel_time_frame;
    END IF;
END $$;
