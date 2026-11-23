import { generateOpaqueToken } from './lib/crypto.ts';
import type { RahhalaDb } from './db.ts';
export type { RahhalaDb } from './db.ts';
interface Migration { version: number; name: string; sql: string; }
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        username TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('member', 'admin', 'owner')) DEFAULT 'member',
        approval_status TEXT NOT NULL CHECK(approval_status IN ('pending', 'approved')) DEFAULT 'pending',
        history_granted INTEGER NOT NULL DEFAULT 0,
        bio TEXT NOT NULL DEFAULT '',
        avatar_asset_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
      CREATE INDEX IF NOT EXISTS idx_users_approval ON users(approval_status);
      CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        device_label TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);

      CREATE TABLE IF NOT EXISTS auth_attempts (
        key_hash TEXT PRIMARY KEY,
        attempts INTEGER NOT NULL DEFAULT 0,
        window_start INTEGER NOT NULL,
        locked_until INTEGER,
        expires_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_auth_attempts_expires ON auth_attempts(expires_at);

      CREATE TABLE IF NOT EXISTS subjects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        accent_color TEXT NOT NULL DEFAULT '#E3B23C',
        icon_name TEXT NOT NULL DEFAULT 'book',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_subjects_order ON subjects(sort_order, created_at);

      CREATE TABLE IF NOT EXISTS sections (
        id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_sections_subject ON sections(subject_id, sort_order);

      CREATE TABLE IF NOT EXISTS materials (
        id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
        section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('pdf', 'video', 'doc', 'drive', 'telegram', 'link')),
        url TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        creator_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_materials_lookup ON materials(subject_id, section_id, sort_order);

      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        uploader_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        detected_mime TEXT NOT NULL,
        original_safe_name TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('image', 'pdf', 'audio', 'office', 'avatar')),
        binding_type TEXT NOT NULL CHECK(binding_type IN ('pending', 'chat_file', 'chat_audio', 'avatar')) DEFAULT 'pending',
        binding_id TEXT,
        created_at INTEGER NOT NULL,
        finalized_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_assets_uploader ON assets(uploader_id, binding_type);

      CREATE TABLE IF NOT EXISTS asset_chunks (
        asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        data BLOB NOT NULL,
        byte_length INTEGER NOT NULL,
        checksum TEXT NOT NULL,
        PRIMARY KEY (asset_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL CHECK(channel IN ('announcements', 'questions', 'general')),
        sender_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        sender_name_snapshot TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
        audio_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
        file_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
        filename_snapshot TEXT,
        idempotency_key TEXT,
        created_at INTEGER NOT NULL,
        edited_at INTEGER,
        deleted_at INTEGER,
        deleted_by_id TEXT REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel, id);
      CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
      CREATE INDEX IF NOT EXISTS idx_messages_reply ON messages(reply_to_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_idempotency
        ON messages(sender_id, channel, idempotency_key)
        WHERE idempotency_key IS NOT NULL AND sender_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS message_hides (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        hidden_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, message_id)
      );

      CREATE TABLE IF NOT EXISTS reactions (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        emoji TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, message_id)
      );

      CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);

      CREATE TABLE IF NOT EXISTS channel_reads (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        channel TEXT NOT NULL CHECK(channel IN ('announcements', 'questions', 'general')),
        highest_read_message_id INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, channel)
      );

      CREATE TABLE IF NOT EXISTS receipts (
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        delivered_at INTEGER,
        read_at INTEGER,
        PRIMARY KEY (message_id, recipient_id)
      );

      CREATE INDEX IF NOT EXISTS idx_receipts_recipient ON receipts(recipient_id, read_at);

      CREATE TABLE IF NOT EXISTS typing_states (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        channel TEXT NOT NULL CHECK(channel IN ('announcements', 'questions', 'general')),
        last_activity_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, channel)
      );

      CREATE TABLE IF NOT EXISTS history_requests (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        decided_by_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        decided_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_history_requests_status ON history_requests(status);

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS admin_audits (
        id TEXT PRIMARY KEY,
        actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        target_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'study_reminders',
    sql: `
      CREATE TABLE IF NOT EXISTS study_reminders (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
        subject_name_snapshot TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        remind_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'triggered', 'completed')) DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_study_reminders_user
        ON study_reminders(user_id, status, remind_at);
    `,
  },
  {
    version: 3,
    name: 'study_reminders_duration',
    sql: `
      ALTER TABLE study_reminders ADD COLUMN duration_minutes INTEGER NOT NULL DEFAULT 25;
    `,
  },
  {
    version: 4,
    name: 'user_subject_preferences',
    sql: `
      CREATE TABLE IF NOT EXISTS user_subject_preferences (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        subject_id TEXT NOT NULL,
        accent_color TEXT NOT NULL,
        tone_id TEXT NOT NULL CHECK(tone_id IN ('chime', 'warm-bell', 'crystal', 'pulse', 'gentle-oud', 'silent')) DEFAULT 'chime',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, subject_id)
      );

      CREATE INDEX IF NOT EXISTS idx_user_subject_prefs_user
        ON user_subject_preferences(user_id);
    `,
  },
  {
    version: 5,
    name: 'study_challenges',
    sql: `
      CREATE TABLE IF NOT EXISTS study_challenges (
        id TEXT PRIMARY KEY,
        creator_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        creator_name_snapshot TEXT NOT NULL,
        subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
        subject_name_snapshot TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        target_minutes INTEGER NOT NULL,
        ends_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_study_challenges_ends
        ON study_challenges(ends_at DESC, created_at DESC);

      CREATE TABLE IF NOT EXISTS study_challenge_participants (
        challenge_id TEXT NOT NULL REFERENCES study_challenges(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        logged_minutes INTEGER NOT NULL DEFAULT 0,
        joined_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (challenge_id, user_id)
      );

      CREATE INDEX IF NOT EXISTS idx_study_challenge_parts_user
        ON study_challenge_participants(user_id);
    `,
  },
  {
    version: 6,
    name: 'challenge_logs_and_majalis_rooms',
    sql: `
      CREATE TABLE IF NOT EXISTS study_challenge_logs (
        id TEXT PRIMARY KEY,
        challenge_id TEXT NOT NULL REFERENCES study_challenges(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
        subject_name_snapshot TEXT NOT NULL,
        challenge_title_snapshot TEXT NOT NULL,
        minutes INTEGER NOT NULL,
        logged_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_challenge_logs_user_time
        ON study_challenge_logs(user_id, logged_at DESC);

      CREATE TABLE IF NOT EXISTS majalis_rooms (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
        subject_name_snapshot TEXT NOT NULL,
        creator_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        creator_name_snapshot TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS majalis_messages (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES majalis_rooms(id) ON DELETE CASCADE,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        sender_name_snapshot TEXT NOT NULL,
        avatar_asset_id TEXT,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_majalis_messages_room_time
        ON majalis_messages(room_id, created_at ASC);
    `,
  },
  {
    version: 7,
    name: 'whatsapp_chat_and_group_settings',
    sql: `
      CREATE TABLE IF NOT EXISTS user_chat_settings (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        wallpaper TEXT NOT NULL CHECK(wallpaper IN ('default', 'islamic-geo', 'midnight', 'warm-parchment', 'emerald')) DEFAULT 'default',
        font_size TEXT NOT NULL CHECK(font_size IN ('small', 'medium', 'large')) DEFAULT 'medium',
        enter_to_send INTEGER NOT NULL DEFAULT 1,
        read_receipts_enabled INTEGER NOT NULL DEFAULT 1,
        chat_sounds_enabled INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS starred_messages (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        starred_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, message_id)
      );

      CREATE INDEX IF NOT EXISTS idx_starred_messages_user
        ON starred_messages(user_id, starred_at DESC);

      CREATE TABLE IF NOT EXISTS muted_chat_members (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        muted_by_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        muted_until INTEGER,
        created_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 8,
    name: 'majalis_google_meet_settings',
    sql: `
      ALTER TABLE majalis_rooms ADD COLUMN access_type TEXT NOT NULL CHECK(access_type IN ('open', 'knock')) DEFAULT 'open';
      ALTER TABLE majalis_rooms ADD COLUMN room_locked INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE majalis_rooms ADD COLUMN allow_mic INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE majalis_rooms ADD COLUMN allow_cam INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE majalis_rooms ADD COLUMN allow_screen_share INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE majalis_rooms ADD COLUMN allow_chat INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE majalis_rooms ADD COLUMN mute_on_entry INTEGER NOT NULL DEFAULT 0;
    `,
  },  {version:9,name:'isolated_communities_and_groups',sql:`
    CREATE TABLE chat_communities(id TEXT PRIMARY KEY,name TEXT NOT NULL,creator_id TEXT REFERENCES users(id) ON DELETE SET NULL,created_at INTEGER NOT NULL);
    CREATE TABLE chat_groups(id TEXT PRIMARY KEY,community_id TEXT NOT NULL REFERENCES chat_communities(id),name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',creator_id TEXT REFERENCES users(id) ON DELETE SET NULL,posting_policy TEXT NOT NULL DEFAULT 'members' CHECK(posting_policy IN ('members','admins')),created_at INTEGER NOT NULL,archived_at INTEGER);
    CREATE TABLE chat_group_members(group_id TEXT NOT NULL REFERENCES chat_groups(id),user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin','member')),status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),joined_at INTEGER,history_from INTEGER NOT NULL DEFAULT 0,muted INTEGER NOT NULL DEFAULT 0,archived INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(group_id,user_id));
    CREATE TABLE group_messages(id INTEGER PRIMARY KEY AUTOINCREMENT,group_id TEXT NOT NULL REFERENCES chat_groups(id),sender_id TEXT REFERENCES users(id) ON DELETE SET NULL,sender_name TEXT NOT NULL,body TEXT NOT NULL DEFAULT '',asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,reply_to_id INTEGER REFERENCES group_messages(id),forwarded INTEGER NOT NULL DEFAULT 0,request_key TEXT,created_at INTEGER NOT NULL,edited_at INTEGER,deleted_at INTEGER,UNIQUE(group_id,sender_id,request_key));
    CREATE INDEX idx_group_messages_group ON group_messages(group_id,id);
    CREATE TABLE group_message_assets(asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,message_id INTEGER NOT NULL REFERENCES group_messages(id) ON DELETE CASCADE);
    CREATE TABLE group_message_hides(message_id INTEGER NOT NULL REFERENCES group_messages(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,PRIMARY KEY(message_id,user_id));
    CREATE TABLE group_message_reads(message_id INTEGER NOT NULL REFERENCES group_messages(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,delivered_at INTEGER,read_at INTEGER,PRIMARY KEY(message_id,user_id));
    CREATE TABLE group_message_stars(message_id INTEGER NOT NULL REFERENCES group_messages(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,PRIMARY KEY(message_id,user_id));
    CREATE TABLE group_message_reactions(message_id INTEGER NOT NULL REFERENCES group_messages(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,emoji TEXT NOT NULL,PRIMARY KEY(message_id,user_id));
  `},
  {version:10,name:'group_pinned_messages',sql:`CREATE TABLE group_pins(group_id TEXT PRIMARY KEY REFERENCES chat_groups(id),message_id INTEGER NOT NULL REFERENCES group_messages(id) ON DELETE CASCADE);`},
  {version:11,name:'group_mention_notifications',sql:`CREATE TABLE group_mentions(message_id INTEGER NOT NULL REFERENCES group_messages(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,seen_at INTEGER,PRIMARY KEY(message_id,user_id));CREATE INDEX idx_group_mentions_user ON group_mentions(user_id,seen_at);`},
  {version:12,name:'recovery_and_signup_outbox',sql:`CREATE TABLE account_recovery(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,code_hash TEXT NOT NULL,created_at INTEGER NOT NULL);CREATE TABLE signup_outbox(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,payload TEXT NOT NULL,created_at INTEGER NOT NULL,synced_at INTEGER,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL DEFAULT 0);`},
  {
    version: 13,
    name: 'whatsapp_conversations_and_encryption',
    sql: `
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('dm', 'group')),
        title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        creator_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        wrapped_key TEXT NOT NULL,
        key_fingerprint TEXT NOT NULL,
        only_admins_send INTEGER NOT NULL DEFAULT 0,
        disappearing_hours INTEGER NOT NULL DEFAULT 0,
        pinned_message_id INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_conversations_updated
        ON conversations(updated_at DESC);

      CREATE TABLE IF NOT EXISTS conversation_members (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('admin', 'member')) DEFAULT 'member',
        highest_read_message_id INTEGER NOT NULL DEFAULT 0,
        muted_notifications INTEGER NOT NULL DEFAULT 0,
        cleared_before_at INTEGER NOT NULL DEFAULT 0,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, user_id)
      );

      CREATE INDEX IF NOT EXISTS idx_conv_members_user
        ON conversation_members(user_id, conversation_id);

      CREATE TABLE IF NOT EXISTS conversation_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        sender_name_snapshot TEXT NOT NULL,
        cipher_body TEXT NOT NULL DEFAULT '',
        reply_to_id INTEGER REFERENCES conversation_messages(id) ON DELETE SET NULL,
        audio_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
        file_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
        filename_snapshot TEXT,
        idempotency_key TEXT,
        created_at INTEGER NOT NULL,
        edited_at INTEGER,
        deleted_at INTEGER,
        deleted_by_id TEXT REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_conv_messages_conv_id
        ON conversation_messages(conversation_id, id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_messages_idempotency
        ON conversation_messages(sender_id, conversation_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL AND sender_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS conversation_message_hides (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message_id INTEGER NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
        hidden_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, message_id)
      );

      CREATE TABLE IF NOT EXISTS conversation_reactions (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message_id INTEGER NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
        emoji TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, message_id)
      );

      CREATE TABLE IF NOT EXISTS conversation_receipts (
        message_id INTEGER NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
        recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        delivered_at INTEGER,
        read_at INTEGER,
        PRIMARY KEY (message_id, recipient_id)
      );

      CREATE TABLE IF NOT EXISTS conversation_starred (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message_id INTEGER NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
        starred_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, message_id)
      );
    `,
  },

];

export function migrateDatabase(db: RahhalaDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set<number>(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map(
      (r) => r.version
    )
  );

  for (const m of MIGRATIONS) {
    if (!applied.has(m.version)) {
      const tx = db.transaction(() => {
        db.exec(m.sql);
        db.prepare(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
        ).run(m.version, m.name, Date.now());
      });
      tx();
    }
  }

}

export function getSetting(db: RahhalaDb, key: string, fallback = ''): string {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : fallback;
}

export function setSetting(db: RahhalaDb, key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, Date.now());
}

export function getOrCreateSigningSecret(db: RahhalaDb): string {
  const existing = getSetting(db, '_signing_secret', '');
  if (existing) return existing;
  const fresh = generateOpaqueToken(48);
  setSetting(db, '_signing_secret', fresh);
  return fresh;
}
