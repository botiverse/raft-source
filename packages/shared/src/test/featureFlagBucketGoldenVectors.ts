/**
 * Golden vectors generated from packages/server's original node:crypto SHA-256
 * computeFeatureFlagBucket implementation (`readUInt32BE(0) % 10_000`).
 *
 * Pinning these vectors ensures any shared evaluator refactor preserves exact
 * percentage-rollout bucket assignments for every existing flag and unit ID.
 */
export type FeatureFlagBucketGoldenVector = {
  readonly note: string;
  readonly salt: string;
  readonly key: string;
  readonly unit: "user" | "server";
  readonly unitId: string;
  readonly bucket: number;
};

export const FEATURE_FLAG_BUCKET_GOLDEN_VECTORS: readonly FeatureFlagBucketGoldenVector[] = [
  {
    "note": "seeded:0124_dashing_drax.sql",
    "salt": "human_activity_mute_v0",
    "key": "human_activity_mute_v0",
    "unit": "server",
    "unitId": "bccd5969-5c94-498c-9221-625f87d5ca12",
    "bucket": 6388
  },
  {
    "note": "seeded:0128_message_forwarding_flag.sql",
    "salt": "message_forwarding_v0",
    "key": "message_forwarding_v0",
    "unit": "server",
    "unitId": "95f993fa-2a68-4797-b8ae-7beb7d984ada",
    "bucket": 9399
  },
  {
    "note": "seeded:0133_agent_activity_kernel_arbitration_flag.sql",
    "salt": "agent_activity_kernel_arbitration_v0",
    "key": "agent_activity_kernel_arbitration_v0",
    "unit": "server",
    "unitId": "33333333-3333-4333-8333-333333333333",
    "bucket": 874
  },
  {
    "note": "seeded:0142_nice_rumiko_fujikawa.sql",
    "salt": "onboarding_opener_v2",
    "key": "onboarding_opener_v2",
    "unit": "server",
    "unitId": "00000000-0000-4000-8000-00000000a101",
    "bucket": 3633
  },
  {
    "note": "seeded:0147_disable_community_onboarding_wizard.sql",
    "salt": "onboarding_owner_wizard_v0",
    "key": "onboarding_owner_wizard_v0",
    "unit": "server",
    "unitId": "bccd5969-5c94-498c-9221-625f87d5ca12",
    "bucket": 9272
  },
  {
    "note": "seeded:0150_agent_migration_flag.sql",
    "salt": "agent_migration_v0",
    "key": "agent_migration_v0",
    "unit": "server",
    "unitId": "95f993fa-2a68-4797-b8ae-7beb7d984ada",
    "bucket": 13
  },
  {
    "note": "seeded:0151_chat_grid_layout_flag.sql",
    "salt": "chat_grid_layout_v0",
    "key": "chat_grid_layout_v0",
    "unit": "server",
    "unitId": "33333333-3333-4333-8333-333333333333",
    "bucket": 4534
  },
  {
    "note": "seeded:0173_read_receipts_flag.sql",
    "salt": "read_receipts_v0",
    "key": "read_receipts_v0",
    "unit": "server",
    "unitId": "00000000-0000-4000-8000-00000000a101",
    "bucket": 7459
  },
  {
    "note": "seeded:0184_mobile_push_delivery_feature_flag.sql",
    "salt": "mobile_push_delivery_v0",
    "key": "mobile_push_delivery_v0",
    "unit": "server",
    "unitId": "bccd5969-5c94-498c-9221-625f87d5ca12",
    "bucket": 5359
  },
  {
    "note": "seeded:0185_grok_runtime_feature_flag.sql",
    "salt": "grok_runtime_v0",
    "key": "grok_runtime_v0",
    "unit": "server",
    "unitId": "95f993fa-2a68-4797-b8ae-7beb7d984ada",
    "bucket": 1971
  },
  {
    "note": "seeded:0191_low_thunderbolt_ross.sql",
    "salt": "wiki_v0",
    "key": "wiki_v0",
    "unit": "server",
    "unitId": "33333333-3333-4333-8333-333333333333",
    "bucket": 2211
  },
  {
    "note": "seeded:0192_server_labs_ui_feature_flag.sql",
    "salt": "server_labs_ui_v0",
    "key": "server_labs_ui_v0",
    "unit": "server",
    "unitId": "00000000-0000-4000-8000-00000000a101",
    "bucket": 7039
  },
  {
    "note": "seeded:0206_activity_v2_feature_flag.sql",
    "salt": "activity_v2",
    "key": "activity_v2",
    "unit": "server",
    "unitId": "bccd5969-5c94-498c-9221-625f87d5ca12",
    "bucket": 4706
  },
  {
    "note": "seeded:0211_apple_web_login_feature_flag.sql",
    "salt": "apple_web_login_v0",
    "key": "apple_web_login_v0",
    "unit": "user",
    "unitId": "95f993fa-2a68-4797-b8ae-7beb7d984ada",
    "bucket": 4029
  },
  {
    "note": "seeded:0217_friendly_lila_cheney.sql",
    "salt": "provider_connections_v0",
    "key": "provider_connections_v0",
    "unit": "server",
    "unitId": "33333333-3333-4333-8333-333333333333",
    "bucket": 5796
  },
  {
    "note": "seeded:0218_runtime_account_usage_flag.sql",
    "salt": "runtime_account_usage_v0",
    "key": "runtime_account_usage_v0",
    "unit": "server",
    "unitId": "00000000-0000-4000-8000-00000000a101",
    "bucket": 3166
  },
  {
    "note": "seeded:0225_mobile_download_flag.sql",
    "salt": "mobile_download_v0",
    "key": "mobile_download_v0",
    "unit": "server",
    "unitId": "bccd5969-5c94-498c-9221-625f87d5ca12",
    "bucket": 631
  },
  {
    "note": "seeded:0234_composer_resource_references_flag.sql",
    "salt": "composer_resource_references_v0",
    "key": "composer_resource_references_v0",
    "unit": "server",
    "unitId": "95f993fa-2a68-4797-b8ae-7beb7d984ada",
    "bucket": 4462
  },
  {
    "note": "seeded:0238_topbar_overflow_and_display_prefs.sql",
    "salt": "topbar_overflow_v0",
    "key": "topbar_overflow_v0",
    "unit": "server",
    "unitId": "33333333-3333-4333-8333-333333333333",
    "bucket": 6125
  },
  {
    "note": "seeded:0252_slack_bridge_launch_gate.sql",
    "salt": "slack_bridge_v0",
    "key": "external_projection_directory",
    "unit": "server",
    "unitId": "00000000-0000-4000-8000-00000000a101",
    "bucket": 2298
  },
  {
    "note": "seeded:0253_absent_mad_thinker.sql",
    "salt": "server_guest_v0",
    "key": "server_guest_v0",
    "unit": "server",
    "unitId": "bccd5969-5c94-498c-9221-625f87d5ca12",
    "bucket": 434
  },
  {
    "note": "seeded:0259_im_reaction_sync.sql",
    "salt": "slack_reaction_sync",
    "key": "slack_reaction_sync",
    "unit": "server",
    "unitId": "95f993fa-2a68-4797-b8ae-7beb7d984ada",
    "bucket": 2556
  },
  {
    "note": "seeded:0261_llm_translation_feature_flag.sql",
    "salt": "llm_translation_v0",
    "key": "llm_translation_v0",
    "unit": "server",
    "unitId": "33333333-3333-4333-8333-333333333333",
    "bucket": 6640
  },
  {
    "note": "seeded:0265_brainy_korath.sql",
    "salt": "public_server_v0",
    "key": "public_server_v0",
    "unit": "server",
    "unitId": "00000000-0000-4000-8000-00000000a101",
    "bucket": 433
  },
  {
    "note": "seeded:0266_channel_joint_conversion.sql",
    "salt": "channel_to_joint_conversion_v0",
    "key": "channel_to_joint_conversion_v0",
    "unit": "server",
    "unitId": "bccd5969-5c94-498c-9221-625f87d5ca12",
    "bucket": 694
  },
  {
    "note": "seeded:0270_tranquil_omega_flight.sql",
    "salt": "provider_computer_probe_v0",
    "key": "provider_computer_probe_v0",
    "unit": "server",
    "unitId": "95f993fa-2a68-4797-b8ae-7beb7d984ada",
    "bucket": 9098
  },
  {
    "note": "seeded:0271_provider_probe_enforcement_flag.sql",
    "salt": "provider_probe_enforcement_v0",
    "key": "provider_probe_enforcement_v0",
    "unit": "server",
    "unitId": "33333333-3333-4333-8333-333333333333",
    "bucket": 6067
  },
  {
    "note": "seeded:0283_attachment_original_storage_v2_feature_flag.sql",
    "salt": "attachment_original_storage_v2",
    "key": "attachment_original_storage_v2",
    "unit": "server",
    "unitId": "00000000-0000-4000-8000-00000000a101",
    "bucket": 4175
  },
  {
    "note": "seeded:0296_antiproton_hosted_runtime.sql",
    "salt": "antiproton_hosted_runtime",
    "key": "antiproton_hosted_runtime",
    "unit": "server",
    "unitId": "bccd5969-5c94-498c-9221-625f87d5ca12",
    "bucket": 5846
  },
  {
    "note": "seeded:0334_colorful_ikaris.sql",
    "salt": "usage_limit_attention_v0",
    "key": "usage_limit_attention_v0",
    "unit": "server",
    "unitId": "95f993fa-2a68-4797-b8ae-7beb7d984ada",
    "bucket": 1801
  },
  {
    "note": "seeded:0347_public_server_search.sql",
    "salt": "public_server_search_index_v0",
    "key": "public_server_search_index_v0",
    "unit": "server",
    "unitId": "33333333-3333-4333-8333-333333333333",
    "bucket": 2578
  },
  {
    "note": "seeded:0353_thread_unread_badge_flag.sql",
    "salt": "thread_unread_badge_v0",
    "key": "thread_unread_badge_v0",
    "unit": "server",
    "unitId": "00000000-0000-4000-8000-00000000a101",
    "bucket": 2690
  },
  {
    "note": "seeded:0358_conversation_read_all.sql",
    "salt": "sidebar_mark_all_read_v0",
    "key": "sidebar_mark_all_read_v0",
    "unit": "server",
    "unitId": "bccd5969-5c94-498c-9221-625f87d5ca12",
    "bucket": 7530
  },
  {
    "note": "seeded:0362_activity_conversation_list_flag.sql",
    "salt": "activity_conversation_list_v0",
    "key": "activity_conversation_list_v0",
    "unit": "server",
    "unitId": "95f993fa-2a68-4797-b8ae-7beb7d984ada",
    "bucket": 5744
  },
  {
    "note": "seeded:0369_mobile_push_fcm_provider.sql",
    "salt": "mobile_push_fcm_v0",
    "key": "mobile_push_fcm_v0",
    "unit": "server",
    "unitId": "33333333-3333-4333-8333-333333333333",
    "bucket": 1965
  },
  {
    "note": "seeded:0421_task_v2_conversations_flag.sql",
    "salt": "task_v2_conversations_v0",
    "key": "task_v2_conversations_v0",
    "unit": "server",
    "unitId": "00000000-0000-4000-8000-00000000a101",
    "bucket": 6236
  },
  {
    "note": "seeded:0436_deep_links_flag.sql",
    "salt": "deep_links_v1",
    "key": "deep_links_v1",
    "unit": "server",
    "unitId": "bccd5969-5c94-498c-9221-625f87d5ca12",
    "bucket": 7739
  },
  {
    "note": "seeded:0440_computers_rack_overview_flag.sql",
    "salt": "computers_rack_overview_v0",
    "key": "computers_rack_overview_v0",
    "unit": "server",
    "unitId": "95f993fa-2a68-4797-b8ae-7beb7d984ada",
    "bucket": 8211
  },
  {
    "note": "seeded:0463_workspace_artifacts.sql",
    "salt": "workspace_artifacts_v0",
    "key": "workspace_artifacts_v0",
    "unit": "server",
    "unitId": "33333333-3333-4333-8333-333333333333",
    "bucket": 5771
  },
  {
    "note": "seeded:0464_continuations_pilot_flag.sql",
    "salt": "continuations_pilot_v0",
    "key": "continuations_pilot_v0",
    "unit": "server",
    "unitId": "00000000-0000-4000-8000-00000000a101",
    "bucket": 4399
  },
  {
    "note": "seeded:0530_drafts_section_flag.sql",
    "salt": "drafts_section_v0",
    "key": "drafts_section_v0",
    "unit": "server",
    "unitId": "bccd5969-5c94-498c-9221-625f87d5ca12",
    "bucket": 1549
  },
  {
    "note": "seeded:0541_idle_task_reminder.sql",
    "salt": "idle_task_reminder_v0",
    "key": "idle_task_reminder_v0",
    "unit": "server",
    "unitId": "95f993fa-2a68-4797-b8ae-7beb7d984ada",
    "bucket": 7939
  },
  {
    "note": "seeded:0551_artifact_version_checks.sql",
    "salt": "artifact_publish_check_v0",
    "key": "artifact_publish_check_v0",
    "unit": "server",
    "unitId": "33333333-3333-4333-8333-333333333333",
    "bucket": 5853
  },
  {
    "note": "seeded:0571_message_card_revisions.sql",
    "salt": "message_cards",
    "key": "message_cards",
    "unit": "server",
    "unitId": "00000000-0000-4000-8000-00000000a101",
    "bucket": 7617
  },
  {
    "note": "seeded:0576_agent_read_progress_flag.sql",
    "salt": "agent_read_progress_v0",
    "key": "agent_read_progress_v0",
    "unit": "server",
    "unitId": "bccd5969-5c94-498c-9221-625f87d5ca12",
    "bucket": 1357
  },
  {
    "note": "seeded:0591_agent_working_line_flag.sql",
    "salt": "agent_working_line",
    "key": "agent_working_line",
    "unit": "server",
    "unitId": "95f993fa-2a68-4797-b8ae-7beb7d984ada",
    "bucket": 7187
  },
  {
    "note": "seeded:0608_channel_thread_sort.sql",
    "salt": "channel_thread_sort_v0",
    "key": "channel_thread_sort_v0",
    "unit": "server",
    "unitId": "33333333-3333-4333-8333-333333333333",
    "bucket": 8809
  },
  {
    "note": "seeded:0668_channel_announcement.sql",
    "salt": "channel_announcement_v0",
    "key": "channel_announcement_v0",
    "unit": "server",
    "unitId": "00000000-0000-4000-8000-00000000a101",
    "bucket": 4094
  },
  {
    "note": "seeded:0677_web_preview_flag.sql",
    "salt": "web_preview_v0",
    "key": "web_preview_v0",
    "unit": "server",
    "unitId": "bccd5969-5c94-498c-9221-625f87d5ca12",
    "bucket": 4283
  },
  {
    "note": "seeded:0678_inbox_read_inplace_flag.sql",
    "salt": "inbox_read_inplace_v1",
    "key": "inbox_read_inplace_v1",
    "unit": "server",
    "unitId": "95f993fa-2a68-4797-b8ae-7beb7d984ada",
    "bucket": 4333
  },
  {
    "note": "seeded:0679_mobile_inbox_inplace_flag.sql",
    "salt": "mobile_inbox_inplace_v0",
    "key": "mobile_inbox_inplace_v0",
    "unit": "user",
    "unitId": "33333333-3333-4333-8333-333333333333",
    "bucket": 2387
  },
  {
    "note": "seeded:0686_desktop_web_preview_view_flag.sql",
    "salt": "desktop_web_preview_view_v0",
    "key": "desktop_web_preview_view_v0",
    "unit": "server",
    "unitId": "00000000-0000-4000-8000-00000000a101",
    "bucket": 8487
  },
  {
    "note": "seeded:0697_agent_call_flag.sql",
    "salt": "agent_call_v0",
    "key": "agent_call_v0",
    "unit": "server",
    "unitId": "bccd5969-5c94-498c-9221-625f87d5ca12",
    "bucket": 5782
  },
  {
    "note": "seeded:0699_desktop_browser_raft_sign_in_flag.sql",
    "salt": "desktop_browser_raft_sign_in_v0",
    "key": "desktop_browser_raft_sign_in_v0",
    "unit": "server",
    "unitId": "95f993fa-2a68-4797-b8ae-7beb7d984ada",
    "bucket": 5988
  },
  {
    "note": "seeded:0700_inbox_message_inplace_flag.sql",
    "salt": "inbox_message_inplace_v1",
    "key": "inbox_message_inplace_v1",
    "unit": "server",
    "unitId": "33333333-3333-4333-8333-333333333333",
    "bucket": 8290
  },
  {
    "note": "seeded:0701_agent_voice_flag.sql",
    "salt": "agent_voice_v1",
    "key": "agent_voice_v1",
    "unit": "server",
    "unitId": "00000000-0000-4000-8000-00000000a101",
    "bucket": 803
  },
  {
    "note": "seeded:0714_inbox_row_position_flag.sql",
    "salt": "inbox_row_position_v1",
    "key": "inbox_row_position_v1",
    "unit": "server",
    "unitId": "bccd5969-5c94-498c-9221-625f87d5ca12",
    "bucket": 8679
  },
  {
    "note": "uuid-salt",
    "salt": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "key": "external_channels_v1",
    "unit": "server",
    "unitId": "bccd5969-5c94-498c-9221-625f87d5ca12",
    "bucket": 9899
  },
  {
    "note": "uuid-salt",
    "salt": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    "key": "oauth_account_login",
    "unit": "user",
    "unitId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "bucket": 7740
  },
  {
    "note": "uuid-salt",
    "salt": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    "key": "server_sso_v1",
    "unit": "server",
    "unitId": "95f993fa-2a68-4797-b8ae-7beb7d984ada",
    "bucket": 6349
  },
  {
    "note": "uuid-salt",
    "salt": "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
    "key": "wake_recycle_oar",
    "unit": "server",
    "unitId": "f7e0a414-8174-4365-8a7f-fd5ae3d1aaa0",
    "bucket": 3352
  },
  {
    "note": "sha256-padding-54B",
    "salt": "s",
    "key": "pad_flag",
    "unit": "server",
    "unitId": "bccd5969-5c94-498c-9221-625f87d5ca12",
    "bucket": 5671
  },
  {
    "note": "sha256-padding-55B",
    "salt": "ss",
    "key": "pad_flag",
    "unit": "server",
    "unitId": "bccd5969-5c94-498c-9221-625f87d5ca12",
    "bucket": 8173
  },
  {
    "note": "sha256-padding-56B",
    "salt": "sss",
    "key": "pad_flag",
    "unit": "server",
    "unitId": "bccd5969-5c94-498c-9221-625f87d5ca12",
    "bucket": 452
  },
  {
    "note": "sha256-padding-57B",
    "salt": "ssss",
    "key": "pad_flag",
    "unit": "server",
    "unitId": "bccd5969-5c94-498c-9221-625f87d5ca12",
    "bucket": 4100
  },
  {
    "note": "sha256-padding-63B",
    "salt": "ssssssssss",
    "key": "pad_flag",
    "unit": "server",
    "unitId": "bccd5969-5c94-498c-9221-625f87d5ca12",
    "bucket": 5477
  },
  {
    "note": "sha256-padding-64B",
    "salt": "sssssssssss",
    "key": "pad_flag",
    "unit": "server",
    "unitId": "bccd5969-5c94-498c-9221-625f87d5ca12",
    "bucket": 9686
  },
  {
    "note": "sha256-padding-65B",
    "salt": "ssssssssssss",
    "key": "pad_flag",
    "unit": "server",
    "unitId": "bccd5969-5c94-498c-9221-625f87d5ca12",
    "bucket": 8596
  },
  {
    "note": "sha256-padding-118B",
    "salt": "sssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssss",
    "key": "pad_flag",
    "unit": "server",
    "unitId": "bccd5969-5c94-498c-9221-625f87d5ca12",
    "bucket": 5857
  },
  {
    "note": "sha256-padding-119B",
    "salt": "ssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssss",
    "key": "pad_flag",
    "unit": "server",
    "unitId": "bccd5969-5c94-498c-9221-625f87d5ca12",
    "bucket": 8982
  },
  {
    "note": "sha256-padding-120B",
    "salt": "sssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssss",
    "key": "pad_flag",
    "unit": "server",
    "unitId": "bccd5969-5c94-498c-9221-625f87d5ca12",
    "bucket": 1580
  },
  {
    "note": "sha256-padding-121B",
    "salt": "ssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssss",
    "key": "pad_flag",
    "unit": "server",
    "unitId": "bccd5969-5c94-498c-9221-625f87d5ca12",
    "bucket": 6852
  },
  {
    "note": "sha256-padding-127B",
    "salt": "ssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssss",
    "key": "pad_flag",
    "unit": "server",
    "unitId": "bccd5969-5c94-498c-9221-625f87d5ca12",
    "bucket": 1134
  },
  {
    "note": "sha256-padding-128B",
    "salt": "sssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssss",
    "key": "pad_flag",
    "unit": "server",
    "unitId": "bccd5969-5c94-498c-9221-625f87d5ca12",
    "bucket": 2253
  },
  {
    "note": "sha256-padding-129B",
    "salt": "ssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssss",
    "key": "pad_flag",
    "unit": "server",
    "unitId": "bccd5969-5c94-498c-9221-625f87d5ca12",
    "bucket": 2231
  },
  {
    "note": "modulo-min-0",
    "salt": "probe-644",
    "key": "rollout_probe_v1",
    "unit": "server",
    "unitId": "bccd5969-5c94-498c-9221-625f87d5ca12",
    "bucket": 0
  },
  {
    "note": "modulo-max-9999",
    "salt": "probe-426",
    "key": "rollout_probe_v1",
    "unit": "server",
    "unitId": "bccd5969-5c94-498c-9221-625f87d5ca12",
    "bucket": 9999
  },
  {
    "note": "uint32-msb-0xff",
    "salt": "probe-305",
    "key": "rollout_probe_v1",
    "unit": "user",
    "unitId": "bccd5969-5c94-498c-9221-625f87d5ca12",
    "bucket": 7521
  },
  {
    "note": "utf8-2byte",
    "salt": "café-ñ",
    "key": "utf8_flag_v0",
    "unit": "user",
    "unitId": "33333333-3333-4333-8333-333333333333",
    "bucket": 6270
  },
  {
    "note": "utf8-3byte-cjk",
    "salt": "灰度分桶盐值",
    "key": "utf8_flag_v0",
    "unit": "user",
    "unitId": "33333333-3333-4333-8333-333333333333",
    "bucket": 5413
  },
  {
    "note": "utf8-4byte-astral",
    "salt": "🌊🧭🚀",
    "key": "utf8_flag_v0",
    "unit": "user",
    "unitId": "33333333-3333-4333-8333-333333333333",
    "bucket": 2295
  },
  {
    "note": "colon-delimiters",
    "salt": "a:b:c",
    "key": "utf8_flag_v0",
    "unit": "user",
    "unitId": "33333333-3333-4333-8333-333333333333",
    "bucket": 5634
  },
  {
    "note": "empty-salt",
    "salt": "",
    "key": "utf8_flag_v0",
    "unit": "user",
    "unitId": "33333333-3333-4333-8333-333333333333",
    "bucket": 5683
  }
];
