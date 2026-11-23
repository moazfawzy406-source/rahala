import path from 'node:path';

export interface RahhalaConfig {
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
    (!isProduction && process.env.RAHHALA_PREVIEW_DEMO !== 'false');

  return {
    port: overrides?.port ?? Number(process.env.PORT || 3000),
    dbPath,
    institutionSubtitle:
      overrides?.institutionSubtitle ??
      (process.env.RAHHALA_INSTITUTION_SUBTITLE || 'كلية الدعوة الإسلامية - الأزهر الشريف'),
    meetingProviderUrl,
    isProduction,
    previewDemoEnabled,
    sessionIdleMs: overrides?.sessionIdleMs ?? 2 * 60 * 60 * 1000, // 2 hours
    maxUploadBytes: overrides?.maxUploadBytes ?? 15_000_000,
    maxVoiceBytes: overrides?.maxVoiceBytes ?? 12_000_000,
    maxAvatarBytes: overrides?.maxAvatarBytes ?? 4_000_000,
  };
}
