export interface PublicTranslationSettingsContext {
  serverId: string;
  serverSlug: string;
  translationEnabled: boolean;
  translationAvailable: boolean;
  browserLocalPreferences: boolean;
}
