-- The UNIQUE constraint on upgrade_pairs already provides the full cache lookup
-- index. The shorter duplicate index added write amplification without serving a
-- query that the unique index could not satisfy.
DROP INDEX IF EXISTS idx_pairs_lookup;
