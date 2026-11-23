import express from 'express';
import http from 'node:http';
import { loadConfig, type RahhalaConfig } from './config.ts';
import { openDatabase, type RahhalaDb } from './db.ts';
import { csrfProtectionMiddleware } from './middleware/auth.ts';
import { createAdminRouter } from './routes/admin.ts';
import { createAssetsRouter } from './routes/assets.ts';
import { createAuthRouter } from './routes/auth.ts';
import { createChallengesRouter } from './routes/challenges.ts';
import { createChatRouter } from './routes/chat.ts';
import { createConversationsRouter } from './routes/conversations.ts';
import { createMajalisRouter } from './routes/majalis.ts';
import { createMembersRouter } from './routes/members.ts';
import { createRemindersRouter } from './routes/reminders.ts';
import { createResourcesRouter } from './routes/resources.ts';
import { seedInitialData } from './seed.ts';
import { setupWebSocketHub, type RealtimeHub } from './ws.ts';

export interface RahhalaServerContext {
  app: express.Express;
  httpServer: http.Server;
  db: RahhalaDb;
  config: RahhalaConfig;
  hub: RealtimeHub;
  close: () => Promise<void>;
}

export function createRahhalaApp(overrides?: Partial<RahhalaConfig>): RahhalaServerContext {
  const config = loadConfig(overrides);
  const db = openDatabase(config.dbPath);
  seedInitialData(db, config);

  const app = express();
  app.set('trust proxy', 1);

  const httpServer = http.createServer(app);
  const hub = setupWebSocketHub(httpServer, db, config);

  // Raw asset upload route must come BEFORE express.json so binary payloads stay unparsed
  app.use('/api', csrfProtectionMiddleware);
  app.use('/api', createAssetsRouter(db, config));

  app.use('/api', express.json({ limit: '512kb' }));
  app.use('/api', createAuthRouter(db, config, hub));
  app.use('/api', createResourcesRouter(db, config));
  app.use('/api', createChatRouter(db, config, hub));
  app.use('/api', createConversationsRouter(db, config, hub));
  app.use('/api', createMembersRouter(db, config));
  app.use('/api', createRemindersRouter(db, config, hub));
  app.use('/api', createChallengesRouter(db, config, hub));
  app.use('/api', createMajalisRouter(db, config, hub));
  app.use('/api', createAdminRouter(db, config, hub));

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'نقطة الاتصال غير موجودة' });
  });

  // Safe error handler without leaking internal stack traces
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      const status =
        typeof err === 'object' && err !== null && 'status' in err
          ? Number((err as { status: number }).status) || 500
          : 500;
      if (status === 413) {
        res.status(413).json({ error: 'حجم البيانات يتجاوز الحد المسموح به' });
        return;
      }
      res.status(status >= 400 && status < 600 ? status : 500).json({
        error: 'حدث خطأ غير متوقع أثناء معالجة الطلب',
      });
    }
  );

  async function close(): Promise<void> {
    hub.close();
    await new Promise<void>((resolve) => {
      if (httpServer.listening) {
        httpServer.close(() => resolve());
      } else {
        resolve();
      }
    });
    db.close();
  }

  return { app, httpServer, db, config, hub, close };
}
