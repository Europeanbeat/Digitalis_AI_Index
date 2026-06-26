-- Cleanup migration: remove the legacy interest_attributes column.
-- The active prompt logic uses group-level motivation plus optional
-- seasonal travel_interests.motivation overrides.

ALTER TABLE interest_groups
DROP COLUMN IF EXISTS interest_attributes;
