-- Job-description matching, per-user match thresholds, and structured names.
--
-- The central change: an application is no longer recorded on "the filter matched". It
-- carries a score against the actual job description, and the score that let it through is
-- stored beside it. Two reasons that matters more than it looks:
--
--   1. The threshold is a floor the API enforces at the write, the same place the daily cap
--      and exclude list are enforced. A worker that scored generously cannot get a weak match
--      into the record.
--   2. The breakdown is stored, so "why did we apply to this?" is answerable months later
--      without re-fetching a job posting that may no longer exist.

-- --- structured name -------------------------------------------------------------------
-- full_name stays as the display value and remains the column everything else reads. The
-- parts are additive so no existing row or query breaks.
ALTER TABLE users
  ADD COLUMN first_name  VARCHAR(80)  NULL AFTER full_name,
  ADD COLUMN middle_name VARCHAR(80)  NULL AFTER first_name,
  ADD COLUMN last_name   VARCHAR(80)  NULL AFTER middle_name;

-- Backfill from full_name so existing records are not left half-populated: first token is
-- the given name, last token the family name, anything between is the middle.
UPDATE users
   SET first_name = SUBSTRING_INDEX(full_name, ' ', 1),
       last_name  = CASE WHEN full_name LIKE '% %'
                         THEN SUBSTRING_INDEX(full_name, ' ', -1)
                         ELSE NULL END,
       middle_name = CASE
         WHEN CHAR_LENGTH(full_name) - CHAR_LENGTH(REPLACE(full_name, ' ', '')) >= 2
         THEN TRIM(SUBSTRING(
                full_name,
                CHAR_LENGTH(SUBSTRING_INDEX(full_name, ' ', 1)) + 2,
                CHAR_LENGTH(full_name)
                  - CHAR_LENGTH(SUBSTRING_INDEX(full_name, ' ', 1))
                  - CHAR_LENGTH(SUBSTRING_INDEX(full_name, ' ', -1)) - 2))
         ELSE NULL END
 WHERE first_name IS NULL;

-- --- match threshold -------------------------------------------------------------------
-- Per user, because a niche senior role and a broad mid-level one cannot share a bar. 95 is
-- the default; the API refuses anything below MIN_ALLOWED_MATCH_SCORE regardless.
ALTER TABLE users
  ADD COLUMN min_match_score TINYINT UNSIGNED NOT NULL DEFAULT 95
    AFTER min_minutes_between_applications;

-- --- resume text -----------------------------------------------------------------------
-- Matching needs the prose, not just the extracted skill list: titles, seniority wording and
-- domain vocabulary all live in the body and are what separates a 92 from a 97.
ALTER TABLE resumes
  ADD COLUMN raw_text MEDIUMTEXT NULL AFTER parsed;

-- --- the score on the application ------------------------------------------------------
ALTER TABLE applications
  ADD COLUMN match_score     TINYINT UNSIGNED NULL AFTER resume_id,
  ADD COLUMN match_breakdown JSON             NULL AFTER match_score;

CREATE INDEX ix_applications_user_score ON applications (user_id, match_score);

-- --- run counters ----------------------------------------------------------------------
-- Without this, a day that applied to 4 of 200 looks identical to a day that found nothing,
-- and there is no way to tell "the bar is too high" from "the search returned nothing".
ALTER TABLE automation_runs
  ADD COLUMN jobs_scored          INT UNSIGNED NOT NULL DEFAULT 0 AFTER jobs_matched,
  ADD COLUMN jobs_below_threshold INT UNSIGNED NOT NULL DEFAULT 0 AFTER jobs_scored,
  ADD COLUMN best_score_missed    TINYINT UNSIGNED NULL AFTER jobs_below_threshold;
