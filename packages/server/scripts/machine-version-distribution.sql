-- Computer and daemon version distributions are intentionally independent.
-- NULL and local-development versions share one dev/unknown bucket.

SELECT
  CASE
    WHEN computer_version IS NULL OR BTRIM(computer_version) IN ('', '0.0.0-dev')
      THEN 'dev/unknown'
    ELSE computer_version
  END AS computer_version_bucket,
  COUNT(*)::bigint AS machine_count
FROM daemons
GROUP BY 1
ORDER BY machine_count DESC, computer_version_bucket ASC;

SELECT
  CASE
    WHEN daemon_version IS NULL OR BTRIM(daemon_version) IN ('', '0.0.0-dev')
      THEN 'dev/unknown'
    ELSE daemon_version
  END AS daemon_version_bucket,
  COUNT(*)::bigint AS machine_count
FROM daemons
GROUP BY 1
ORDER BY machine_count DESC, daemon_version_bucket ASC;
