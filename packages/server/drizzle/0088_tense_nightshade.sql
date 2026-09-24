ALTER TABLE "product_events" DROP CONSTRAINT "product_events_subject_type_whitelist";--> statement-breakpoint
ALTER TABLE "product_events" DROP CONSTRAINT "product_events_event_type_whitelist";--> statement-breakpoint
ALTER TABLE "product_events" ADD CONSTRAINT "product_events_subject_type_whitelist" CHECK ("product_events"."subject_type" IN ('action_card', 'onboarding_wizard'));--> statement-breakpoint
ALTER TABLE "product_events" ADD CONSTRAINT "product_events_event_type_whitelist" CHECK ("product_events"."event_type" IN (
      'action_card.open',
      'action_card.dismiss',
      'action_card.execute_attempt',
      'action_card.execute_success',
      'action_card.execute_fail',
      'action_card.expired',
      'onboarding_wizard.step_shown',
      'onboarding_wizard.primary_clicked',
      'onboarding_wizard.skip_clicked',
      'onboarding_wizard.dismissed',
      'onboarding_wizard.completed',
      'onboarding_wizard.error'
    ));