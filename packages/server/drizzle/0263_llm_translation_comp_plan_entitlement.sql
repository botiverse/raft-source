-- Founder and Partner are comp plans that must always carry at least Pro
-- entitlement (@stdrc, 2026-09-07, #proj-billing msg=2a014393). Migration 0261
-- seeded this gate with values '["pro"]' only, so `canUseProBillingFeatures`
-- (pro + founder + partner) and this rule disagreed: the plan stage matches the
-- literal `entitlement.plan`, which is never normalized to "pro", so Founder and
-- Partner servers fell through to the flag default and lost translation the
-- moment an environment resolves the OpenAI-compatible provider.
UPDATE "feature_flag_rules"
SET "values" = '["pro","founder","partner"]'::jsonb,
    "updated_at" = now()
WHERE "flag_key" = 'llm_translation_v0'
  AND "stage" = 'plan'
  AND "decision" = 'allow';
