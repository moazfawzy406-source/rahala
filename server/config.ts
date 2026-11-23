import path from 'node:path';

export interface RahhalaConfig {
  openRegistration?: boolean;
  turnstileSiteKey?: string;
  turnstileSecret?: string;
  signupWebhookUrl?: string;
  signupWebhookSecret?: string;
  port: number;
  dbPath: string;
  institutionSubtitle: string;
  meetingProviderUrl: string;
  isProduction: boolean;
  previewDemoEnabled: boolean;
  sessionIdleMs: number;
  maxUploadBytes: number;
  maxVoiceBytes: number;
  maxAvatarBytes: number;
  maxStoredAssetBytes?: number;
  maxUserStoredAssetBytes?: number;
}

export function loadConfig(overrides?: Partial<RahhalaConfig>): RahhalaConfig {
  const isProduction = process.env.NODE_ENV === 'production';
  const dbPath =
    overrides?.dbPath ??
    process.env.RAHHALA_DB_PATH ??
    path.resolve(process.cwd(), 'data', 'rahhala.db');

  const meetingProviderUrl = (
    overrides?.meetingProviderUrl ??
    process.env.RAHHALA_MEETING_PROVIDER_URL ??
    ''
  ).trim();

  const previewDemoEnabled =
    overrides?.previewDemoEnabled ??
    (!isProduction && String(process.env.RAHHALA_PREVIEW_DEMO) === 'true');

  return {
    openRegistration:overrides?.openRegistration??false,
    turnstileSiteKey:overrides?.turnstileSiteKey,
    turnstileSecret:overrides?.turnstileSecret,
    signupWebhookUrl:overrides?.signupWebhookUrl,
    signupWebhookSecret:overrides?.signupWebhookSecret,
    port: overrides?.port ?? Number(process.env.PORT || 3000),
    dbPath,
    institutionSubtitle:
      overrides?.institutionSubtitle ??
      (process.env.RAHHALA_INSTITUTION_SUBTITLE || 'كلية الدعوة الإسلامية - الأزهر الشريف'),
    meetingProviderUrl,
    isProduction,
    previewDemoEnabled,
    sessionIdleMs: overrides?.sessionIdleMs ?? 90 * 24 * 60 * 60 * 1000, // 90 days, sliding on active use
    maxUploadBytes: overrides?.maxUploadBytes ?? 25_000_000,
    maxVoiceBytes: overrides?.maxVoiceBytes ?? 12_000_000,
    maxAvatarBytes: overrides?.maxAvatarBytes ?? 4_000_000,
    maxStoredAssetBytes: overrides?.maxStoredAssetBytes,
    maxUserStoredAssetBytes: overrides?.maxUserStoredAssetBytes,
  };
}
