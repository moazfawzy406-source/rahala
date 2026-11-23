import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RahhalaConfig } from '../config.ts';
import type { RahhalaDb } from '../db.ts';
import { type AuthenticatedRequest, createAuthMiddleware } from '../middleware/auth.ts';
import type { RealtimeHub } from '../ws.ts';
import type {
  ChallengeStudyLogRecord,
  StudyChallengeParticipant,
  StudyChallengeRecord,
  UserRole,
} from '../../shared/types.ts';

interface ChallengeRow {
  id: string;
  creator_id: string | null;
  creator_name_snapshot: string;
  subject_id: string | null;
  subject_name_snapshot: string;
  subject_accent_color: string | null;
  title: string;
  description: string;
  target_minutes: number;
  ends_at: number;
  created_at: number;
  updated_at: number;
}

interface ParticipantRow {
  challenge_id: string;
  user_id: string;
  display_name: string;
  username: string;
  avatar_asset_id: string | null;
  logged_minutes: number;
  reminder_minutes: number;
  joined_at: number;
  updated_at: number;
}

function loadChallengeList(
  db: RahhalaDb,
  viewerId: string,
  viewerRole: UserRole,
  challengeId?: string
): StudyChallengeRecord[] {
  const challengeSql = `
    SELECT c.id, c.creator_id, c.creator_name_snapshot, c.subject_id,
           c.subject_name_snapshot, s.accent_color AS subject_accent_color,
           c.title, c.description, c.target_minutes, c.ends_at, c.created_at, c.updated_at
    FROM study_challenges c
    LEFT JOIN subjects s ON s.id = c.subject_id
    ${challengeId ? 'WHERE c.id = ?' : ''}
    ORDER BY
      CASE WHEN c.ends_at >= ? THEN 0 ELSE 1 END ASC,
      c.created_at DESC
    LIMIT 40
  `;

  const now = Date.now();
  const challenges = (
    challengeId
      ? db.prepare(challengeSql).all(challengeId, now)
      : db.prepare(challengeSql).all(now)
  ) as ChallengeRow[];

  if (challenges.length === 0) return [];

  const participantSql = `
    SELECT
      p.challenge_id,
      p.user_id,
      u.display_name,
      u.username,
      u.avatar_asset_id,
      p.logged_minutes,
      p.joined_at,
      p.updated_at,
      COALESCE((
        SELECT SUM(sr.duration_minutes)
        FROM study_reminders sr
        WHERE sr.user_id = p.user_id
          AND sr.status = 'completed'
          AND sr.updated_at >= p.joined_at
          AND sr.updated_at <= c.ends_at
          AND (c.subject_id IS NULL OR sr.subject_id = c.subject_id)
      ), 0) AS reminder_minutes
    FROM study_challenge_participants p
    JOIN users u ON u.id = p.user_id
    JOIN study_challenges c ON c.id = p.challenge_id
    ${challengeId ? 'WHERE p.challenge_id = ?' : ''}
    ORDER BY (p.logged_minutes + reminder_minutes) DESC, p.joined_at ASC
  `;

  const participantRows = (
    challengeId ? db.prepare(participantSql).all(challengeId) : db.prepare(participantSql).all()
  ) as ParticipantRow[];

  const byChallenge = new Map<string, StudyChallengeParticipant[]>();
  const targetByChallenge = new Map<string, number>();
  for (const c of challenges) {
    targetByChallenge.set(c.id, Math.max(1, c.target_minutes));
  }

  for (const p of participantRows) {
    const targetMins = targetByChallenge.get(p.challenge_id) ?? 60;
    const totalMinutes = p.logged_minutes + p.reminder_minutes;
    const list = byChallenge.get(p.challenge_id) ?? [];
    list.push({
      userId: p.user_id,
      displayName: p.display_name,
      username: p.username,
      avatarAssetId: p.avatar_asset_id,
      loggedMinutes: p.logged_minutes,
      reminderMinutes: p.reminder_minutes,
      totalMinutes,
      progressPercent: Math.min(100, Math.round((totalMinutes / targetMins) * 100)),
      joinedAt: p.joined_at,
      updatedAt: p.updated_at,
      isCurrentUser: p.user_id === viewerId,
    });
    byChallenge.set(p.challenge_id, list);
  }

  const canModerate = viewerRole === 'admin' || viewerRole === 'owner';

  return challenges.map((c) => {
    const participants = byChallenge.get(c.id) ?? [];
    const me = participants.find((p) => p.isCurrentUser);
    return {
      id: c.id,
      creatorId: c.creator_id,
      creatorName: c.creator_name_snapshot,
      subjectId: c.subject_id,
      subjectName: c.subject_name_snapshot,
      subjectColor: c.subject_accent_color || '#E3B23C',
      title: c.title,
      description: c.description,
      targetHours: Number((c.target_minutes / 60).toFixed(1)),
      targetMinutes: c.target_minutes,
      endsAt: c.ends_at,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      participantCount: participants.length,
      joinedByMe: Boolean(me),
      myMinutes: me ? me.totalMinutes : 0,
      myProgressPercent: me ? me.progressPercent : 0,
      canDelete: canModerate || c.creator_id === viewerId,
      participants,
    };
  });
}

