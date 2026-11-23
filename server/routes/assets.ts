import express, { Router } from 'express';
import { randomUUID } from 'node:crypto';
import type { RahhalaConfig } from '../config.ts';
import { getOrCreateSigningSecret, type RahhalaDb } from '../db.ts';
import { sha256Hex, signShortToken, verifyShortToken } from '../lib/crypto.ts';
import { detectAndValidateFile } from '../lib/fileValidation.ts';
import { canViewerAccessAsset, getHistoryCutoff } from '../lib/historyAccess.ts';
import { buildContentDisposition, sanitizeFilename } from '../lib/validation.ts';
import {
  type AuthenticatedRequest,
  createAuthMiddleware,
  extractSessionToken,
  resolveActiveSession,
} from '../middleware/auth.ts';
import type { ChannelId, MediaGalleryItem } from '../../shared/types.ts';

const CHUNK_SIZE = 512 * 1024; // 512 KB chunks

export function createAssetsRouter(db: RahhalaDb, config: RahhalaConfig): Router {
  const router = Router();
  const { requireAuth } = createAuthMiddleware(db, config);
  const signingSecret = getOrCreateSigningSecret(db);

  function readBoundedRawBody(
    req: express.Request,
    maxBytes: number
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const contentLengthHeader = req.headers['content-length'];
      if (contentLengthHeader) {
        const declared = Number(contentLengthHeader);
        if (Number.isFinite(declared) && declared > maxBytes) {
          reject(new Error('PAYLOAD_TOO_LARGE'));
          req.resume();
          return;
        }
      }

      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;

      req.on('data', (chunk: Buffer) => {
        if (settled) return;
        total += chunk.length;
        if (total > maxBytes) {
          settled = true;
          reject(new Error('PAYLOAD_TOO_LARGE'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks, total));
      });

      req.on('error', (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
    });
  }

  // Raw binary upload route (filename & purpose passed via headers)
  // Enforces size limit BEFORE buffering full body and validates magic bytes + structure
  router.post('/assets/upload', requireAuth, async (req: AuthenticatedRequest, res) => {
    const purpose = String(req.headers['x-rahhala-purpose'] || 'chat_file');
    if (purpose !== 'chat_file' && purpose !== 'chat_audio' && purpose !== 'avatar') {
      res.status(400).json({ error: 'نوع الرفع غير مدعوم' });
      return;
    }

    const maxBytes =
      purpose === 'avatar'
        ? config.maxAvatarBytes
        : purpose === 'chat_audio'
        ? config.maxVoiceBytes
        : config.maxUploadBytes;

    let buf: Buffer;
    try {
      buf = await readBoundedRawBody(req, maxBytes);
    } catch (err) {
      if (err instanceof Error && err.message === 'PAYLOAD_TOO_LARGE') {
        res.status(413).json({
          error:
            purpose === 'chat_audio'
              ? 'حجم التسجيل الصوتي يتجاوز الحد الأقصى (١٢ ميجابايت)'
              : 'حجم الملف يتجاوز الحد الأقصى المسموح به (١٥ ميجابايت)',
        });
        return;
      }
      res.status(400).json({ error: 'تعذر قراءة الملف المرفوع' });
      return;
    }

    if (buf.length === 0) {
      res.status(400).json({ error: 'الملف فارغ' });
      return;
    }

    const detected = detectAndValidateFile(buf, {
      allowImage: true,
      allowOfficeAndPdf: purpose === 'chat_file',
      allowAudio: purpose === 'chat_audio' || purpose === 'chat_file',
    });

    if (!detected) {
      res.status(415).json({
        error:
          'نوع الملف غير مدعوم أو تالف. المسموح: الصور، PDF، الصوتيات، ومستندات DOCX / PPTX / XLSX الصالحة.',
      });
      return;
    }

    if (purpose === 'avatar' && detected.kind !== 'image') {
      res.status(415).json({ error: 'الصورة الشخصية يجب أن تكون بصيغة صورة صالحة' });
      return;
    }
    if (purpose === 'chat_audio' && detected.kind !== 'audio') {
      res.status(415).json({ error: 'الملف الصوتي غير صالح' });
      return;
    }

    const encodedHeaderName = String(req.headers['x-rahhala-filename'] || '');
    let decodedName = 'file';
    try {
      decodedName = encodedHeaderName ? decodeURIComponent(encodedHeaderName) : 'file';
    } catch {
      decodedName = encodedHeaderName || 'file';
    }
    const safeName = sanitizeFilename(decodedName, detected.extension);

    const now = Date.now();
    const assetId = `ast_${randomUUID()}`;
    const storedKind = purpose === 'avatar' ? 'avatar' : detected.kind;

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO assets (id, uploader_id, detected_mime, original_safe_name, byte_size, kind, binding_type, binding_id, created_at, finalized_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`
      ).run(assetId, req.authUser!.id, detected.mime, safeName, buf.length, storedKind, now, now);

      const insChunk = db.prepare(
        'INSERT INTO asset_chunks (asset_id, sequence, data, byte_length, checksum) VALUES (?, ?, ?, ?, ?)'
      );
      let seq = 0;
      for (let offset = 0; offset < buf.length; offset += CHUNK_SIZE) {
        const slice = buf.subarray(offset, Math.min(offset + CHUNK_SIZE, buf.length));
        insChunk.run(assetId, seq, slice, slice.length, sha256Hex(slice));
        seq++;
      }
    });
    tx();

    res.status(201).json({
      asset: {
        assetId,
        kind: storedKind,
        mime: detected.mime,
        filename: safeName,
        byteSize: buf.length,
      },
    });
  });

  // Mint short-lived user-scoped access token immediately before preview/download
  router.post('/assets/:id/access-token', requireAuth, (req: AuthenticatedRequest, res) => {
    const assetId = String(req.params.id);
    const assetRow = db
      .prepare('SELECT id, uploader_id, binding_type, binding_id FROM assets WHERE id = ?')
      .get(assetId) as
      | { id: string; uploader_id: string | null; binding_type: string; binding_id: string | null }
      | undefined;

    if (!assetRow || !canViewerAccessAsset(db, req.authUser!, assetRow)) {
      res.status(403).json({ error: 'لا يمكنك الوصول لهذا الملف' });
      return;
    }

    const exp = Date.now() + 5 * 60 * 1000; // 5 minutes
    const token = signShortToken(
      {
        kind: 'asset',
        assetId,
        userId: req.authUser!.id,
        exp,
      },
      signingSecret
    );

    res.json({ token, expiresAt: exp });
  });

  // Protected asset streaming/download route (no permanent public URLs!)
  router.get('/assets/:id/content', (req, res) => {
    const assetId = String(req.params.id);
    const tokenParam = typeof req.query.token === 'string' ? req.query.token : null;
    const isDownload = req.query.download === '1';

    let viewerUserId: string | null = null;

    if (tokenParam) {
      const payload = verifyShortToken<{ kind: string; assetId: string; userId: string }>(
        tokenParam,
        signingSecret
      );
      if (!payload || payload.kind !== 'asset' || payload.assetId !== assetId) {
        res.status(403).json({ error: 'رابط الوصول للملف منتهي أو غير صالح' });
        return;
      }
      viewerUserId = payload.userId;
    } else {
      const resolved = resolveActiveSession(db, config, extractSessionToken(req), {
        touchActivity: false,
      });
      if (!resolved.ok) {
        res.status(401).json({ error: resolved.message });
        return;
      }
      viewerUserId = resolved.data.user.id;
    }

    const userRow = db
      .prepare('SELECT id, role, approval_status, history_granted, created_at FROM users WHERE id = ?')
      .get(viewerUserId) as
      | {
          id: string;
          role: 'member' | 'admin' | 'owner';
          approval_status: string;
          history_granted: number;
          created_at: number;
        }
      | undefined;

    if (!userRow || userRow.approval_status !== 'approved') {
      res.status(403).json({ error: 'غير مصرح بالوصول للملف' });
      return;
    }

    const assetRow = db
      .prepare(
        'SELECT id, uploader_id, detected_mime, original_safe_name, byte_size, kind, binding_type, binding_id FROM assets WHERE id = ?'
      )
      .get(assetId) as
      | {
          id: string;
          uploader_id: string | null;
          detected_mime: string;
          original_safe_name: string;
          byte_size: number;
          kind: string;
          binding_type: string;
          binding_id: string | null;
        }
      | undefined;

    if (!assetRow) {
      res.status(404).json({ error: 'الملف غير موجود' });
      return;
    }

    const viewer = {
      id: userRow.id,
      role: userRow.role,
      approvalStatus: userRow.approval_status,
      historyGranted: Boolean(userRow.history_granted),
      createdAt: userRow.created_at,
    };

    if (!canViewerAccessAsset(db, viewer, assetRow)) {
      res.status(403).json({ error: 'ليس لديك صلاحية الوصول لهذا الملف' });
      return;
    }

    const chunks = db
      .prepare(
        'SELECT sequence, data, byte_length, checksum FROM asset_chunks WHERE asset_id = ? ORDER BY sequence ASC'
      )
      .all(assetId) as Array<{
      sequence: number;
      data: Buffer;
      byte_length: number;
      checksum: string;
    }>;

    // Verify complete sequence and byte length
    let totalBytes = 0;
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i].sequence !== i || chunks[i].data.length !== chunks[i].byte_length) {
        res.status(500).json({ error: 'الملف تالف أثناء التجميع' });
        return;
      }
      if (sha256Hex(chunks[i].data) !== chunks[i].checksum) {
        res.status(500).json({ error: 'تعذر التحقق من سلامة الملف' });
        return;
      }
      totalBytes += chunks[i].data.length;
    }

    if (totalBytes !== assetRow.byte_size) {
      res.status(500).json({ error: 'حجم الملف غير مكتمل' });
      return;
    }

    const fullBuffer = Buffer.concat(
      chunks.map((c) => c.data),
      totalBytes
    );

    const inlineAllowed =
      !isDownload &&
      (assetRow.detected_mime.startsWith('image/') || assetRow.detected_mime.startsWith('audio/'));

    res.setHeader('Content-Type', assetRow.detected_mime);
    res.setHeader('Content-Length', String(totalBytes));
    res.setHeader(
      'Content-Disposition',
      buildContentDisposition(assetRow.original_safe_name, inlineAllowed)
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(fullBuffer);
  });

  // Media gallery endpoint (images only, strictly respecting history, hidden, and deleted messages)
  router.get('/assets/media', requireAuth, (req: AuthenticatedRequest, res) => {
    const viewer = req.authUser!;
    const cutoff = getHistoryCutoff(viewer);

    const rows = db
      .prepare(
        `SELECT a.id AS asset_id, a.original_safe_name, a.detected_mime, a.byte_size,
                m.id AS message_id, m.channel, m.sender_name_snapshot, m.created_at
         FROM messages m
         JOIN assets a ON a.id = m.file_asset_id
         WHERE m.deleted_at IS NULL
           AND m.created_at >= ?
           AND a.kind = 'image'
           AND NOT EXISTS (
             SELECT 1 FROM message_hides mh WHERE mh.user_id = ? AND mh.message_id = m.id
           )
         ORDER BY m.id DESC
         LIMIT 120`
      )
      .all(cutoff, viewer.id) as Array<{
      asset_id: string;
      original_safe_name: string;
      detected_mime: string;
      byte_size: number;
      message_id: number;
      channel: ChannelId;
      sender_name_snapshot: string;
      created_at: number;
    }>;

    const items: MediaGalleryItem[] = rows.map((r) => ({
      assetId: r.asset_id,
      messageId: r.message_id,
      channel: r.channel,
      filename: r.original_safe_name,
      mime: r.detected_mime,
      byteSize: r.byte_size,
      senderName: r.sender_name_snapshot,
      createdAt: r.created_at,
    }));

    res.json({ items });
  });

  return router;
}
