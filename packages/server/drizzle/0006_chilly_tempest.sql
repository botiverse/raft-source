-- Remove duplicate channels (keep the oldest one per server_id+name+type)
DELETE FROM channels
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY server_id, name, type ORDER BY created_at ASC) AS rn
    FROM channels
  ) dupes
  WHERE rn > 1
);

CREATE UNIQUE INDEX "idx_channels_server_name_type" ON "channels" USING btree ("server_id","name","type");