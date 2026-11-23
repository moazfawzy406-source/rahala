import crypto from 'node:crypto';
import type { RahhalaConfig } from './config.ts';
import { getSetting, setSetting, type RahhalaDb } from './db.ts';
import { hashPassword } from './lib/crypto.ts';
import { isSafeHttpUrl } from './lib/validation.ts';

export function seedInitialData(db: RahhalaDb, config: RahhalaConfig): void {
  const existingSubtitle = getSetting(db, 'institution_subtitle', '');
  if (!existingSubtitle) {
    setSetting(db, 'institution_subtitle', config.institutionSubtitle);
  }
  if (!getSetting(db, 'chat_locked', '')) {
    setSetting(db, 'chat_locked', 'false');
  }
  const storedMeetingUrl = getSetting(db, 'meeting_provider_url', '').trim();
  if (storedMeetingUrl && !isSafeHttpUrl(storedMeetingUrl)) {
    setSetting(db, 'meeting_provider_url', '');
  } else if (config.meetingProviderUrl && isSafeHttpUrl(config.meetingProviderUrl) && !storedMeetingUrl) {
    setSetting(db, 'meeting_provider_url', config.meetingProviderUrl);
  }

  // Seed fictional academic subjects if empty
  const subjectCount = (db.prepare('SELECT COUNT(*) AS cnt FROM subjects').get() as { cnt: number }).cnt;
  if (subjectCount === 0) {
    const now = Date.now();
    const tx = db.transaction(() => {
      const subjects = [
        { id: 'subj_fiqh', name: 'أصول الفقه', color: '#E3B23C', icon: 'book-open', order: 1 },
        { id: 'subj_balagha', name: 'البلاغة العربية', color: '#5FBF8F', icon: 'feather', order: 2 },
        { id: 'subj_hadith', name: 'الحديث وعلومه', color: '#6AA7E8', icon: 'scroll', order: 3 },
        { id: 'subj_history', name: 'تاريخ التشريع', color: '#D9825B', icon: 'landmark', order: 4 },
      ];

      const insertSubj = db.prepare(
        'INSERT INTO subjects (id, name, accent_color, icon_name, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      );
      const insertSec = db.prepare(
        'INSERT INTO sections (id, subject_id, label, sort_order) VALUES (?, ?, ?, ?)'
      );
      const insertMat = db.prepare(
        `INSERT INTO materials (id, subject_id, section_id, title, kind, url, note, creator_id, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
      );

      for (const s of subjects) {
        insertSubj.run(s.id, s.name, s.color, s.icon, s.order, now);
        const secSummaries = `${s.id}_summaries`;
        const secLectures = `${s.id}_lectures`;
        const secSources = `${s.id}_sources`;
        insertSec.run(secSummaries, s.id, 'ملخصات', 1);
        insertSec.run(secLectures, s.id, 'محاضرات', 2);
        insertSec.run(secSources, s.id, 'مصادر', 3);

        insertMat.run(
          `${s.id}_m1`,
          s.id,
          secSummaries,
          `ملخص تمهيدي في ${s.name}`,
          'pdf',
          'https://example.edu/rahhala-demo/summary.pdf',
          'ملخص تجريبي لأغراض المعاينة فقط',
          1,
          now,
          now
        );
        insertMat.run(
          `${s.id}_m2`,
          s.id,
          secLectures,
          `تسجيل المحاضرة الأولى — ${s.name}`,
          'video',
          'https://example.edu/rahhala-demo/lecture-1',
          'محاضرة تجريبية منظمة حسب المنهج',
          1,
          now,
          now
        );
        insertMat.run(
          `${s.id}_m3`,
          s.id,
          secSources,
          `مرجع القراءة الأساسي — ${s.name}`,
          'drive',
          'https://example.edu/rahhala-demo/reference',
          '',
          1,
          now,
          now
        );
      }
    });
    tx();
  }

  // Only in non-production preview mode when no users exist yet: seed fictional demo accounts
  // Passwords are generated randomly at runtime (never hardcoded in source).
  if (config.previewDemoEnabled) {
    const userCount = (db.prepare('SELECT COUNT(*) AS cnt FROM users').get() as { cnt: number }).cnt;
    if (userCount === 0) {
      const now = Date.now();
      const olderTime = now - 7 * 24 * 60 * 60 * 1000;
      const memberJoinTime = now - 2 * 60 * 60 * 1000;

      const randomDemoPass = () => crypto.randomBytes(16).toString('base64url');

      const ownerId = 'usr_demo_owner';
      const adminId = 'usr_demo_admin';
      const memberId = 'usr_demo_member';
      const pendingId = 'usr_demo_pending';

      const tx = db.transaction(() => {
        const insUser = db.prepare(
          `INSERT INTO users (id, display_name, username, email, password_hash, role, approval_status, history_granted, bio, avatar_asset_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
        );

        insUser.run(
          ownerId,
          'طارق المنصور (تجريبي)',
          'tareq.owner',
          'owner.demo@example.invalid',
          hashPassword(randomDemoPass()),
          'owner',
          'approved',
          1,
          'منسق الدفعة — حساب تجريبي للمعاينة المحلية',
          olderTime,
          olderTime
        );

        insUser.run(
          adminId,
          'سلمى الحسيني (تجريبي)',
          'salma.admin',
          'admin.demo@example.invalid',
          hashPassword(randomDemoPass()),
          'admin',
          'approved',
          1,
          'مشرفة المواد والملخصات — حساب تجريبي',
          olderTime,
          olderTime
        );

        insUser.run(
          memberId,
          'يوسف عادل (تجريبي)',
          'youssef.member',
          'member.demo@example.invalid',
          hashPassword(randomDemoPass()),
          'member',
          'approved',
          0,
          'طالب بالدفعة — حساب تجريبي (بدون أرشيف قديم افتراضيًا)',
          memberJoinTime,
          memberJoinTime
        );

        insUser.run(
          pendingId,
          'ليلى كريم (بانتظار الموافقة)',
          'layla.pending',
          'pending.demo@example.invalid',
          hashPassword(randomDemoPass()),
          'member',
          'pending',
          0,
          '',
          now - 30 * 60 * 1000,
          now - 30 * 60 * 1000
        );

        const insMsg = db.prepare(
          `INSERT INTO messages (channel, sender_id, sender_name_snapshot, body, reply_to_id, created_at)
           VALUES (?, ?, ?, ?, NULL, ?)`
        );

        // Historical messages before memberJoinTime (only visible to admins/owner or after history approval)
        insMsg.run(
          'announcements',
          ownerId,
          'طارق المنصور (تجريبي)',
          'أهلًا بكم في منصة رَحّالَة (رسالة أرشيفية قديمة للمعاينة قبل انضمام العضو الجديد).',
          olderTime + 60_000
        );
        insMsg.run(
          'general',
          adminId,
          'سلمى الحسيني (تجريبي)',
          'تم رفع روابط المحاضرات التمهيدية في قسم أصول الفقه — رسالة من الأسبوع الماضي.',
          olderTime + 120_000
        );

        // Recent messages after memberJoinTime (visible to newly approved member)
        insMsg.run(
          'announcements',
          ownerId,
          'طارق المنصور (تجريبي)',
          'تذكير: موعد مجلس المذاكرة الجماعي اليوم الساعة الثامنة مساءً في تبويب مجالس.',
          now - 45 * 60 * 1000
        );
        insMsg.run(
          'questions',
          adminId,
          'سلمى الحسيني (تجريبي)',
          'لو عندك أي سؤال في البلاغة العربية اكتبه هنا وسنتابع الردود معًا.',
          now - 20 * 60 * 1000
        );
        insMsg.run(
          'general',
          memberId,
          'يوسف عادل (تجريبي)',
          'السلام عليكم، شكرًا على تنظيم الملخصات في مكان واحد!',
          now - 10 * 60 * 1000
        );
      });
      tx();
    }

    // Seed sample study reminders for demo accounts across a 30-day window
    const demoUsers = ['usr_demo_owner', 'usr_demo_admin', 'usr_demo_member'].filter((uid) =>
      Boolean(db.prepare('SELECT 1 FROM users WHERE id = ?').get(uid))
    );
    if (demoUsers.length > 0) {
      const reminderCount = (
        db.prepare('SELECT COUNT(*) AS cnt FROM study_reminders').get() as { cnt: number }
      ).cnt;
      const needsMonthlyBackfill =
        reminderCount > 0 &&
        !db
          .prepare('SELECT 1 FROM study_reminders WHERE id = ?')
          .get('rem_demo_usr_demo_member_9');

      if (reminderCount === 0 || needsMonthlyBackfill) {
        const now = Date.now();
        const insRem = db.prepare(
          `INSERT OR IGNORE INTO study_reminders (id, user_id, subject_id, subject_name_snapshot, note, remind_at, duration_minutes, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        const samples = [
          // Recent 7-day window (Weekly + Monthly)
          { subId: 'subj_fiqh', subName: 'أصول الفقه', note: 'مراجعة مباحث الحكم الشرعي', mins: 45, status: 'completed', offset: -2 * 86_400_000 },
          { subId: 'subj_fiqh', subName: 'أصول الفقه', note: 'تلخيص القياس والاجتهاد', mins: 30, status: 'completed', offset: -1 * 86_400_000 },
          { subId: 'subj_fiqh', subName: 'أصول الفقه', note: 'حل أسئلة المراجعة', mins: 25, status: 'active', offset: 90 * 60_000 },
          { subId: 'subj_balagha', subName: 'البلاغة العربية', note: 'تطبيقات علم البيان والتشبيه', mins: 40, status: 'completed', offset: -36 * 3_600_000 },
          { subId: 'subj_balagha', subName: 'البلاغة العربية', note: 'قراءة الاستعارة المكنية', mins: 20, status: 'active', offset: 3 * 3_600_000 },
          { subId: 'subj_hadith', subName: 'الحديث وعلومه', note: 'مراجعة مصطلح الحديث', mins: 50, status: 'completed', offset: -3 * 86_400_000 },
          { subId: 'subj_hadith', subName: 'الحديث وعلومه', note: 'حفظ أسانيد الباب الأول', mins: 25, status: 'completed', offset: -18 * 3_600_000 },
          { subId: 'subj_history', subName: 'تاريخ التشريع', note: 'قراءة فصل المدارس الفقهية', mins: 35, status: 'completed', offset: -4 * 86_400_000 },
          { subId: 'subj_history', subName: 'تاريخ التشريع', note: 'مراجعة عصر التدوين', mins: 25, status: 'active', offset: 6 * 3_600_000 },
          // Earlier weeks inside 30-day window (Monthly long-term habits)
          { subId: 'subj_fiqh', subName: 'أصول الفقه', note: 'مدخل علم الأصول ومصادره', mins: 50, status: 'completed', offset: -9 * 86_400_000 },
          { subId: 'subj_balagha', subName: 'البلاغة العربية', note: 'مقدمة علم المعاني والخبر والإنشاء', mins: 45, status: 'completed', offset: -11 * 86_400_000 },
          { subId: 'subj_hadith', subName: 'الحديث وعلومه', note: 'دراسة الصحيح والحسن والضعيف', mins: 40, status: 'completed', offset: -14 * 86_400_000 },
          { subId: 'subj_history', subName: 'تاريخ التشريع', note: 'التشريع في عهد الخلفاء الراشدين', mins: 35, status: 'completed', offset: -16 * 86_400_000 },
          { subId: 'subj_fiqh', subName: 'أصول الفقه', note: 'مباحث الأمر والنهي والعام والخاص', mins: 60, status: 'completed', offset: -20 * 86_400_000 },
          { subId: 'subj_balagha', subName: 'البلاغة العربية', note: 'المحسنات البديعية اللفظية والمعنوية', mins: 30, status: 'completed', offset: -22 * 86_400_000 },
          { subId: 'subj_hadith', subName: 'الحديث وعلومه', note: 'تخريج الأحاديث ومناهج المحدثين', mins: 45, status: 'completed', offset: -25 * 86_400_000 },
          { subId: 'subj_history', subName: 'تاريخ التشريع', note: 'أسباب اختلاف الفقهاء وتدوين السنة', mins: 40, status: 'completed', offset: -27 * 86_400_000 },
        ] as const;

        const dayHourAt = (daysAgo: number, hour: number, minute = 0) => {
          const d = new Date(now - daysAgo * 86_400_000);
          d.setHours(hour, minute, 0, 0);
          return Math.min(now - 120_000, d.getTime());
        };

        const txRem = db.transaction(() => {
          const completedHours = [8, 20, 17, 21, 9, 20, 22, 19, 10, 21, 8, 20, 18, 21];
          for (const uid of demoUsers) {
            samples.forEach((item, idx) => {
              const target =
                item.status === 'completed'
                  ? dayHourAt(Math.max(1, Math.round(Math.abs(item.offset) / 86_400_000)), completedHours[idx % completedHours.length], (idx * 11) % 50)
                  : now + item.offset;
              const created = Math.min(now - 60_000, target - item.mins * 60_000);
              const updated = item.status === 'completed' ? target : now;
              insRem.run(
                `rem_demo_${uid}_${idx}`,
                uid,
                item.subId,
                item.subName,
                item.note,
                target,
                item.mins,
                item.status,
                created,
                updated
              );
            });
          }
        });
        txRem();
      }

      const challengeCount = (
        db.prepare('SELECT COUNT(*) AS cnt FROM study_challenges').get() as { cnt: number }
      ).cnt;
      if (challengeCount === 0) {
        const now = Date.now();
        const insChallenge = db.prepare(
          `INSERT INTO study_challenges (
             id, creator_id, creator_name_snapshot, subject_id, subject_name_snapshot,
             title, description, target_minutes, ends_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        const insPart = db.prepare(
          `INSERT OR IGNORE INTO study_challenge_participants (challenge_id, user_id, logged_minutes, joined_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`
        );

        const txChg = db.transaction(() => {
          insChallenge.run(
            'chg_demo_fiqh_marathon',
            'usr_demo_owner',
            'طارق المنصور (تجريبي)',
            'subj_fiqh',
            'أصول الفقه',
            'ماراثون أصول الفقه الأسبوعي',
            'هدفنا إنجاز ٦ ساعات مركزة في مباحث الحكم والقياس قبل الاختبار التجريبي.',
            360,
            now + 6 * 86_400_000,
            now - 3 * 86_400_000,
            now - 30 * 60_000
          );
          insPart.run('chg_demo_fiqh_marathon', 'usr_demo_owner', 255, now - 3 * 86_400_000, now - 2 * 3_600_000);
          insPart.run('chg_demo_fiqh_marathon', 'usr_demo_admin', 195, now - 2 * 86_400_000, now - 3 * 3_600_000);
          insPart.run('chg_demo_fiqh_marathon', 'usr_demo_member', 135, now - 2 * 86_400_000, now - 45 * 60_000);

          insChallenge.run(
            'chg_demo_balagha_sprint',
            'usr_demo_admin',
            'سلمى الحسيني (تجريبي)',
            'subj_balagha',
            'البلاغة العربية',
            'تحدي تطبيقات البيان والبديع',
            'تطبيقات يومية على التشبيه والاستعارة لإتمام ٤ ساعات مذاكرة جماعية.',
            240,
            now + 9 * 86_400_000,
            now - 2 * 86_400_000,
            now - 60 * 60_000
          );
          insPart.run('chg_demo_balagha_sprint', 'usr_demo_admin', 165, now - 2 * 86_400_000, now - 60 * 60_000);
          insPart.run('chg_demo_balagha_sprint', 'usr_demo_member', 90, now - 86_400_000, now - 2 * 3_600_000);
        });
        txChg();
      }

      // Backfill chronological challenge session logs across realistic peak study hours
      const chgLogsCount = (
        db.prepare('SELECT COUNT(*) AS cnt FROM study_challenge_logs').get() as { cnt: number }
      ).cnt;
      if (chgLogsCount === 0) {
        const now = Date.now();
        const atHour = (daysAgo: number, hour: number, minute: number) => {
          const d = new Date(now - daysAgo * 86_400_000);
          d.setHours(hour, minute, 0, 0);
          return Math.min(now - 60_000, d.getTime());
        };
        const insLog = db.prepare(
          `INSERT OR IGNORE INTO study_challenge_logs (
             id, challenge_id, user_id, subject_id, subject_name_snapshot, challenge_title_snapshot, minutes, logged_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );
        const logPlan = [
          { chgId: 'chg_demo_fiqh_marathon', subId: 'subj_fiqh', subName: 'أصول الفقه', title: 'ماراثون أصول الفقه الأسبوعي', mins: 45, daysAgo: 1, hour: 20, min: 15 },
          { chgId: 'chg_demo_fiqh_marathon', subId: 'subj_fiqh', subName: 'أصول الفقه', title: 'ماراثون أصول الفقه الأسبوعي', mins: 60, daysAgo: 2, hour: 21, min: 10 },
          { chgId: 'chg_demo_fiqh_marathon', subId: 'subj_fiqh', subName: 'أصول الفقه', title: 'ماراثون أصول الفقه الأسبوعي', mins: 30, daysAgo: 3, hour: 9, min: 30 },
          { chgId: 'chg_demo_balagha_sprint', subId: 'subj_balagha', subName: 'البلاغة العربية', title: 'تحدي تطبيقات البيان والبديع', mins: 45, daysAgo: 1, hour: 19, min: 20 },
          { chgId: 'chg_demo_balagha_sprint', subId: 'subj_balagha', subName: 'البلاغة العربية', title: 'تحدي تطبيقات البيان والبديع', mins: 45, daysAgo: 4, hour: 20, min: 45 },
          { chgId: 'chg_demo_fiqh_marathon', subId: 'subj_fiqh', subName: 'أصول الفقه', title: 'ماراثون أصول الفقه الأسبوعي', mins: 50, daysAgo: 10, hour: 21, min: 0 },
          { chgId: 'chg_demo_balagha_sprint', subId: 'subj_balagha', subName: 'البلاغة العربية', title: 'تحدي تطبيقات البيان والبديع', mins: 40, daysAgo: 15, hour: 17, min: 30 },
        ];
        const txLogs = db.transaction(() => {
          for (const uid of demoUsers) {
            logPlan.forEach((lp, idx) => {
              const chgExists = db.prepare('SELECT 1 FROM study_challenges WHERE id = ?').get(lp.chgId);
              if (!chgExists) return;
              insLog.run(
                `chglog_demo_${uid}_${idx}`,
                lp.chgId,
                uid,
                lp.subId,
                lp.subName,
                lp.title,
                lp.mins,
                atHour(lp.daysAgo, lp.hour, lp.min)
              );
            });
          }
        });
        txLogs();
      }
    }
  }

  // Always ensure default Majalis study rooms exist
  const majalisRoomsCount = (
    db.prepare('SELECT COUNT(*) AS cnt FROM majalis_rooms').get() as { cnt: number }
  ).cnt;
  if (majalisRoomsCount === 0) {
    const now = Date.now();
    const hasFiqh = Boolean(db.prepare('SELECT 1 FROM subjects WHERE id = ?').get('subj_fiqh'));
    const hasBalagha = Boolean(db.prepare('SELECT 1 FROM subjects WHERE id = ?').get('subj_balagha'));
    const insRoom = db.prepare(
      `INSERT OR IGNORE INTO majalis_rooms (
         id, title, subject_id, subject_name_snapshot, creator_id, creator_name_snapshot, is_default, created_at
       ) VALUES (?, ?, ?, ?, NULL, ?, 1, ?)`
    );
    const txRooms = db.transaction(() => {
      insRoom.run('room_general_hall', 'المجلس العام للمذاكرة', null, 'مذاكرة جماعية', 'إدارة رَحّالَة', now);
      insRoom.run('room_silent_focus', 'قاعة التركيز الهادئة', hasFiqh ? 'subj_fiqh' : null, hasFiqh ? 'أصول الفقه' : 'تركيز صامت', 'إدارة رَحّالَة', now + 1);
      insRoom.run('room_qa_study', 'حلقة المراجعة والأسئلة', hasBalagha ? 'subj_balagha' : null, hasBalagha ? 'البلاغة العربية' : 'مراجعة عامة', 'إدارة رَحّالَة', now + 2);
    });
    txRooms();
  }

  if (config.previewDemoEnabled) {
    const majalisMsgCount = (
      db.prepare('SELECT COUNT(*) AS cnt FROM majalis_messages').get() as { cnt: number }
    ).cnt;
    if (majalisMsgCount === 0 && db.prepare('SELECT 1 FROM users WHERE id = ?').get('usr_demo_owner')) {
      const now = Date.now();
      db.prepare(
        `INSERT INTO majalis_messages (id, room_id, user_id, sender_name_snapshot, avatar_asset_id, body, created_at)
         VALUES (?, 'room_general_hall', 'usr_demo_owner', 'طارق المنصور (تجريبي)', NULL, ?, ?)`
      ).run('mmsg_welcome_1', 'أهلاً بكم في مجلس المذاكرة! يمكنكم تشغيل المؤقت الجماعي أو المشاركة صوتياً أو بوضع المستمع.', now - 15 * 60_000);
    }
  }
}
