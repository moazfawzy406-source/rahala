import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RahhalaConfig } from '../config.ts';
import type { RahhalaDb } from '../db.ts';
import { safeUrlSchema } from '../lib/validation.ts';
import { type AuthenticatedRequest, createAuthMiddleware } from '../middleware/auth.ts';

const MATERIAL_KINDS = ['pdf', 'video', 'doc', 'drive', 'telegram', 'link'] as const;

export function createResourcesRouter(db: RahhalaDb, config: RahhalaConfig): Router {
  const router = Router();
  const { requireAuth, requireAdminOrOwner } = createAuthMiddleware(db, config);

  router.get('/resources/subjects', requireAuth, (_req, res) => {
    const rows = db
      .prepare(
        `SELECT s.id, s.name, s.accent_color, s.icon_name, s.sort_order, s.created_at,
                (SELECT COUNT(*) FROM materials m WHERE m.subject_id = s.id) AS material_count,
                (SELECT COUNT(*) FROM sections sec WHERE sec.subject_id = s.id) AS section_count
         FROM subjects s
         ORDER BY s.sort_order ASC, s.created_at ASC`
      )
      .all() as Array<{
      id: string;
      name: string;
      accent_color: string;
      icon_name: string;
      sort_order: number;
      created_at: number;
      material_count: number;
      section_count: number;
    }>;

    res.json({
      subjects: rows.map((r) => ({
        id: r.id,
        name: r.name,
        accentColor: r.accent_color,
        iconName: r.icon_name,
        sortOrder: r.sort_order,
        createdAt: r.created_at,
        materialCount: r.material_count,
        sectionCount: r.section_count,
      })),
    });
  });

  router.get('/resources/search', requireAuth, (req, res) => {
    const rawQ = String(req.query.q ?? '').trim();
    if (!rawQ) {
      res.json({ results: [] });
      return;
    }
    const escaped = rawQ.replace(/[\\%_]/g, (m) => `\\${m}`);
    const likePattern = `%${escaped}%`;

    const rows = db
      .prepare(
        `SELECT m.id, m.title, m.kind, m.url, m.note, m.subject_id, m.section_id,
                s.name AS subject_name, s.accent_color AS subject_color,
                sec.label AS section_label
         FROM materials m
         JOIN subjects s ON s.id = m.subject_id
         JOIN sections sec ON sec.id = m.section_id
         WHERE m.title LIKE ? ESCAPE '\\'
            OR m.note LIKE ? ESCAPE '\\'
            OR s.name LIKE ? ESCAPE '\\'
            OR sec.label LIKE ? ESCAPE '\\'
         ORDER BY m.created_at DESC
         LIMIT 30`
      )
      .all(likePattern, likePattern, likePattern, likePattern) as Array<{
      id: string;
      title: string;
      kind: (typeof MATERIAL_KINDS)[number];
      url: string;
      note: string;
      subject_id: string;
      section_id: string;
      subject_name: string;
      subject_color: string;
      section_label: string;
    }>;

    res.json({
      results: rows.map((r) => ({
        id: r.id,
        title: r.title,
        kind: r.kind,
        url: r.url,
        note: r.note,
        subjectId: r.subject_id,
        sectionId: r.section_id,
        subjectName: r.subject_name,
        subjectColor: r.subject_color,
        sectionLabel: r.section_label,
      })),
    });
  });

  router.get('/resources/subjects/:id', requireAuth, (req, res) => {
    const subjectId = String(req.params.id);
    const subjectRow = db
      .prepare(
        `SELECT s.id, s.name, s.accent_color, s.icon_name, s.sort_order, s.created_at,
                (SELECT COUNT(*) FROM materials m WHERE m.subject_id = s.id) AS material_count,
                (SELECT COUNT(*) FROM sections sec WHERE sec.subject_id = s.id) AS section_count
         FROM subjects s WHERE s.id = ?`
      )
      .get(subjectId) as
      | {
          id: string;
          name: string;
          accent_color: string;
          icon_name: string;
          sort_order: number;
          created_at: number;
          material_count: number;
          section_count: number;
        }
      | undefined;

    if (!subjectRow) {
      res.status(404).json({ error: 'المادة الدراسية غير موجودة' });
      return;
    }

    const sectionRows = db
      .prepare(
        'SELECT id, subject_id, label, sort_order FROM sections WHERE subject_id = ? ORDER BY sort_order ASC, rowid ASC'
      )
      .all(subjectId) as Array<{
      id: string;
      subject_id: string;
      label: string;
      sort_order: number;
    }>;

    const materialRows = db
      .prepare(
        `SELECT id, subject_id, section_id, title, kind, url, note, creator_id, sort_order, created_at, updated_at
         FROM materials
         WHERE subject_id = ?
         ORDER BY sort_order ASC, created_at DESC`
      )
      .all(subjectId) as Array<{
      id: string;
      subject_id: string;
      section_id: string;
      title: string;
      kind: (typeof MATERIAL_KINDS)[number];
      url: string;
      note: string;
      creator_id: string | null;
      sort_order: number;
      created_at: number;
      updated_at: number;
    }>;

    const materialsBySection = new Map<string, typeof materialRows>();
    for (const m of materialRows) {
      const list = materialsBySection.get(m.section_id) ?? [];
      list.push(m);
      materialsBySection.set(m.section_id, list);
    }

    res.json({
      subject: {
        id: subjectRow.id,
        name: subjectRow.name,
        accentColor: subjectRow.accent_color,
        iconName: subjectRow.icon_name,
        sortOrder: subjectRow.sort_order,
        createdAt: subjectRow.created_at,
        materialCount: subjectRow.material_count,
        sectionCount: subjectRow.section_count,
      },
      sections: sectionRows.map((sec) => ({
        id: sec.id,
        subjectId: sec.subject_id,
        label: sec.label,
        sortOrder: sec.sort_order,
        materials: (materialsBySection.get(sec.id) ?? []).map((m) => ({
          id: m.id,
          subjectId: m.subject_id,
          sectionId: m.section_id,
          title: m.title,
          kind: m.kind,
          url: m.url,
          note: m.note,
          creatorId: m.creator_id,
          sortOrder: m.sort_order,
          createdAt: m.created_at,
          updatedAt: m.updated_at,
        })),
      })),
    });
  });

  const createSubjectSchema = z.object({
    name: z.string().trim().min(2, 'اسم المادة لازم يكون حرفين على الأقل').max(80),
    accentColor: z
      .string()
      .trim()
      .regex(/^#[0-9a-fA-F]{6}$/, 'لون غير صالح')
      .default('#E3B23C'),
    iconName: z
      .enum(['book-open', 'feather', 'scroll', 'landmark', 'compass', 'layers'])
      .default('book-open'),
    initialSections: z.array(z.string().trim().min(1).max(40)).max(8).optional(),
  });

  router.post('/resources/subjects', requireAuth, requireAdminOrOwner, (req, res) => {
    const parsed = createSubjectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'بيانات المادة غير صالحة' });
      return;
    }

    const now = Date.now();
    const subjectId = `subj_${randomUUID().slice(0, 8)}`;
    const maxOrderRow = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM subjects').get() as {
      m: number;
    };
    const defaultSections =
      parsed.data.initialSections && parsed.data.initialSections.length > 0
        ? parsed.data.initialSections
        : ['ملخصات', 'محاضرات', 'مصادر'];

    const tx = db.transaction(() => {
      db.prepare(
        'INSERT INTO subjects (id, name, accent_color, icon_name, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(
        subjectId,
        parsed.data.name,
        parsed.data.accentColor,
        parsed.data.iconName,
        maxOrderRow.m + 1,
        now
      );

      const insSec = db.prepare(
        'INSERT INTO sections (id, subject_id, label, sort_order) VALUES (?, ?, ?, ?)'
      );
      defaultSections.forEach((label, idx) => {
        insSec.run(`sec_${randomUUID().slice(0, 8)}`, subjectId, label, idx + 1);
      });
    });
    tx();

    res.status(201).json({
      subject: {
        id: subjectId,
        name: parsed.data.name,
        accentColor: parsed.data.accentColor,
        iconName: parsed.data.iconName,
        sortOrder: maxOrderRow.m + 1,
        createdAt: now,
        materialCount: 0,
        sectionCount: defaultSections.length,
      },
    });
  });

  router.delete('/resources/subjects/:id', requireAuth, requireAdminOrOwner, (req, res) => {
    const subjectId = String(req.params.id);
    const existing = db.prepare('SELECT id, name FROM subjects WHERE id = ?').get(subjectId) as
      | { id: string; name: string }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'المادة غير موجودة' });
      return;
    }

    const tx = db.transaction(() => {
      db.prepare('DELETE FROM materials WHERE subject_id = ?').run(subjectId);
      db.prepare('DELETE FROM sections WHERE subject_id = ?').run(subjectId);
      db.prepare('DELETE FROM subjects WHERE id = ?').run(subjectId);
    });
    tx();

    res.json({ ok: true });
  });

  const createSectionSchema = z.object({
    label: z.string().trim().min(2, 'اسم القسم لازم يكون حرفين على الأقل').max(50),
  });

  router.post(
    '/resources/subjects/:id/sections',
    requireAuth,
    requireAdminOrOwner,
    (req, res) => {
      const subjectId = String(req.params.id);
      const subject = db.prepare('SELECT id FROM subjects WHERE id = ?').get(subjectId);
      if (!subject) {
        res.status(404).json({ error: 'المادة الدراسية غير موجودة' });
        return;
      }

      const parsed = createSectionSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message || 'اسم القسم غير صالح' });
        return;
      }

      const maxOrder = (
        db
          .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM sections WHERE subject_id = ?')
          .get(subjectId) as { m: number }
      ).m;
      const sectionId = `sec_${randomUUID().slice(0, 8)}`;

      db.prepare('INSERT INTO sections (id, subject_id, label, sort_order) VALUES (?, ?, ?, ?)').run(
        sectionId,
        subjectId,
        parsed.data.label,
        maxOrder + 1
      );

      res.status(201).json({
        section: {
          id: sectionId,
          subjectId,
          label: parsed.data.label,
          sortOrder: maxOrder + 1,
          materials: [],
        },
      });
    }
  );

  router.delete('/resources/sections/:id', requireAuth, requireAdminOrOwner, (req, res) => {
    const sectionId = String(req.params.id);
    const section = db
      .prepare('SELECT id, subject_id, label FROM sections WHERE id = ?')
      .get(sectionId) as { id: string; subject_id: string; label: string } | undefined;

    if (!section) {
      res.status(404).json({ error: 'القسم غير موجود' });
      return;
    }

    const materialCount = (
      db
        .prepare('SELECT COUNT(*) AS cnt FROM materials WHERE section_id = ?')
        .get(sectionId) as { cnt: number }
    ).cnt;

    const moveToSectionId =
      typeof req.body?.moveToSectionId === 'string' ? req.body.moveToSectionId : null;
    const confirmCascade = req.body?.confirmCascade === true;

    if (materialCount > 0 && !moveToSectionId && !confirmCascade) {
      res.status(409).json({
        error: 'القسم يحتوي على محتوى. اختر قسمًا لنقل الروابط إليه أو أكد حذف المحتوى معه.',
        materialCount,
      });
      return;
    }

    if (moveToSectionId) {
      if (moveToSectionId === sectionId) {
        res.status(400).json({ error: 'اختر قسمًا مختلفًا لنقل المحتوى' });
        return;
      }
      const targetSec = db
        .prepare('SELECT id FROM sections WHERE id = ? AND subject_id = ?')
        .get(moveToSectionId, section.subject_id);
      if (!targetSec) {
        res.status(400).json({ error: 'القسم المستهدف غير موجود في نفس المادة' });
        return;
      }
    }

    const tx = db.transaction(() => {
      if (materialCount > 0) {
        if (moveToSectionId) {
          const maxTargetOrder = (
            db
              .prepare(
                'SELECT COALESCE(MAX(sort_order), 0) AS m FROM materials WHERE section_id = ?'
              )
              .get(moveToSectionId) as { m: number }
          ).m;
          const items = db
            .prepare(
              'SELECT id FROM materials WHERE section_id = ? ORDER BY sort_order ASC, created_at DESC'
            )
            .all(sectionId) as Array<{ id: string }>;
          const upd = db.prepare(
            'UPDATE materials SET section_id = ?, sort_order = ?, updated_at = ? WHERE id = ?'
          );
          const now = Date.now();
          items.forEach((item, idx) => {
            upd.run(moveToSectionId, maxTargetOrder + idx + 1, now, item.id);
          });
        } else {
          db.prepare('DELETE FROM materials WHERE section_id = ?').run(sectionId);
        }
      }
      db.prepare('DELETE FROM sections WHERE id = ?').run(sectionId);
    });
    tx();

    res.json({ ok: true });
  });

  const createMaterialSchema = z.object({
    subjectId: z.string().min(1),
    sectionId: z.string().min(1),
    title: z.string().trim().min(2, 'اكتب عنوان المحتوى').max(140),
    kind: z.enum(MATERIAL_KINDS),
    url: safeUrlSchema,
    note: z.string().trim().max(300).optional().default(''),
  });

  router.post(
    '/resources/materials',
    requireAuth,
    requireAdminOrOwner,
    (req: AuthenticatedRequest, res) => {
      const parsed = createMaterialSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message || 'بيانات المحتوى غير صالحة' });
        return;
      }

      const { subjectId, sectionId, title, kind, url, note } = parsed.data;
      const section = db
        .prepare('SELECT id FROM sections WHERE id = ? AND subject_id = ?')
        .get(sectionId, subjectId);

      if (!section) {
        res.status(400).json({ error: 'القسم غير تابع للمادة المحددة' });
        return;
      }

      const now = Date.now();
      const materialId = `mat_${randomUUID().slice(0, 10)}`;

      // New resources appear FIRST in the selected section with deterministic ordering
      const tx = db.transaction(() => {
        const minOrderRow = db
          .prepare('SELECT COALESCE(MIN(sort_order), 1) AS minOrder FROM materials WHERE section_id = ?')
          .get(sectionId) as { minOrder: number };
        const nextOrder = minOrderRow.minOrder - 1;

        db.prepare(
          `INSERT INTO materials (id, subject_id, section_id, title, kind, url, note, creator_id, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(materialId, subjectId, sectionId, title, kind, url, note, req.authUser!.id, nextOrder, now, now);

        return nextOrder;
      });

      const sortOrder = tx();

      res.status(201).json({
        material: {
          id: materialId,
          subjectId,
          sectionId,
          title,
          kind,
          url,
          note,
          creatorId: req.authUser!.id,
          sortOrder,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
  );

  const patchMaterialSchema = z.object({
    title: z.string().trim().min(2).max(140).optional(),
    kind: z.enum(MATERIAL_KINDS).optional(),
    url: safeUrlSchema.optional(),
    note: z.string().trim().max(300).optional(),
    sectionId: z.string().min(1).optional(),
    direction: z.enum(['up', 'down']).optional(),
  });

  router.patch('/resources/materials/:id', requireAuth, requireAdminOrOwner, (req, res) => {
    const materialId = String(req.params.id);
    const existing = db
      .prepare('SELECT * FROM materials WHERE id = ?')
      .get(materialId) as
      | {
          id: string;
          subject_id: string;
          section_id: string;
          title: string;
          kind: string;
          url: string;
          note: string;
          sort_order: number;
          created_at: number;
        }
      | undefined;

    if (!existing) {
      res.status(404).json({ error: 'المحتوى غير موجود' });
      return;
    }

    const parsed = patchMaterialSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'تعديل غير صالح' });
      return;
    }

    const now = Date.now();

    const tx = db.transaction(() => {
      if (parsed.data.sectionId && parsed.data.sectionId !== existing.section_id) {
        const targetSection = db
          .prepare('SELECT id FROM sections WHERE id = ? AND subject_id = ?')
          .get(parsed.data.sectionId, existing.subject_id);
        if (!targetSection) {
          throw new Error('INVALID_SECTION');
        }
        const minRow = db
          .prepare(
            'SELECT COALESCE(MIN(sort_order), 1) AS m FROM materials WHERE section_id = ?'
          )
          .get(parsed.data.sectionId) as { m: number };
        db.prepare(
          'UPDATE materials SET section_id = ?, sort_order = ?, updated_at = ? WHERE id = ?'
        ).run(parsed.data.sectionId, minRow.m - 1, now, materialId);
      }

      if (parsed.data.direction) {
        const currentSecId = parsed.data.sectionId ?? existing.section_id;
        const siblings = db
          .prepare(
            'SELECT id, sort_order FROM materials WHERE section_id = ? ORDER BY sort_order ASC, created_at DESC'
          )
          .all(currentSecId) as Array<{ id: string; sort_order: number }>;

        // Normalize deterministic indices first (1..N)
        const idx = siblings.findIndex((s) => s.id === materialId);
        if (idx !== -1) {
          const targetIdx = parsed.data.direction === 'up' ? idx - 1 : idx + 1;
          if (targetIdx >= 0 && targetIdx < siblings.length) {
            const temp = siblings[idx];
            siblings[idx] = siblings[targetIdx];
            siblings[targetIdx] = temp;
          }
          const updOrder = db.prepare('UPDATE materials SET sort_order = ? WHERE id = ?');
          siblings.forEach((s, i) => updOrder.run(i + 1, s.id));
        }
      }

      const nextTitle = parsed.data.title ?? existing.title;
      const nextKind = parsed.data.kind ?? existing.kind;
      const nextUrl = parsed.data.url ?? existing.url;
      const nextNote = parsed.data.note ?? existing.note;

      db.prepare(
        'UPDATE materials SET title = ?, kind = ?, url = ?, note = ?, updated_at = ? WHERE id = ?'
      ).run(nextTitle, nextKind, nextUrl, nextNote, now, materialId);
    });

    try {
      tx();
    } catch (err) {
      if (err instanceof Error && err.message === 'INVALID_SECTION') {
        res.status(400).json({ error: 'القسم المستهدف لا يتبع نفس المادة' });
        return;
      }
      throw err;
    }

    res.json({ ok: true });
  });

  router.delete('/resources/materials/:id', requireAuth, requireAdminOrOwner, (req, res) => {
    const materialId = String(req.params.id);
    const info = db.prepare('DELETE FROM materials WHERE id = ?').run(materialId);
    if (info.changes === 0) {
      res.status(404).json({ error: 'المحتوى غير موجود' });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