export function createChallengesRouter(
  db: RahhalaDb,
  config: RahhalaConfig,
  hub: RealtimeHub
): Router {
  const router = Router();
  const { requireAuth } = createAuthMiddleware(db, config);

  router.get('/challenges', requireAuth, (req: AuthenticatedRequest, res) => {
    const challenges = loadChallengeList(db, req.authUser!.id, req.authUser!.role);
    res.json({ challenges });
  });

  router.get('/challenges/activity', requireAuth, (req: AuthenticatedRequest, res) => {
    const rawDays = Number(req.query.days ?? 35);
    const days = Number.isFinite(rawDays) ? Math.min(90, Math.max(1, Math.round(rawDays))) : 35;
    const cutoff = Date.now() - days * 86_400_000;

    const rows = db
      .prepare(
        `SELECT id, challenge_id, challenge_title_snapshot, subject_id, subject_name_snapshot, minutes, logged_at
         FROM study_challenge_logs
         WHERE user_id = ? AND logged_at >= ?
         ORDER BY logged_at DESC
         LIMIT 500`
      )
      .all(req.authUser!.id, cutoff) as Array<{
      id: string;
      challenge_id: string;
      challenge_title_snapshot: string;
      subject_id: string | null;
      subject_name_snapshot: string;
      minutes: number;
      logged_at: number;
    }>;

    const logs: ChallengeStudyLogRecord[] = rows.map((r) => ({
      id: r.id,
      challengeId: r.challenge_id,
      challengeTitle: r.challenge_title_snapshot,
      subjectId: r.subject_id,
      subjectName: r.subject_name_snapshot,
      minutes: r.minutes,
      loggedAt: r.logged_at,
    }));

    res.json({ logs });
  });

  const createSchema = z.object({
    title: z
      .string()
      .trim()
      .min(3, 'اكتب عنوانًا واضحًا للتحدي (٣ أحرف على الأقل)')
      .max(80, 'عنوان التحدي طويل جدًا (بحد أقصى ٨٠ حرفًا)'),
    subjectId: z.string().trim().min(1).max(80).nullable().optional(),
    description: z.string().trim().max(180, 'الوصف طويل جدًا (بحد أقصى ١٨٠ حرفًا)').optional(),
    targetHours: z.number().finite().min(0.5, 'الحد الأدنى نصف ساعة').max(200, 'الحد الأقصى ٢٠٠ ساعة'),
    durationDays: z.number().int().min(1, 'المدة يوم واحد على الأقل').max(60, 'الحد الأقصى ٦٠ يومًا'),
  });

  router.post('/challenges', requireAuth, (req: AuthenticatedRequest, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'بيانات التحدي غير صالحة' });
      return;
    }

    const totalCount = (db.prepare('SELECT COUNT(*) AS cnt FROM study_challenges').get() as { cnt: number }).cnt;
    if (totalCount >= 80) {
      res.status(400).json({ error: 'تم الوصول للحد الأقصى للتحديات المشتركة حاليًا' });
      return;
    }

    let resolvedSubjectId: string | null = null;
    let resolvedSubjectName = 'مذاكرة عامة';

    if (parsed.data.subjectId) {
      const subj = db
        .prepare('SELECT id, name FROM subjects WHERE id = ?')
        .get(parsed.data.subjectId) as { id: string; name: string } | undefined;
      if (!subj) {
        res.status(404).json({ error: 'المادة المختارة غير موجودة' });
        return;
      }
      resolvedSubjectId = subj.id;
      resolvedSubjectName = subj.name;
    }

    const now = Date.now();
    const id = `chg_${randomUUID()}`;
    const targetMinutes = Math.max(30, Math.round(parsed.data.targetHours * 60));
    const endsAt = now + parsed.data.durationDays * 86_400_000;
    const description = (parsed.data.description || '').trim();

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO study_challenges (
           id, creator_id, creator_name_snapshot, subject_id, subject_name_snapshot,
           title, description, target_minutes, ends_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        req.authUser!.id,
        req.authUser!.displayName,
        resolvedSubjectId,
        resolvedSubjectName,
        parsed.data.title,
        description,
        targetMinutes,
        endsAt,
        now,
        now
      );

      db.prepare(
        `INSERT INTO study_challenge_participants (challenge_id, user_id, logged_minutes, joined_at, updated_at)
         VALUES (?, ?, 0, ?, ?)`
      ).run(id, req.authUser!.id, now, now);
    });
    tx();

    hub.broadcastChallengesUpdated();
    const [challenge] = loadChallengeList(db, req.authUser!.id, req.authUser!.role, id);
    res.status(201).json({ challenge });
  });

  router.post('/challenges/:id/join', requireAuth, (req: AuthenticatedRequest, res) => {
    const challengeId = String(req.params.id || '').trim();
    const existing = db
      .prepare('SELECT id, ends_at FROM study_challenges WHERE id = ?')
      .get(challengeId) as { id: string; ends_at: number } | undefined;
    if (!existing) {
      res.status(404).json({ error: 'التحدي غير موجود' });
      return;
    }
    if (existing.ends_at < Date.now()) {
      res.status(400).json({ error: 'انتهى وقت هذا التحدي بالفعل' });
      return;
    }

    const now = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO study_challenge_participants (challenge_id, user_id, logged_minutes, joined_at, updated_at)
       VALUES (?, ?, 0, ?, ?)`
    ).run(challengeId, req.authUser!.id, now, now);

    hub.broadcastChallengesUpdated();
    const [challenge] = loadChallengeList(db, req.authUser!.id, req.authUser!.role, challengeId);
    res.json({ challenge });
  });

  router.post('/challenges/:id/leave', requireAuth, (req: AuthenticatedRequest, res) => {
    const challengeId = String(req.params.id || '').trim();
    const existing = db
      .prepare('SELECT id FROM study_challenges WHERE id = ?')
      .get(challengeId) as { id: string } | undefined;
    if (!existing) {
      res.status(404).json({ error: 'التحدي غير موجود' });
      return;
    }

    db.prepare(
      'DELETE FROM study_challenge_participants WHERE challenge_id = ? AND user_id = ?'
    ).run(challengeId, req.authUser!.id);

    hub.broadcastChallengesUpdated();
    const [challenge] = loadChallengeList(db, req.authUser!.id, req.authUser!.role, challengeId);
    res.json({ challenge });
  });

  const progressSchema = z.object({
    addMinutes: z.number().int().min(5, 'أقل مدة يمكن تسجيلها ٥ دقائق').max(480, 'الحد الأقصى للجلسة الواحدة ٨ ساعات'),
  });

  router.post('/challenges/:id/progress', requireAuth, (req: AuthenticatedRequest, res) => {
    const challengeId = String(req.params.id || '').trim();
    const existing = db
      .prepare('SELECT id, title, subject_id, subject_name_snapshot, ends_at FROM study_challenges WHERE id = ?')
      .get(challengeId) as
      | {
          id: string;
          title: string;
          subject_id: string | null;
          subject_name_snapshot: string;
          ends_at: number;
        }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'التحدي غير موجود' });
      return;
    }
    if (existing.ends_at < Date.now()) {
      res.status(400).json({ error: 'انتهت مدة هذا التحدي ولا يمكن تسجيل دقائق إضافية' });
      return;
    }

    const parsed = progressSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'قيمة الدقائق غير صالحة' });
      return;
    }

    const enrolled = db
      .prepare(
        'SELECT logged_minutes FROM study_challenge_participants WHERE challenge_id = ? AND user_id = ?'
      )
      .get(challengeId, req.authUser!.id) as { logged_minutes: number } | undefined;

    if (!enrolled) {
      res.status(400).json({ error: 'انضم للتحدي أولًا لتسجيل ساعات مذاكرتك' });
      return;
    }

    const now = Date.now();
    const nextMinutes = Math.min(60_000, enrolled.logged_minutes + parsed.data.addMinutes);
    const logId = `chglog_${randomUUID()}`;

    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE study_challenge_participants
         SET logged_minutes = ?, updated_at = ?
         WHERE challenge_id = ? AND user_id = ?`
      ).run(nextMinutes, now, challengeId, req.authUser!.id);

      db.prepare(
        `INSERT INTO study_challenge_logs (
           id, challenge_id, user_id, subject_id, subject_name_snapshot, challenge_title_snapshot, minutes, logged_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        logId,
        challengeId,
        req.authUser!.id,
        existing.subject_id,
        existing.subject_name_snapshot,
        existing.title,
        parsed.data.addMinutes,
        now
      );

      db.prepare('UPDATE study_challenges SET updated_at = ? WHERE id = ?').run(now, challengeId);
    });
    tx();

    hub.broadcastChallengesUpdated();
    const [challenge] = loadChallengeList(db, req.authUser!.id, req.authUser!.role, challengeId);
    res.json({ challenge });
  });

  router.delete('/challenges/:id', requireAuth, (req: AuthenticatedRequest, res) => {
    const challengeId = String(req.params.id || '').trim();
    const existing = db
      .prepare('SELECT id, creator_id FROM study_challenges WHERE id = ?')
      .get(challengeId) as { id: string; creator_id: string | null } | undefined;

    if (!existing) {
      res.status(404).json({ error: 'التحدي غير موجود' });
      return;
    }

    const isModerator = req.authUser!.role === 'admin' || req.authUser!.role === 'owner';
    if (!isModerator && existing.creator_id !== req.authUser!.id) {
      res.status(403).json({ error: 'يمكن لمنشئ التحدي أو المشرف فقط حذفه' });
      return;
    }

    db.prepare('DELETE FROM study_challenges WHERE id = ?').run(challengeId);
    hub.broadcastChallengesUpdated();
    res.json({ ok: true });
  });

  return router;
}
