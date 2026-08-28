ALTER TABLE "users" ADD COLUMN "flair" text;--> statement-breakpoint
-- Existing rows already carry their features, so the colour can be filled in
-- without waiting for everyone to sign in again. Later flairs win, matching the
-- source order of the upstream stylesheet.
UPDATE "users" SET "flair" = CASE
    WHEN dgg_features @> ARRAY['flair17']::text[] THEN 'flair17'
    WHEN dgg_features @> ARRAY['admin']::text[] THEN 'admin'
    WHEN dgg_features @> ARRAY['flair18']::text[] THEN 'flair18'
    WHEN dgg_features @> ARRAY['flair33']::text[] THEN 'flair33'
    WHEN dgg_features @> ARRAY['flair42']::text[] THEN 'flair42'
    WHEN dgg_features @> ARRAY['flair7']::text[] THEN 'flair7'
    WHEN dgg_features @> ARRAY['flair12']::text[] THEN 'flair12'
    WHEN dgg_features @> ARRAY['flair26']::text[] THEN 'flair26'
    WHEN dgg_features @> ARRAY['flair8']::text[] THEN 'flair8'
    WHEN dgg_features @> ARRAY['flair24']::text[] THEN 'flair24'
    WHEN dgg_features @> ARRAY['flair3']::text[] THEN 'flair3'
    WHEN dgg_features @> ARRAY['flair22']::text[] THEN 'flair22'
    WHEN dgg_features @> ARRAY['flair1']::text[] THEN 'flair1'
    WHEN dgg_features @> ARRAY['flair32']::text[] THEN 'flair32'
    WHEN dgg_features @> ARRAY['flair13']::text[] THEN 'flair13'
    WHEN dgg_features @> ARRAY['flair9']::text[] THEN 'flair9'
    WHEN dgg_features @> ARRAY['subscriber']::text[] THEN 'subscriber'
    WHEN dgg_features @> ARRAY['bot']::text[] THEN 'bot'
    WHEN dgg_features @> ARRAY['flair11']::text[] THEN 'flair11'
    WHEN dgg_features @> ARRAY['flair125']::text[] THEN 'flair125'
    WHEN dgg_features @> ARRAY['moderator']::text[] THEN 'moderator'
    ELSE NULL
  END;
