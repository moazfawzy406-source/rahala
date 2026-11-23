import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createRahhalaApp, type RahhalaServerContext } from '../server/app.ts';
import { hashPassword } from '../server/lib/crypto.ts';

function makeMinimalZip(entries: Array<{ name: string; content: string }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const dataBuf = Buffer.from(entry.content, 'utf8');

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 8); // stored
    localHeader.writeUInt32LE(dataBuf.length, 18);
    localHeader.writeUInt32LE(dataBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);

    localParts.push(localHeader, nameBuf, dataBuf);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt32LE(dataBuf.length, 20);
    centralHeader.writeUInt32LE(dataBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + dataBuf.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

function makeMinimalPdf(): Buffer {
  return Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'ascii');
}

function makeMinimalPng(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}

class TestClient {
  baseUrl: string;
  cookie = '';

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async req(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set('X-Rahhala-CSRF', '1');
    if (this.cookie) headers.set('Cookie', this.cookie);
    if (init.body && typeof init.body === 'string' && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      this.cookie = setCookie.split(';')[0];
    }
    return res;
  }

  async json<T = any>(path: string, init: RequestInit = {}): Promise<{ status: number; data: T }> {
    const res = await this.req(path, init);
    const data = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, data };
  }
}

describe('Rahhala Full-Stack Acceptance Suite', () => {
  let ctx: RahhalaServerContext;
  let baseUrl: string;

  beforeEach(async () => {
    ctx = createRahhalaApp({
      dbPath: ':memory:',
      previewDemoEnabled: false,
      isProduction: false,
      sessionIdleMs: 5000,
    });
    await new Promise<void>((resolve) => {
      ctx.httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = ctx.httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    // Initialize owner directly in DB (as CLI init-owner does) — 49 hours ago
    const oldTs = Date.now() - 49 * 60 * 60 * 1000;
    ctx.db
      .prepare(
        `INSERT INTO users (id, display_name, username, email, password_hash, role, approval_status, history_granted, bio, created_at, updated_at)
         VALUES ('usr_owner', 'المالك الأول', 'owner_one', 'owner@example.invalid', ?, 'owner', 'approved', 1, '', ?, ?)`
      )
      .run(hashPassword('OwnerPass123'), oldTs, oldTs);

    ctx.db
      .prepare(
        `INSERT INTO users (id, display_name, username, email, password_hash, role, approval_status, history_granted, bio, created_at, updated_at)
         VALUES ('usr_admin', 'المشرف الأول', 'admin_one', 'admin@example.invalid', ?, 'admin', 'approved', 1, '', ?, ?)`
      )
      .run(hashPassword('AdminPass123'), oldTs, oldTs);

    // Seed an old historical message + attachment created before new member joins
    ctx.db
      .prepare(
        `INSERT INTO messages (id, channel, sender_id, sender_name_snapshot, body, created_at)
         VALUES (1, 'general', 'usr_owner', 'المالك الأول', 'رسالة قديمة سرية قبل انضمام العضو الجديد', ?)`
      )
      .run(oldTs + 5000);
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('A & B: Auth registration, pending approval, lowercase login, rate-limit lock, idle session expiry unaffected by polling, and session revocation', async () => {
    const guest = new TestClient(baseUrl);
    const owner = new TestClient(baseUrl);

    // Register pending member
    const reg = await guest.json('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        displayName: 'أحمد الطالب',
        username: 'Ahmed_Student',
        email: 'ahmed@example.invalid',
        password: 'Password123',
        confirmPassword: 'Password123',
      }),
    });
    expect(reg.status).toBe(201);

    // Duplicate username rejected case-insensitively
    const dupUser = await guest.json('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        displayName: 'اسم مختلف',
        username: 'ahmed_student',
        email: 'other@example.invalid',
        password: 'Password123',
        confirmPassword: 'Password123',
      }),
    });
    expect(dupUser.status).toBe(409);

    // Pending account cannot login
    const pendingLogin = await guest.json('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'ahmed_student', password: 'Password123' }),
    });
    expect(pendingLogin.status).toBe(403);

    // Owner logs in and approves student
    await owner.json('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'OWNER_ONE', password: 'OwnerPass123' }),
    });
    const reqs = await owner.json('/api/admin/requests');
    expect(reqs.data.pendingUsers).toHaveLength(1);
    const pendingId = reqs.data.pendingUsers[0].id;
    const appRes = await owner.json(`/api/admin/registrations/${pendingId}/approve`, {
      method: 'POST',
    });
    expect(appRes.status).toBe(200);

    // Wrong password 8 times triggers lock
    for (let i = 0; i < 8; i++) {
      await guest.json('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: 'ahmed_student', password: 'wrong' }),
      });
    }
    const lockedRes = await guest.json('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'ahmed_student', password: 'Password123' }),
    });
    expect(lockedRes.status).toBe(429);

    // Clear lock in DB to test normal login + sessions
    ctx.db.prepare('DELETE FROM auth_attempts').run();
    const okLogin = await guest.json('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'AHMED_STUDENT', password: 'Password123' }),
    });
    expect(okLogin.status).toBe(200);
    expect(okLogin.data.user.username).toBe('ahmed_student');

    // Background polling does NOT keep an idle session alive
    const sessionsBefore = await guest.json('/api/auth/sessions?background=1');
    const lastActBefore = sessionsBefore.data.sessions[0].lastActivityAt;
    await new Promise((r) => setTimeout(r, 50));
    await guest.json('/api/auth/me?background=1');
    const sessionsAfterBg = await guest.json('/api/auth/sessions?background=1');
    expect(sessionsAfterBg.data.sessions[0].lastActivityAt).toBe(lastActBefore);

    // Second session can be revoked via revoke-others
    const guest2 = new TestClient(baseUrl);
    await guest2.json('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'ahmed_student', password: 'Password123' }),
    });
    await guest.json('/api/auth/sessions/revoke-others', { method: 'POST' });
    const me2 = await guest2.json('/api/auth/me');
    expect(me2.status).toBe(401);
  });

  it('C & D: Role boundaries, owner protection, resources ordering, safe URLs, and section cleanup', async () => {
    const owner = new TestClient(baseUrl);
    const admin = new TestClient(baseUrl);
    const member = new TestClient(baseUrl);

    ctx.db
      .prepare(
        `INSERT INTO users (id, display_name, username, email, password_hash, role, approval_status, history_granted, bio, created_at, updated_at)
         VALUES ('usr_mem', 'عضو عادي', 'normal_mem', 'mem@example.invalid', ?, 'member', 'approved', 0, '', ?, ?)`
      )
      .run(hashPassword('MemPass123'), Date.now(), Date.now());

    await owner.json('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'owner_one', password: 'OwnerPass123' }),
    });
    await admin.json('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin_one', password: 'AdminPass123' }),
    });
    await member.json('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'normal_mem', password: 'MemPass123' }),
    });

    // Member blocked from admin routes & private emails
    expect((await member.json('/api/admin/requests')).status).toBe(403);
    const memList = await member.json('/api/members');
    expect(memList.data.members.every((m: any) => m.privateEmail === undefined)).toBe(true);

    // Admin CANNOT remove another admin or reset owner password
    expect((await admin.json('/api/admin/members/usr_owner', { method: 'DELETE' })).status).toBe(403);
    expect(
      (
        await admin.json('/api/admin/members/usr_owner/reset-password', {
          method: 'POST',
          body: JSON.stringify({ temporaryPassword: 'NewPassword123' }),
        })
      ).status
    ).toBe(403);
    expect(
      (
        await admin.json('/api/admin/members/usr_admin/role', {
          method: 'POST',
          body: JSON.stringify({ role: 'member' }),
        })
      ).status
    ).toBe(403);

    // Admin CAN remove ordinary member (and owner CAN export archive, admin CANNOT)
    expect((await admin.req('/api/admin/export-archive')).status).toBe(403);
    expect((await owner.req('/api/admin/export-archive')).status).toBe(200);

    // Resources: invalid URL blocked, deterministic first-item insertion
    const subRes = await admin.json('/api/resources/subjects', {
      method: 'POST',
      body: JSON.stringify({ name: 'مادة اختبارية', accentColor: '#E3B23C', iconName: 'book-open' }),
    });
    expect(subRes.status).toBe(201);
    const subjId = subRes.data.subject.id;
    const detail = await admin.json(`/api/resources/subjects/${subjId}`);
    const sec1 = detail.data.sections[0].id;
    const sec2 = detail.data.sections[1].id;

    const badUrl = await admin.json('/api/resources/materials', {
      method: 'POST',
      body: JSON.stringify({
        subjectId: subjId,
        sectionId: sec1,
        title: 'رابط خبيث',
        kind: 'link',
        url: 'javascript:alert(1)',
      }),
    });
    expect(badUrl.status).toBe(400);

    await admin.json('/api/resources/materials', {
      method: 'POST',
      body: JSON.stringify({
        subjectId: subjId,
        sectionId: sec1,
        title: 'أول مضاف',
        kind: 'pdf',
        url: 'https://example.edu/1.pdf',
      }),
    });
    await admin.json('/api/resources/materials', {
      method: 'POST',
      body: JSON.stringify({
        subjectId: subjId,
        sectionId: sec1,
        title: 'ثاني مضاف (يظهر أولًا)',
        kind: 'pdf',
        url: 'https://example.edu/2.pdf',
      }),
    });
    const checkOrder = await member.json(`/api/resources/subjects/${subjId}`);
    expect(checkOrder.data.sections[0].materials[0].title).toBe('ثاني مضاف (يظهر أولًا)');

    // Cross-subject material search: empty query, exact Arabic match, wildcard escaping
    const emptySearch = await member.json('/api/resources/search?q=');
    expect(emptySearch.status).toBe(200);
    expect(emptySearch.data.results).toEqual([]);

    const matSearch = await member.json(`/api/resources/search?q=${encodeURIComponent('يظهر أولًا')}`);
    expect(matSearch.status).toBe(200);
    expect(matSearch.data.results).toHaveLength(1);
    expect(matSearch.data.results[0]).toMatchObject({
      title: 'ثاني مضاف (يظهر أولًا)',
      subjectId: subjId,
      subjectName: 'مادة اختبارية',
    });
    expect(typeof matSearch.data.results[0].sectionLabel).toBe('string');

    const wildcardSearch = await member.json(`/api/resources/search?q=${encodeURIComponent('%_notfound_%')}`);
    expect(wildcardSearch.status).toBe(200);
    expect(wildcardSearch.data.results).toEqual([]);

    // Non-empty section delete requires move or explicit cascade
    expect((await admin.json(`/api/resources/sections/${sec1}`, { method: 'DELETE' })).status).toBe(409);
    const moveDel = await admin.json(`/api/resources/sections/${sec1}`, {
      method: 'DELETE',
      body: JSON.stringify({ moveToSectionId: sec2 }),
    });
    expect(moveDel.status).toBe(200);
    const afterMove = await member.json(`/api/resources/subjects/${subjId}`);
    expect(afterMove.data.sections.find((s: any) => s.id === sec2).materials).toHaveLength(2);
  });

  it('E, F & G: History privacy isolation, chat 48h rule, Office/PDF/PNG validation, Arabic filenames, and rejecting fake files', async () => {
    const owner = new TestClient(baseUrl);
    const member = new TestClient(baseUrl);

    ctx.db
      .prepare(
        `INSERT INTO users (id, display_name, username, email, password_hash, role, approval_status, history_granted, bio, created_at, updated_at)
         VALUES ('usr_new', 'طالب جديد', 'new_student', 'new@example.invalid', ?, 'member', 'approved', 0, '', ?, ?)`
      )
      .run(hashPassword('NewPass123'), Date.now(), Date.now());

    await owner.json('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'owner_one', password: 'OwnerPass123' }),
    });
    await member.json('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'new_student', password: 'NewPass123' }),
    });

    // History isolation: newly approved member CANNOT see old message #1 via list, search, or reply
    const memMsgs = await member.json('/api/chat/messages?channel=general');
    expect(memMsgs.data.messages.some((m: any) => m.id === 1)).toBe(false);
    const memSearch = await member.json('/api/chat/search?channel=general&q=سرية');
    expect(memSearch.data.messages).toHaveLength(0);
    const memInfo = await member.json('/api/chat/messages/1/info');
    expect(memInfo.status).toBe(403);

    // Member requests history access and owner approves
    const hReq = await member.json('/api/members/history-request', { method: 'POST' });
    expect(hReq.status).toBe(201);
    const adminReqs = await owner.json('/api/admin/requests');
    const reqId = adminReqs.data.pendingHistory[0].id;
    await owner.json(`/api/admin/history-requests/${reqId}/decide`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approved' }),
    });
    const memMsgsAfter = await member.json('/api/chat/messages?channel=general');
    expect(memMsgsAfter.data.messages.some((m: any) => m.id === 1)).toBe(true);

    // Announcements restriction & idempotency
    expect(
      (
        await member.json('/api/chat/messages', {
          method: 'POST',
          body: JSON.stringify({ channel: 'announcements', body: 'تجربة' }),
        })
      ).status
    ).toBe(403);

    const idemKey = 'unique_key_1';
    await member.json('/api/chat/messages', {
      method: 'POST',
      body: JSON.stringify({ channel: 'general', body: 'رسالة واحدة', idempotencyKey: idemKey }),
    });
    await member.json('/api/chat/messages', {
      method: 'POST',
      body: JSON.stringify({ channel: 'general', body: 'رسالة واحدة', idempotencyKey: idemKey }),
    });
    const generalAfter = await member.json('/api/chat/messages?channel=general');
    expect(generalAfter.data.messages.filter((m: any) => m.body === 'رسالة واحدة')).toHaveLength(1);

    // 48h rule parity: non-owner cannot ordinary-DELETE own >48h message, while Owner CAN delete ANY >48h message for everyone
    const admin = new TestClient(baseUrl);
    await admin.json('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin_one', password: 'AdminPass123' }),
    });
    const oldAdminTs = Date.now() - 49 * 60 * 60 * 1000;
    ctx.db
      .prepare(
        `INSERT INTO messages (id, channel, sender_id, sender_name_snapshot, body, created_at)
         VALUES (99, 'general', 'usr_admin', 'المشرف الأول', 'رسالة قديمة للمشرف', ?)`
      )
      .run(oldAdminTs);

    const oldAdminSelfDel = await admin.json('/api/chat/messages/99', { method: 'DELETE' });
    expect(oldAdminSelfDel.status).toBe(403);

    const ownerOldDel = await owner.json('/api/chat/messages/99', { method: 'DELETE' });
    expect(ownerOldDel.status).toBe(200);
    expect(ownerOldDel.data.ok).toBe(true);

    // File validation: valid PPTX passes with exact OOXML MIME & Arabic filename; plain ZIP masquerading as PPTX rejected!
    const validPptx = makeMinimalZip([
      { name: '[Content_Types].xml', content: '<Types/>' },
      { name: 'ppt/presentation.xml', content: '<p:presentation/>' },
    ]);
    const fakeZip = makeMinimalZip([{ name: 'hello.txt', content: 'not office' }]);
    const exeBuf = Buffer.from('MZfake-executable');

    const fakeRes = await member.req('/api/assets/upload', {
      method: 'POST',
      headers: {
        'X-Rahhala-Purpose': 'chat_file',
        'X-Rahhala-Filename': encodeURIComponent('مزيف.pptx'),
        'Content-Type': 'application/octet-stream',
      },
      body: new Uint8Array(fakeZip),
    });
    expect(fakeRes.status).toBe(415);

    const exeRes = await member.req('/api/assets/upload', {
      method: 'POST',
      headers: {
        'X-Rahhala-Purpose': 'chat_file',
        'X-Rahhala-Filename': encodeURIComponent('bad.exe'),
        'Content-Type': 'application/octet-stream',
      },
      body: new Uint8Array(exeBuf),
    });
    expect(exeRes.status).toBe(415);

    const pptxUp = await member.json('/api/assets/upload', {
      method: 'POST',
      headers: {
        'X-Rahhala-Purpose': 'chat_file',
        'X-Rahhala-Filename': encodeURIComponent('محاضرة الأولى.pptx'),
        'Content-Type': 'application/octet-stream',
      },
      body: new Uint8Array(validPptx),
    });
    expect(pptxUp.status).toBe(201);
    expect(pptxUp.data.asset.mime).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    );

    // Bind asset to message and verify authenticated download bytes + Arabic Content-Disposition
    await member.json('/api/chat/messages', {
      method: 'POST',
      body: JSON.stringify({
        channel: 'general',
        body: 'ملف العرض',
        fileAssetId: pptxUp.data.asset.assetId,
      }),
    });

    const tokRes = await member.json(
      `/api/assets/${pptxUp.data.asset.assetId}/access-token`,
      { method: 'POST' }
    );
    expect(tokRes.status).toBe(200);
    const dlRes = await member.req(
      `/api/assets/${pptxUp.data.asset.assetId}/content?token=${encodeURIComponent(tokRes.data.token)}&download=1`
    );
    expect(dlRes.status).toBe(200);
    expect(dlRes.headers.get('content-type')).toContain(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    );
    expect(dlRes.headers.get('content-disposition')).toContain("filename*=UTF-8''");
    const dlBytes = Buffer.from(await dlRes.arrayBuffer());
    expect(dlBytes.equals(validPptx)).toBe(true);

    // PDF & PNG also succeed
    const pdfUp = await member.json('/api/assets/upload', {
      method: 'POST',
      headers: {
        'X-Rahhala-Purpose': 'chat_file',
        'X-Rahhala-Filename': encodeURIComponent('ملخص.pdf'),
        'Content-Type': 'application/octet-stream',
      },
      body: new Uint8Array(makeMinimalPdf()),
    });
    expect(pdfUp.status).toBe(201);
    expect(pdfUp.data.asset.mime).toBe('application/pdf');

    const pngUp = await member.json('/api/assets/upload', {
      method: 'POST',
      headers: {
        'X-Rahhala-Purpose': 'avatar',
        'X-Rahhala-Filename': encodeURIComponent('avatar.png'),
        'Content-Type': 'application/octet-stream',
      },
      body: new Uint8Array(makeMinimalPng()),
    });
    expect(pngUp.status).toBe(201);
  });

  it('H: Study reminders per-user CRUD, snooze, completion, and user isolation', async () => {
    const owner = new TestClient(baseUrl);
    const member = new TestClient(baseUrl);

    ctx.db
      .prepare(
        `INSERT INTO users (id, display_name, username, email, password_hash, role, approval_status, history_granted, bio, created_at, updated_at)
         VALUES ('usr_new', 'طالب جديد', 'new_student', 'new@example.invalid', ?, 'member', 'approved', 0, '', ?, ?)`
      )
      .run(hashPassword('NewPass123'), Date.now(), Date.now());

    await owner.json('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'owner_one', password: 'OwnerPass123' }),
    });
    await member.json('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'new_student', password: 'NewPass123' }),
    });

    const subjectsRes = await member.json('/api/resources/subjects');
    const firstSubjectId = subjectsRes.data.subjects[0].id;

    const createRes = await member.json('/api/reminders', {
      method: 'POST',
      body: JSON.stringify({
        subjectId: firstSubjectId,
        note: 'مراجعة المحاضرة الأولى',
        delayMinutes: 25,
      }),
    });
    expect(createRes.status).toBe(201);
    const remId = createRes.data.reminder.id;
    expect(createRes.data.reminder.status).toBe('active');
    expect(createRes.data.reminder.subjectId).toBe(firstSubjectId);
    expect(createRes.data.reminder.durationMinutes).toBe(25);

    // Other user cannot modify or delete member's reminder
    expect((await owner.json(`/api/reminders/${remId}`, { method: 'DELETE' })).status).toBe(404);
    expect(
      (
        await owner.json(`/api/reminders/${remId}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'completed' }),
        })
      ).status
    ).toBe(404);

    // Snooze & complete work for owner of reminder
    const snoozeRes = await member.json(`/api/reminders/${remId}`, {
      method: 'PATCH',
      body: JSON.stringify({ snoozeMinutes: 10 }),
    });
    expect(snoozeRes.status).toBe(200);
    expect(snoozeRes.data.reminder.status).toBe('active');

    const completeRes = await member.json(`/api/reminders/${remId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed' }),
    });
    expect(completeRes.status).toBe(200);
    expect(completeRes.data.reminder.status).toBe('completed');

    expect((await member.json(`/api/reminders/${remId}`, { method: 'DELETE' })).status).toBe(200);

    // Subject alert color & tone preferences (persisted per user + validation)
    const badPref = await member.json(`/api/reminders/preferences/${firstSubjectId}`, {
      method: 'PUT',
      body: JSON.stringify({ accentColor: 'not-a-hex', toneId: 'crystal' }),
    });
    expect(badPref.status).toBe(400);

    const savePref = await member.json(`/api/reminders/preferences/${firstSubjectId}`, {
      method: 'PUT',
      body: JSON.stringify({ accentColor: '#6aa7e8', toneId: 'crystal' }),
    });
    expect(savePref.status).toBe(200);
    expect(savePref.data.preference.accentColor).toBe('#6AA7E8');
    expect(savePref.data.preference.toneId).toBe('crystal');

    const memberPrefs = await member.json('/api/reminders/preferences');
    expect(memberPrefs.status).toBe(200);
    expect(memberPrefs.data.preferences).toHaveLength(1);

    // Isolated per user: owner does not see member's custom preference
    const ownerPrefs = await owner.json('/api/reminders/preferences');
    expect(ownerPrefs.data.preferences).toHaveLength(0);

    const delPref = await member.json(`/api/reminders/preferences/${firstSubjectId}`, {
      method: 'DELETE',
    });
    expect(delPref.status).toBe(200);
    expect((await member.json('/api/reminders/preferences')).data.preferences).toHaveLength(0);
  });

  it('I: Shared study challenges creation, peer progress tracking, completed reminder sync, and permissions', async () => {
    const owner = new TestClient(baseUrl);
    const member = new TestClient(baseUrl);

    ctx.db
      .prepare(
        `INSERT INTO users (id, display_name, username, email, password_hash, role, approval_status, history_granted, bio, created_at, updated_at)
         VALUES ('usr_chg', 'طالب تحدي', 'chg_student', 'chg@example.invalid', ?, 'member', 'approved', 0, '', ?, ?)`
      )
      .run(hashPassword('ChgPass123'), Date.now(), Date.now());

    await owner.json('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'owner_one', password: 'OwnerPass123' }),
    });
    await member.json('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'chg_student', password: 'ChgPass123' }),
    });

    const subjectsRes = await member.json('/api/resources/subjects');
    const firstSubjectId = subjectsRes.data.subjects[0].id;

    // Member creates a shared 5-hour study challenge
    const createRes = await member.json('/api/challenges', {
      method: 'POST',
      body: JSON.stringify({
        title: 'تحدي مراجعة الأصول',
        subjectId: firstSubjectId,
        targetHours: 5,
        durationDays: 7,
        description: 'مذاكرة جماعية لمدة خمس ساعات',
      }),
    });
    expect(createRes.status).toBe(201);
    const chgId = createRes.data.challenge.id;
    expect(createRes.data.challenge.joinedByMe).toBe(true);
    expect(createRes.data.challenge.targetMinutes).toBe(300);

    // Owner joins and logs 60 minutes, plus sees member's progress
    const joinRes = await owner.json(`/api/challenges/${chgId}/join`, { method: 'POST' });
    expect(joinRes.status).toBe(200);
    expect(joinRes.data.challenge.participantCount).toBe(2);

    const logRes = await owner.json(`/api/challenges/${chgId}/progress`, {
      method: 'POST',
      body: JSON.stringify({ addMinutes: 60 }),
    });
    expect(logRes.status).toBe(200);
    expect(logRes.data.challenge.myMinutes).toBe(60);

    // Member completes a 30-min reminder on the same subject -> auto-counted in challenge!
    const remCreate = await member.json('/api/reminders', {
      method: 'POST',
      body: JSON.stringify({
        subjectId: firstSubjectId,
        note: 'جلسة التحدي',
        delayMinutes: 30,
      }),
    });
    expect(remCreate.status).toBe(201);
    await member.json(`/api/reminders/${remCreate.data.reminder.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed' }),
    });

    const listAfterRem = await owner.json('/api/challenges');
    const updatedChg = listAfterRem.data.challenges.find((c: any) => c.id === chgId);
    const memberRow = updatedChg.participants.find((p: any) => p.username === 'chg_student');
    expect(memberRow.reminderMinutes).toBe(30);
    expect(memberRow.totalMinutes).toBe(30);

    // Leave and delete permissions
    const leaveRes = await owner.json(`/api/challenges/${chgId}/leave`, { method: 'POST' });
    expect(leaveRes.status).toBe(200);
    expect(leaveRes.data.challenge.participantCount).toBe(1);

    // Creator can delete own challenge
    expect((await member.json(`/api/challenges/${chgId}`, { method: 'DELETE' })).status).toBe(200);
  });

  it('J: Challenge activity logs API and Majalis rooms, chat, timer & WebSocket flow', async () => {
    const owner = new TestClient(baseUrl);
    const member = new TestClient(baseUrl);

    ctx.db
      .prepare(
        `INSERT INTO users (id, display_name, username, email, password_hash, role, approval_status, history_granted, bio, created_at, updated_at)
         VALUES ('usr_maj', 'طالب مجالس', 'maj_student', 'maj@example.invalid', ?, 'member', 'approved', 0, '', ?, ?)`
      )
      .run(hashPassword('MajPass123'), Date.now(), Date.now());

    await owner.json('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'owner_one', password: 'OwnerPass123' }),
    });
    await member.json('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'maj_student', password: 'MajPass123' }),
    });

    const subjectsRes = await member.json('/api/resources/subjects');
    const firstSubjectId = subjectsRes.data.subjects[0].id;

    // 1. Challenge progress writes to study_challenge_logs and is exposed by /api/challenges/activity
    const createChg = await member.json('/api/challenges', {
      method: 'POST',
      body: JSON.stringify({
        title: 'تحدي أوقات الذروة',
        subjectId: firstSubjectId,
        targetHours: 3,
        durationDays: 7,
      }),
    });
    expect(createChg.status).toBe(201);
    const chgId = createChg.data.challenge.id;

    const addProg = await member.json(`/api/challenges/${chgId}/progress`, {
      method: 'POST',
      body: JSON.stringify({ addMinutes: 45 }),
    });
    expect(addProg.status).toBe(200);

    const activityRes = await member.json('/api/challenges/activity?days=30');
    expect(activityRes.status).toBe(200);
    expect(activityRes.data.logs.length).toBeGreaterThanOrEqual(1);
    expect(activityRes.data.logs[0].minutes).toBe(45);
    expect(activityRes.data.logs[0].subjectId).toBe(firstSubjectId);

    // 2. Majalis rooms seeded & CRUD permissions
    const roomsRes = await member.json('/api/majalis/rooms');
    expect(roomsRes.status).toBe(200);
    expect(roomsRes.data.rooms.length).toBeGreaterThanOrEqual(3);
    const defaultRoomId = roomsRes.data.rooms[0].id;

    // Default room cannot be deleted even by owner
    expect((await owner.json(`/api/majalis/rooms/${defaultRoomId}`, { method: 'DELETE' })).status).toBe(400);

    // Member creates a custom Majalis room
    const newRoomRes = await member.json('/api/majalis/rooms', {
      method: 'POST',
      body: JSON.stringify({
        title: 'مجلس مراجعة الحديث',
        description: 'مراجعة جماعية هادئة',
        subjectId: firstSubjectId,
      }),
    });
    expect(newRoomRes.status).toBe(201);
    const customRoomId = newRoomRes.data.room.id;

    // 3. Majalis room chat persistence & group Pomodoro timer API
    const postMsg = await member.json(`/api/majalis/rooms/${customRoomId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: 'السلام عليكم، لنبدأ المراجعة' }),
    });
    expect(postMsg.status).toBe(201);
    expect(postMsg.data.message.body).toBe('السلام عليكم، لنبدأ المراجعة');

    const getMsgs = await owner.json(`/api/majalis/rooms/${customRoomId}/messages`);
    expect(getMsgs.status).toBe(200);
    expect(getMsgs.data.messages.some((m: any) => m.body === 'السلام عليكم، لنبدأ المراجعة')).toBe(true);

    const presetTimer = await member.json(`/api/majalis/rooms/${customRoomId}/timer`, {
      method: 'POST',
      body: JSON.stringify({ action: 'preset', phase: 'review' }),
    });
    expect(presetTimer.status).toBe(200);
    expect(presetTimer.data.timer.phase).toBe('review');
    expect(presetTimer.data.timer.durationMs).toBe(45 * 60 * 1000);

    const startTimer = await member.json(`/api/majalis/rooms/${customRoomId}/timer`, {
      method: 'POST',
      body: JSON.stringify({ action: 'start' }),
    });
    expect(startTimer.status).toBe(200);
    expect(startTimer.data.timer.running).toBe(true);

    // 4. Live WebSocket join as listener, peers snapshot, activeCount, and live WS chat/timer broadcast
    const ownerTicket = await owner.json('/api/auth/ws-ticket');
    const memberTicket = await member.json('/api/auth/ws-ticket');
    expect(ownerTicket.status).toBe(200);
    expect(memberTicket.status).toBe(200);
    const wsBase = baseUrl.replace('http://', 'ws://');

    const ownerWs = new WebSocket(`${wsBase}/ws?ticket=${encodeURIComponent(ownerTicket.data.ticket)}`);
    const memberWs = new WebSocket(`${wsBase}/ws?ticket=${encodeURIComponent(memberTicket.data.ticket)}`);

    const waitForMsg = (ws: WebSocket, predicate: (m: any) => boolean) =>
      new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WS timeout')), 3000);
        const handler = (raw: WebSocket.RawData) => {
          const parsed = JSON.parse(raw.toString());
          if (predicate(parsed)) {
            clearTimeout(timeout);
            ws.off('message', handler);
            resolve(parsed);
          }
        };
        ws.on('message', handler);
      });

    await Promise.all([
      waitForMsg(ownerWs, (m) => m.type === 'connected'),
      waitForMsg(memberWs, (m) => m.type === 'connected'),
    ]);

    const ownerPeersPromise = waitForMsg(ownerWs, (m) => m.type === 'majalis:peers');
    ownerWs.send(
      JSON.stringify({
        type: 'majalis:join',
        roomId: customRoomId,
        mode: 'listener',
        micMuted: true,
        camOff: true,
      })
    );
    const ownerPeers = await ownerPeersPromise;
    expect(ownerPeers.roomId).toBe(customRoomId);

    const ownerRoomStatePromise = waitForMsg(
      ownerWs,
      (m) => m.type === 'majalis:room_state' && m.roomId === customRoomId && m.participants.length === 2
    );
    const memberPeersPromise = waitForMsg(memberWs, (m) => m.type === 'majalis:peers');
    memberWs.send(
      JSON.stringify({
        type: 'majalis:join',
        roomId: customRoomId,
        mode: 'listener',
        micMuted: true,
        camOff: true,
      })
    );
    const [memberPeers, roomState] = await Promise.all([memberPeersPromise, ownerRoomStatePromise]);
    expect(memberPeers.peers).toHaveLength(1);
    expect(roomState.participants.every((p: any) => p.mode === 'listener')).toBe(true);

    // Room activeCount reflects both connected members
    const roomsAfterJoin = await member.json('/api/majalis/rooms');
    const activeCustomRoom = roomsAfterJoin.data.rooms.find((r: any) => r.id === customRoomId);
    expect(activeCustomRoom.activeCount).toBe(2);

    // WS room chat broadcast reaches peer
    const ownerChatPromise = waitForMsg(
      ownerWs,
      (m) => m.type === 'majalis:chat_message' && m.roomId === customRoomId
    );
    memberWs.send(
      JSON.stringify({
        type: 'majalis:chat',
        roomId: customRoomId,
        body: 'تم الدخول بوضع المستمع بنجاح',
      })
    );
    const broadcastedChat = await ownerChatPromise;
    expect(broadcastedChat.message.body).toBe('تم الدخول بوضع المستمع بنجاح');

    await Promise.all([
      new Promise<void>((resolve) => {
        ownerWs.once('close', () => resolve());
        ownerWs.close();
      }),
      new Promise<void>((resolve) => {
        memberWs.once('close', () => resolve());
        memberWs.close();
      }),
    ]);

    // Creator can delete own custom room
    expect((await member.json(`/api/majalis/rooms/${customRoomId}`, { method: 'DELETE' })).status).toBe(200);
  });

  it('K: BOM/padded PDF upload, WhatsApp chat & group settings, starred/pinned, mute, and Owner complete wipe', async () => {
    const owner = new TestClient(baseUrl);
    const admin = new TestClient(baseUrl);
    const member = new TestClient(baseUrl);

    ctx.db
      .prepare(
        `INSERT INTO users (id, display_name, username, email, password_hash, role, approval_status, history_granted, bio, created_at, updated_at)
         VALUES ('usr_wa', 'طالب واتساب', 'wa_student', 'wa@example.invalid', ?, 'member', 'approved', 1, '', ?, ?)`
      )
      .run(hashPassword('WaPass123'), Date.now(), Date.now());

    await owner.json('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'owner_one', password: 'OwnerPass123' }),
    });
    await admin.json('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin_one', password: 'AdminPass123' }),
    });
    await member.json('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'wa_student', password: 'WaPass123' }),
    });

    // 1. Real-world PDF with UTF-8 BOM + whitespace + >2KB trailing bytes before %%EOF succeeds; truncated PDF rejected
    const bomPdf = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf, 0x20, 0x0a]),
      Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n', 'ascii'),
      Buffer.alloc(4096, 0x20),
      Buffer.from('\n%%EOF\n', 'ascii'),
    ]);
    const pdfUp = await member.json('/api/assets/upload', {
      method: 'POST',
      headers: {
        'X-Rahhala-Purpose': 'chat_file',
        'X-Rahhala-Filename': encodeURIComponent('محاضرة_كاملة.pdf'),
        'Content-Type': 'application/octet-stream',
      },
      body: new Uint8Array(bomPdf),
    });
    expect(pdfUp.status).toBe(201);
    expect(pdfUp.data.asset.mime).toBe('application/pdf');

    const truncatedPdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj', 'ascii');
    const badPdf = await member.json('/api/assets/upload', {
      method: 'POST',
      headers: {
        'X-Rahhala-Purpose': 'chat_file',
        'X-Rahhala-Filename': encodeURIComponent('broken.pdf'),
        'Content-Type': 'application/octet-stream',
      },
      body: new Uint8Array(truncatedPdf),
    });
    expect(badPdf.status).toBe(415);

    // 2. Send a message with the PDF, star it, pin it, and check personal WhatsApp settings
    const sentPdfMsg = await member.json('/api/chat/messages', {
      method: 'POST',
      body: JSON.stringify({
        channel: 'general',
        body: 'ملخص PDF مهم',
        fileAssetId: pdfUp.data.asset.assetId,
      }),
    });
    expect(sentPdfMsg.status).toBe(201);
    const pdfMsgId = sentPdfMsg.data.message.id;

    // Personal chat settings update + readReceiptsEnabled toggle
    const updSettings = await member.json('/api/chat/settings/me', {
      method: 'PUT',
      body: JSON.stringify({
        wallpaper: 'islamic-geo',
        fontSize: 'large',
        enterToSend: false,
        readReceiptsEnabled: false,
        chatSoundsEnabled: false,
      }),
    });
    expect(updSettings.status).toBe(200);
    expect(updSettings.data.userSettings.wallpaper).toBe('islamic-geo');
    expect(updSettings.data.userSettings.readReceiptsEnabled).toBe(false);

    // Owner marks message read -> member has readReceiptsEnabled=false so sees 'delivered', not 'read'
    await owner.json('/api/chat/read', {
      method: 'POST',
      body: JSON.stringify({ channel: 'general', highestMessageId: pdfMsgId }),
    });
    const listWithPrivacy = await member.json('/api/chat/messages?channel=general');
    const fetchedOwnMsg = listWithPrivacy.data.messages.find((m: any) => m.id === pdfMsgId);
    expect(fetchedOwnMsg.receiptStatus).not.toBe('read');

    // Star & Pin
    expect((await member.json(`/api/chat/messages/${pdfMsgId}/star`, { method: 'POST' })).status).toBe(200);
    const starredList = await member.json('/api/chat/starred');
    expect(starredList.data.messages.some((m: any) => m.id === pdfMsgId)).toBe(true);

    const pinRes = await admin.json(`/api/chat/messages/${pdfMsgId}/pin`, { method: 'POST' });
    expect(pinRes.status).toBe(200);
    expect(pinRes.data.groupSettings.pinnedMessages.general.id).toBe(pdfMsgId);

    // Export chat transcript
    const expRes = await member.json('/api/chat/channels/general/export');
    expect(expRes.status).toBe(200);
    expect(expRes.data.text).toContain('ملخص PDF مهم');

    // 3. Group Settings permissions & enforcement
    const grpOwnerOnly = await owner.json('/api/chat/settings/group', {
      method: 'PATCH',
      body: JSON.stringify({
        groupName: 'مجموعة الدفعة الموثقة',
        editInfoPolicy: 'owner',
        allowReactions: false,
        allowMedia: false,
      }),
    });
    expect(grpOwnerOnly.status).toBe(200);
    expect(grpOwnerOnly.data.groupSettings.groupName).toBe('مجموعة الدفعة الموثقة');

    // Admin blocked from changing groupName when editInfoPolicy='owner'
    expect(
      (
        await admin.json('/api/chat/settings/group', {
          method: 'PATCH',
          body: JSON.stringify({ groupName: 'محاولة تغيير' }),
        })
      ).status
    ).toBe(403);

    // Reactions disabled for members
    expect(
      (
        await member.json(`/api/chat/messages/${pdfMsgId}/react`, {
          method: 'POST',
          body: JSON.stringify({ emoji: '👍' }),
        })
      ).status
    ).toBe(403);

    // 4. Member mute/unmute enforcement
    expect((await admin.json('/api/chat/members/usr_wa/mute', { method: 'POST', body: '{}' })).status).toBe(200);
    expect(
      (
        await member.json('/api/chat/messages', {
          method: 'POST',
          body: JSON.stringify({ channel: 'general', body: 'محاولة بعد الكتم' }),
        })
      ).status
    ).toBe(403);
    expect((await admin.json('/api/chat/members/usr_wa/mute', { method: 'DELETE' })).status).toBe(200);
    expect(
      (
        await member.json('/api/chat/messages', {
          method: 'POST',
          body: JSON.stringify({ channel: 'general', body: 'رسالة بعد فك الكتم' }),
        })
      ).status
    ).toBe(201);

    // 5. Clear channel for me only hides for caller, keeps for owner
    expect((await member.json('/api/chat/channels/general/clear-for-me', { method: 'POST' })).status).toBe(200);
    const memAfterClear = await member.json('/api/chat/messages?channel=general');
    expect(memAfterClear.data.messages).toHaveLength(0);
    const ownerBeforeWipe = await owner.json('/api/chat/messages?channel=general');
    expect(ownerBeforeWipe.data.messages.length).toBeGreaterThan(0);

    // 6. Owner-only Complete Wipe (non-owner blocked 403; owner wipes channel + all channels cleanly)
    expect((await admin.json('/api/chat/channels/general/wipe', { method: 'POST' })).status).toBe(403);
    expect((await member.json('/api/chat/wipe-all', { method: 'POST' })).status).toBe(403);

    const ownerTicket = await owner.json('/api/auth/ws-ticket');
    const wsBase = baseUrl.replace('http://', 'ws://');
    const ownerWs = new WebSocket(`${wsBase}/ws?ticket=${encodeURIComponent(ownerTicket.data.ticket)}`);
    const wipedEventPromise = new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WS wipe timeout')), 3000);
      ownerWs.on('message', (raw) => {
        const parsed = JSON.parse(raw.toString());
        if (parsed.type === 'chat:channel_wiped') {
          clearTimeout(t);
          resolve(parsed);
        }
      });
    });
    await new Promise<void>((resolve) => ownerWs.once('open', () => resolve()));

    const wipeChannelRes = await owner.json('/api/chat/channels/general/wipe', { method: 'POST' });
    expect(wipeChannelRes.status).toBe(200);
    const wipedEvt = await wipedEventPromise;
    expect(wipedEvt.channel).toBe('general');

    const ownerAfterWipe = await owner.json('/api/chat/messages?channel=general');
    expect(ownerAfterWipe.data.messages).toHaveLength(0);

    // Put a message in questions then wipe-all
    await owner.json('/api/chat/messages', {
      method: 'POST',
      body: JSON.stringify({ channel: 'questions', body: 'رسالة للمحو الشامل' }),
    });
    expect((await owner.json('/api/chat/wipe-all', { method: 'POST' })).status).toBe(200);
    const qAfterAll = await owner.json('/api/chat/messages?channel=questions');
    expect(qAfterAll.data.messages).toHaveLength(0);

    await new Promise<void>((resolve) => {
      ownerWs.once('close', () => resolve());
      ownerWs.close();
    });
  });

  it('L: Google Meet-style Majlis settings, knock/admit waiting queue, room lock, mute-all, kick, end-for-all, and ICE config', async () => {
    const owner = new TestClient(baseUrl);
    const member = new TestClient(baseUrl);
    const guest2 = new TestClient(baseUrl);

    ctx.db
      .prepare(
        `INSERT INTO users (id, display_name, username, email, password_hash, role, approval_status, history_granted, bio, created_at, updated_at)
         VALUES ('usr_gm1', 'طالب أول', 'gm_one', 'gm1@example.invalid', ?, 'member', 'approved', 0, '', ?, ?)`
      )
      .run(hashPassword('GmPass123'), Date.now(), Date.now());
    ctx.db
      .prepare(
        `INSERT INTO users (id, display_name, username, email, password_hash, role, approval_status, history_granted, bio, created_at, updated_at)
         VALUES ('usr_gm2', 'طالب ثان', 'gm_two', 'gm2@example.invalid', ?, 'member', 'approved', 0, '', ?, ?)`
      )
      .run(hashPassword('GmPass123'), Date.now(), Date.now());

    await owner.json('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'owner_one', password: 'OwnerPass123' }),
    });
    await member.json('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'gm_one', password: 'GmPass123' }),
    });
    await guest2.json('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'gm_two', password: 'GmPass123' }),
    });

    // 1. Admin configures defaultRoomAccessType & custom TURN ICE server in /api/admin/settings
    // Also verify invalid/non-URL meeting_provider_url never breaks builtin mode, and toggling external <-> builtin works cleanly
    ctx.db
      .prepare(
        "INSERT INTO app_settings (key, value, updated_at) VALUES ('meeting_provider_url', 'moazfawzy200-6', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(Date.now());
    const cfgWithInvalidUrl = await member.json('/api/config');
    expect(cfgWithInvalidUrl.data.meetingMode).toBe('builtin');
    expect(cfgWithInvalidUrl.data.meetingExternalUrl).toBe('');

    const setExt = await owner.json('/api/admin/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        meetingMode: 'external',
        meetingProviderUrl: 'https://meet.google.com/abc-defg-hij',
      }),
    });
    expect(setExt.status).toBe(200);
    expect((await member.json('/api/config')).data.meetingMode).toBe('external');

    const adminCfg = await owner.json('/api/admin/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        meetingMode: 'builtin',
        defaultRoomAccessType: 'knock',
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'turn:relay.example.org:3478', username: 'u1', credential: 'p1' },
        ],
      }),
    });
    expect(adminCfg.status).toBe(200);
    const pubCfg = await member.json('/api/config');
    expect(pubCfg.data.meetingMode).toBe('builtin');
    expect(pubCfg.data.meetingExternalUrl).toBe('');
    expect(pubCfg.data.defaultRoomAccessType).toBe('knock');
    expect(pubCfg.data.iceServers).toHaveLength(2);

    // 2. Owner creates a Google Meet-style room (knock mode, chat disabled for members, muteOnEntry)
    const createdRoom = await owner.json('/api/majalis/rooms', {
      method: 'POST',
      body: JSON.stringify({
        title: 'مجلس بضوابط جوجل ميت',
        accessType: 'knock',
        allowScreenShare: false,
        allowChat: false,
        muteOnEntry: true,
      }),
    });
    expect(createdRoom.status).toBe(201);
    const roomId = createdRoom.data.room.id;
    expect(createdRoom.data.room.settings.accessType).toBe('knock');
    expect(createdRoom.data.room.settings.allowChat).toBe(false);

    // Non-host cannot modify room settings
    expect(
      (
        await member.json(`/api/majalis/rooms/${roomId}/settings`, {
          method: 'PATCH',
          body: JSON.stringify({ allowChat: true }),
        })
      ).status
    ).toBe(403);

    // Non-host cannot chat while allowChat=false
    expect(
      (
        await member.json(`/api/majalis/rooms/${roomId}/messages`, {
          method: 'POST',
          body: JSON.stringify({ body: 'رسالة ممنوعة' }),
        })
      ).status
    ).toBe(403);

    // 3. Connect WS clients for owner, member, guest2
    const wsBase = baseUrl.replace('http://', 'ws://');
    const [tOwner, tMem, tG2] = await Promise.all([
      owner.json('/api/auth/ws-ticket'),
      member.json('/api/auth/ws-ticket'),
      guest2.json('/api/auth/ws-ticket'),
    ]);
    const ownerWs = new WebSocket(`${wsBase}/ws?ticket=${encodeURIComponent(tOwner.data.ticket)}`);
    const memWs = new WebSocket(`${wsBase}/ws?ticket=${encodeURIComponent(tMem.data.ticket)}`);
    const g2Ws = new WebSocket(`${wsBase}/ws?ticket=${encodeURIComponent(tG2.data.ticket)}`);

    const waitForMsg = (ws: WebSocket, predicate: (m: any) => boolean) =>
      new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WS timeout')), 3000);
        const handler = (raw: WebSocket.RawData) => {
          const parsed = JSON.parse(raw.toString());
          if (predicate(parsed)) {
            clearTimeout(timeout);
            ws.off('message', handler);
            resolve(parsed);
          }
        };
        ws.on('message', handler);
      });

    await Promise.all([
      waitForMsg(ownerWs, (m) => m.type === 'connected'),
      waitForMsg(memWs, (m) => m.type === 'connected'),
      waitForMsg(g2Ws, (m) => m.type === 'connected'),
    ]);

    // Owner joins host room directly without knocking
    const ownerPeersP = waitForMsg(ownerWs, (m) => m.type === 'majalis:peers');
    ownerWs.send(JSON.stringify({ type: 'majalis:join', roomId, mode: 'audio', micMuted: false, camOff: true }));
    await ownerPeersP;

    // Member knocks -> gets knock_pending & host gets knock_queue
    const memPendingP = waitForMsg(memWs, (m) => m.type === 'majalis:knock_pending' && m.roomId === roomId);
    const hostQueueP = waitForMsg(ownerWs, (m) => m.type === 'majalis:knock_queue' && m.queue.length === 1);
    memWs.send(JSON.stringify({ type: 'majalis:join', roomId, mode: 'audio', micMuted: false, camOff: true }));
    const [, queueEv] = await Promise.all([memPendingP, hostQueueP]);
    expect(queueEv.queue[0].userId).toBe('usr_gm1');

    // Host admits member -> member receives majalis:knock_admitted -> joins & gets muted on entry
    const memAdmittedP = waitForMsg(memWs, (m) => m.type === 'majalis:knock_admitted' && m.roomId === roomId);
    ownerWs.send(JSON.stringify({ type: 'majalis:knock_decide', roomId, targetUserId: 'usr_gm1', approve: true }));
    await memAdmittedP;

    const memPeersP = waitForMsg(memWs, (m) => m.type === 'majalis:peers' && m.roomId === roomId);
    memWs.send(JSON.stringify({ type: 'majalis:join', roomId, mode: 'audio', micMuted: false, camOff: true }));
    const memPeers = await memPeersP;
    expect(memPeers.enforcedMicMuted).toBe(true);

    // Lock room -> guest2 gets rejected with reason: 'locked'
    const lockRes = await owner.json(`/api/majalis/rooms/${roomId}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ roomLocked: true }),
    });
    expect(lockRes.status).toBe(200);
    expect(lockRes.data.settings.roomLocked).toBe(true);

    const g2RejectedP = waitForMsg(g2Ws, (m) => m.type === 'majalis:join_rejected' && m.reason === 'locked');
    g2Ws.send(JSON.stringify({ type: 'majalis:join', roomId, mode: 'listener' }));
    await g2RejectedP;

    // Host executes mute_all -> member receives majalis:force_mute
    const forceMuteP = waitForMsg(memWs, (m) => m.type === 'majalis:force_mute');
    ownerWs.send(JSON.stringify({ type: 'majalis:host_action', roomId, action: 'mute_all' }));
    await forceMuteP;

    // Host kicks member -> member receives majalis:kicked
    const kickedP = waitForMsg(memWs, (m) => m.type === 'majalis:kicked');
    ownerWs.send(JSON.stringify({ type: 'majalis:host_action', roomId, action: 'kick_user', targetUserId: 'usr_gm1' }));
    await kickedP;

    // End meeting for everyone endpoint works for host
    const ownerEndedP = waitForMsg(ownerWs, (m) => m.type === 'majalis:ended' && m.roomId === roomId);
    expect((await owner.json(`/api/majalis/rooms/${roomId}/end`, { method: 'POST' })).status).toBe(200);
    await ownerEndedP;

    await Promise.all([
      new Promise<void>((r) => { ownerWs.once('close', () => r()); ownerWs.close(); }),
      new Promise<void>((r) => { memWs.once('close', () => r()); memWs.close(); }),
      new Promise<void>((r) => { g2Ws.once('close', () => r()); g2Ws.close(); }),
    ]);
  });
});



