import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RahhalaConfig } from '../config.ts';
import type { RahhalaDb } from '../db.ts';
import { type AuthenticatedRequest, createAuthMiddleware } from '../middleware/auth.ts';
import type { RealtimeHub } from '../ws.ts';
import {
  SUBJECT_GENERAL_KEY,
  type AlertToneId,
  type ReminderStatus,
  type StudyReminderRecord,
  type SubjectAlertPreference,
} from '../../shared/types.ts';

interface ReminderRow {
  id: string;
  subject_id: string | null;
  subject_name_snapshot: string;
  note: string;
  remind_at: number;
  duration_minutes: number;
  status: ReminderStatus;
  created_at: number;
  updated_at: number;
}

interface SubjectPreferenceRow {
  subject_id: string;
  accent_color: string;
  tone_id: AlertToneId;
  updated_at: number;
}

function mapReminderRow(row: ReminderRow): StudyReminderRecord {
  return {
    id: row.id,
    subjectId: row.subject_id,
    subjectName: row.subject_name_snapshot,
    note: row.note,
    remindAt: row.remind_at,
    durationMinutes: row.duration_minutes,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPreferenceRow(row: SubjectPreferenceRow): SubjectAlertPreference {
  return {
    subjectId: row.subject_id,
    accentColor: row.accent_color,
    toneId: row.tone_id,
    updatedAt: row.updated_at,
  };
}

export function createRemindersRouter(
  db: RahhalaDb,
  config: RahhalaConfig,
  hub?: RealtimeHub
): Router {
  const router = Router();
  const { requireAuth } = createAuthMiddleware(db, config);

  router.get('/reminders/preferences', requireAuth, (req: AuthenticatedRequest, res) => {
    const rows = db
      .prepare(
        `SELECT subject_id, accent_color, tone_id, updated_at
         FROM user_subject_preferences
         WHERE user_id = ?
         ORDER BY updated_at DESC`
      )
      .all(req.authUser!.id) as SubjectPreferenceRow[];

    res.json({ preferences: rows.map(mapPreferenceRow) });
  });

  const preferenceSchema = z.object({
    accentColor: z
      .string()
      .trim()
      .regex(/^#[0-9A-Fa-f]{6}$/, 'صيغة اللون غير صالحة'),
    toneId: z.enum(['chime', 'warm-bell', 'crystal', 'pulse', 'gentle-oud', 'silent']),
  });

  router.put('/reminders/preferences/:subjectId', requireAuth, (req: AuthenticatedRequest, res) => {
    const subjectId = String(req.params.subjectId || '').trim();
    if (!subjectId || subjectId.length > 80) {
      res.status(400).json({ error: 'معرّف المادة غير صالح' });
      return;
    }

    if (subjectId !== SUBJECT_GENERAL_KEY) {
      const exists = db.prepare('SELECT 1 FROM subjects WHERE id = ?').get(subjectId);
      if (!exists) {
        res.status(404).json({ error: 'المادة المختارة غير موجودة' });
        return;
      }
    }

    const parsed = preferenceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'تفضيلات التنبيه غير صالحة' });
      return;
    }

    const userId = req.authUser!.id;
    const now = Date.now();
    const accentColor = parsed.data.accentColor.toUpperCase();
    const toneId = parsed.data.toneId;

    db.prepare(
      `INSERT INTO user_subject_preferences (user_id, subject_id, accent_color, tone_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, subject_id) DO UPDATE SET
         accent_color = excluded.accent_color,
         tone_id = excluded.tone_id,
         updated_at = excluded.updated_at`
    ).run(userId, subjectId, accentColor, toneId, now);

    const saved = db
      .prepare(
        `SELECT subject_id, accent_color, tone_id, updated_at
         FROM user_subject_preferences
         WHERE user_id = ? AND subject_id = ?`
      )
      .get(userId, subjectId) as SubjectPreferenceRow;

    res.json({ preference: mapPreferenceRow(saved) });
  });

  router.delete('/reminders/preferences/:subjectId', requireAuth, (req: AuthenticatedRequest, res) => {
    const subjectId = String(req.params.subjectId || '').trim();
    db.prepare('DELETE FROM user_subject_preferences WHERE user_id = ? AND subject_id = ?').run(
      req.authUser!.id,
      subjectId
    );
    res.json({ ok: true });
  });

  router.get('/reminders', requireAuth, (req: AuthenticatedRequest, res) => {
    const rows = db
      .prepare(
        `SELECT id, subject_id, subject_name_snapshot, note, remind_at, duration_minutes, status, created_at, updated_at
         FROM study_reminders
         WHERE user_id = ?
         ORDER BY
           CASE status
             WHEN 'triggered' THEN 0
             WHEN 'active' THEN 1
             ELSE 2
           END ASC,
           remind_at ASC`
      )
      .all(req.authUser!.id) as ReminderRow[];

    res.json({ reminders: rows.map(mapReminderRow) });
  });

  const createSchema = z.object({
    subjectId: z.string().trim().min(1).max(80).nullable().optional(),
    subjectName: z.string().trim().max(80).optional(),
    note: z.string().trim().max(140, 'الملاحظة طويلة جدًا (بحد أقصى ١٤٠ حرفًا)').optional(),
    remindAt: z.number().finite().optional(),
    delayMinutes: z.number().finite().min(0.1).max(10_080).optional(),
  });

  router.post('/reminders', requireAuth, (req: AuthenticatedRequest, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'بيانات المنبه غير صالحة' });
      return;
    }

    const userId = req.authUser!.id;
    const countRow = db
      .prepare('SELECT COUNT(*) AS cnt FROM study_reminders WHERE user_id = ?')
      .get(userId) as { cnt: number };
    if (countRow.cnt >= 50) {
      res.status(400).json({ error: 'وصلت للحد الأقصى للتذكيرات (٥٠). احذف بعض التذكيرات القديمة أولًا.' });
      return;
    }

    let resolvedSubjectId: string | null = null;
    let resolvedSubjectName = (parsed.data.subjectName || '').trim();

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

    if (!resolvedSubjectName) {
      resolvedSubjectName = 'مذاكرة عامة';
    }

    const now = Date.now();
    let remindAt: number;
    let durationMinutes: number;
    if (typeof parsed.data.delayMinutes === 'number') {
      remindAt = now + Math.round(parsed.data.delayMinutes * 60_000);
      durationMinutes = Math.max(1, Math.min(480, Math.round(parsed.data.delayMinutes)));
    } else if (typeof parsed.data.remindAt === 'number') {
      remindAt = Math.round(parsed.data.remindAt);
      durationMinutes = Math.max(1, Math.min(480, Math.round((remindAt - now) / 60_000)));
    } else {
      res.status(400).json({ error: 'حدد وقت المنبه أو عدد الدقائق' });
      return;
    }

    if (remindAt < now - 60_000) {
      res.status(400).json({ error: 'اختر وقتًا في المستقبل لضبط المنبه' });
      return;
    }

    const id = `rem_${randomUUID()}`;
    const note = (parsed.data.note || '').trim();

    db.prepare(
      `INSERT INTO study_reminders (id, user_id, subject_id, subject_name_snapshot, note, remind_at, duration_minutes, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
    ).run(id, userId, resolvedSubjectId, resolvedSubjectName, note, remindAt, durationMinutes, now, now);

    const created = db
      .prepare(
        `SELECT id, subject_id, subject_name_snapshot, note, remind_at, duration_minutes, status, created_at, updated_at
         FROM study_reminders WHERE id = ?`
      )
      .get(id) as ReminderRow;

    res.status(201).json({ reminder: mapReminderRow(created) });
  });

  const patchSchema = z.object({
    status: z.enum(['active', 'triggered', 'completed']).optional(),
    remindAt: z.number().finite().optional(),
    snoozeMinutes: z.number().finite().min(1).max(1440).optional(),
    note: z.string().trim().max(140).optional(),
  });

  router.patch('/reminders/:id', requireAuth, (req: AuthenticatedRequest, res) => {
    const id = String(req.params.id);
    const userId = req.authUser!.id;
    const existing = db
      .prepare(
        `SELECT id, subject_id, subject_name_snapshot, note, remind_at, duration_minutes, status, created_at, updated_at
         FROM study_reminders WHERE id = ? AND user_id = ?`
      )
      .get(id, userId) as ReminderRow | undefined;

    if (!existing) {
      res.status(404).json({ error: 'التذكير غير موجود' });
      return;
    }

    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'تحديث غير صالح للتذكير' });
      return;
    }

    const now = Date.now();
    let nextRemindAt = existing.remind_at;
    let nextStatus = parsed.data.status ?? existing.status;

    if (typeof parsed.data.snoozeMinutes === 'number') {
      nextRemindAt = now + Math.round(parsed.data.snoozeMinutes * 60_000);
      nextStatus = 'active';
    } else if (typeof parsed.data.remindAt === 'number') {
      nextRemindAt = Math.round(parsed.data.remindAt);
    }

    const nextNote = parsed.data.note !== undefined ? parsed.data.note.trim() : existing.note;

    db.prepare(
      `UPDATE study_reminders
       SET remind_at = ?, status = ?, note = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`
    ).run(nextRemindAt, nextStatus, nextNote, now, id, userId);

    const updated = db
      .prepare(
        `SELECT id, subject_id, subject_name_snapshot, note, remind_at, duration_minutes, status, created_at, updated_at
         FROM study_reminders WHERE id = ?`
      )
      .get(id) as ReminderRow;

    if (nextStatus === 'completed' && existing.status !== 'completed') {
      hub?.broadcastChallengesUpdated();
    }

    res.json({ reminder: mapReminderRow(updated) });
  });

  router.delete('/reminders/:id', requireAuth, (req: AuthenticatedRequest, res) => {
    const id = String(req.params.id);
    const result = db
      .prepare('DELETE FROM study_reminders WHERE id = ? AND user_id = ?')
      .run(id, req.authUser!.id);

    if (result.changes === 0) {
      res.status(404).json({ error: 'التذكير غير موجود' });
      return;
    }

    res.json({ ok: true });
  });

  return router;
}
