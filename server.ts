import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import type {
  TelegramBotInfo,
  TelegramChatSummary,
  TelegramPdfItem,
} from './src/types.ts';

dotenv.config();

interface FirebaseConfig {
  apiKey?: string;
  projectId?: string;
  firestoreDatabaseId?: string;
}

const PRIMARY_ADMIN_EMAIL = 'linhteteducation@gmail.com';

const firebaseConfigPath = path.resolve('firebase-applet-config.json');
let firebaseConfig: FirebaseConfig = {};
if (fs.existsSync(firebaseConfigPath)) {
  firebaseConfig = JSON.parse(fs.readFileSync(firebaseConfigPath, 'utf8')) as FirebaseConfig;
}

interface AuthUser {
  uid: string;
  email: string;
  emailVerified: boolean;
  isAdmin: boolean;
  idToken: string;
}

interface AuthenticatedRequest extends Request {
  authUser?: AuthUser;
}

interface BotSession {
  token: string;
  source: 'env' | 'shared' | 'session';
  botInfo: TelegramBotInfo;
  offset: number;
  inbox: TelegramPdfItem[];
  chats: Map<number, TelegramChatSummary>;
  lastSyncedAt: string | null;
}

interface TelegramRawFile {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramRawMessage {
  message_id: number;
  date: number;
  caption?: string;
  chat: {
    id: number;
    title?: string;
    username?: string;
    first_name?: string;
    last_name?: string;
    type: string;
  };
  from?: {
    id: number;
    first_name?: string;
    last_name?: string;
    username?: string;
  };
  sender_chat?: {
    id: number;
    title?: string;
    username?: string;
  };
  document?: TelegramRawFile;
}

interface TelegramRawUpdate {
  update_id: number;
  message?: TelegramRawMessage;
  edited_message?: TelegramRawMessage;
  channel_post?: TelegramRawMessage;
  edited_channel_post?: TelegramRawMessage;
}

const verifiedTokenCache = new Map<
  string,
  { user: Omit<AuthUser, 'idToken'>; expiresAt: number }
>();
const userBotSessions = new Map<string, BotSession>();
let sharedBotSession: BotSession | null = null;
let envBotSession: BotSession | null = null;

const TOKEN_FORMAT_REGEX = /^\d{5,15}:[A-Za-z0-9_-]{20,100}$/;
const TELEGRAM_ID_REGEX = /^[A-Za-z0-9_-]{5,256}$/;
const DRIVE_ID_REGEX = /^[A-Za-z0-9_-]{3,128}$/;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function sha256Email(email: string): string {
  return crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\r\n\0/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  const base = cleaned || 'telegram_document.pdf';
  return base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`;
}

function formatChatTitle(chat: TelegramRawMessage['chat']): string {
  if (chat.title) return chat.title;
  const fullName = [chat.first_name, chat.last_name].filter(Boolean).join(' ').trim();
  if (fullName) return fullName;
  if (chat.username) return `@${chat.username}`;
  return `Chat ${chat.id}`;
}

function formatSenderName(msg: TelegramRawMessage): string {
  if (msg.from) {
    const full = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ').trim();
    if (full && msg.from.username) return `${full} (@${msg.from.username})`;
    if (full) return full;
    if (msg.from.username) return `@${msg.from.username}`;
  }
  if (msg.sender_chat?.title) return msg.sender_chat.title;
  return formatChatTitle(msg.chat);
}

function isPdfDocument(doc: TelegramRawFile | undefined): doc is TelegramRawFile {
  if (!doc || !doc.file_id || !doc.file_unique_id) return false;
  const mime = (doc.mime_type || '').toLowerCase();
  const name = (doc.file_name || '').toLowerCase();
  return mime === 'application/pdf' || name.endsWith('.pdf');
}

async function telegramApiCall<T>(
  botToken: string,
  method: string,
  params?: Record<string, string | number | boolean>
): Promise<{ ok: boolean; result?: T; description?: string; error_code?: number }> {
  const url = new URL(`https://api.telegram.org/bot${botToken}/${method}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), { method: 'GET' });
  const data = (await res.json()) as {
    ok: boolean;
    result?: T;
    description?: string;
    error_code?: number;
  };
  return data;
}

async function verifyFirebaseIdToken(idToken: string): Promise<AuthUser | null> {
  if (!idToken || !firebaseConfig.apiKey) return null;
  const cacheKey = hashToken(idToken);
  const cached = verifiedTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.user, idToken };
  }

  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseConfig.apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    }
  );
  if (!res.ok) return null;

  const data = (await res.json()) as {
    users?: Array<{ localId?: string; email?: string; emailVerified?: boolean }>;
  };
  const account = data.users?.[0];
  if (!account?.localId) return null;

  const email = (account.email || '').trim().toLowerCase();
  const emailVerified = Boolean(account.emailVerified);
  const userBase = {
    uid: account.localId,
    email,
    emailVerified,
    isAdmin: emailVerified && email === PRIMARY_ADMIN_EMAIL,
  };
  verifiedTokenCache.set(cacheKey, { user: userBase, expiresAt: Date.now() + 60_000 });
  return { ...userBase, idToken };
}

async function readFirestoreDocStatus(
  collectionPath: string,
  docId: string,
  idToken: string
): Promise<string | null> {
  if (!firebaseConfig.projectId) return null;
  const dbId = firebaseConfig.firestoreDatabaseId || '(default)';
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
    firebaseConfig.projectId
  )}/databases/${encodeURIComponent(dbId)}/documents/${collectionPath}/${encodeURIComponent(
    docId
  )}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!res.ok) return null;

  const json = (await res.json()) as {
    fields?: { status?: { stringValue?: string } };
  };
  return json.fields?.status?.stringValue || null;
}

async function isCallerApproved(user: AuthUser): Promise<boolean> {
  if (!user.emailVerified) return false;
  if (user.isAdmin) return true;

  const [accessStatus, allowlistStatus] = await Promise.all([
    readFirestoreDocStatus('userAccess', user.uid, user.idToken),
    user.email
      ? readFirestoreDocStatus('allowedEmails', sha256Email(user.email), user.idToken)
      : Promise.resolve(null),
  ]);

  if (accessStatus === 'revoked' || allowlistStatus === 'revoked') {
    return false;
  }
  return accessStatus === 'approved' || allowlistStatus === 'approved';
}

async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const idToken = req.header('x-firebase-id-token') || '';
    const user = await verifyFirebaseIdToken(idToken);
    if (!user) {
      res.status(401).json({ error: 'Authentication required. Please sign in with Google.' });
      return;
    }
    const approved = await isCallerApproved(user);
    if (!approved) {
      res.status(403).json({
        error: 'Your email address has not been approved by an administrator yet.',
        code: 'APPROVAL_REQUIRED',
      });
      return;
    }
    req.authUser = user;
    next();
  } catch (err) {
    console.error('Auth verification error:', err);
    res.status(401).json({ error: 'Invalid authentication session.' });
  }
}

async function getActiveSession(uid: string): Promise<BotSession | null> {
  const userSession = userBotSessions.get(uid);
  if (userSession) return userSession;

  if (sharedBotSession) return sharedBotSession;

  const envToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!envToken) return null;

  if (envBotSession && envBotSession.token === envToken) {
    return envBotSession;
  }

  const me = await telegramApiCall<{ id: number; username?: string; first_name?: string }>(
    envToken,
    'getMe'
  );
  if (!me.ok || !me.result) return null;

  envBotSession = {
    token: envToken,
    source: 'env',
    botInfo: {
      id: me.result.id,
      username: me.result.username || 'telegram_bot',
      firstName: me.result.first_name || 'Telegram Bot',
    },
    offset: 0,
    inbox: [],
    chats: new Map(),
    lastSyncedAt: null,
  };
  return envBotSession;
}

function extractPdfFromUpdate(update: TelegramRawUpdate): TelegramPdfItem | null {
  const msg =
    update.message ||
    update.channel_post ||
    update.edited_message ||
    update.edited_channel_post;

  if (!msg || !isPdfDocument(msg.document)) return null;

  const doc = msg.document;
  const chatTitle = formatChatTitle(msg.chat);
  const fileName = sanitizeFileName(doc.file_name || `telegram_${msg.message_id}.pdf`);

  return {
    key: `${msg.chat.id}:${msg.message_id}:${doc.file_unique_id}`,
    updateId: update.update_id,
    messageId: msg.message_id,
    chatId: msg.chat.id,
    chatTitle,
    chatType: msg.chat.type,
    senderName: formatSenderName(msg),
    fileId: doc.file_id,
    fileUniqueId: doc.file_unique_id,
    fileName,
    fileSize: doc.file_size || 0,
    mimeType: doc.mime_type || 'application/pdf',
    caption: (msg.caption || '').trim(),
    postedAt: new Date(msg.date * 1000).toISOString(),
  };
}

function buildMultipartRelated(
  metadata: Record<string, unknown>,
  fileBuffer: Buffer,
  mimeType: string
): { body: Buffer; contentType: string } {
  const boundary = `teledrive_${crypto.randomBytes(16).toString('hex')}`;
  const metadataPart =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`;
  const closingPart = `\r\n--${boundary}--`;

  const body = Buffer.concat([
    Buffer.from(metadataPart, 'utf8'),
    fileBuffer,
    Buffer.from(closingPart, 'utf8'),
  ]);

  return {
    body,
    contentType: `multipart/related; boundary=${boundary}`,
  };
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/telegram/status', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const uid = req.authUser!.uid;
      const session = await getActiveSession(uid);
      if (!session) {
        res.json({
          connected: false,
          source: 'none',
          bot: null,
          lastSyncedAt: null,
          inboxCount: 0,
        });
        return;
      }

      const webhookInfo = await telegramApiCall<{ url?: string }>(session.token, 'getWebhookInfo');
      res.json({
        connected: true,
        source: session.source,
        bot: session.botInfo,
        lastSyncedAt: session.lastSyncedAt,
        webhookActive: Boolean(webhookInfo.ok && webhookInfo.result?.url),
        inboxCount: session.inbox.length,
      });
    } catch (err) {
      console.error('Status check failed:', err);
      res.status(500).json({ error: 'Unable to check Telegram bot status.' });
    }
  });

  app.post('/api/telegram/connect', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const authUser = req.authUser!;
      const uid = authUser.uid;
      const rawToken = typeof req.body?.botToken === 'string' ? req.body.botToken.trim() : '';
      const shareWithApproved = Boolean(req.body?.shareWithApproved) && authUser.isAdmin;

      if (!TOKEN_FORMAT_REGEX.test(rawToken)) {
        res.status(400).json({
          error: 'Invalid bot token format. Please paste the full token from @BotFather.',
        });
        return;
      }

      const me = await telegramApiCall<{ id: number; username?: string; first_name?: string }>(
        rawToken,
        'getMe'
      );
      if (!me.ok || !me.result) {
        res.status(400).json({
          error: me.description || 'Could not verify this Telegram Bot token.',
        });
        return;
      }

      const webhookInfo = await telegramApiCall<{ url?: string }>(rawToken, 'getWebhookInfo');
      const webhookActive = Boolean(webhookInfo.ok && webhookInfo.result?.url);

      const session: BotSession = {
        token: rawToken,
        source: shareWithApproved ? 'shared' : 'session',
        botInfo: {
          id: me.result.id,
          username: me.result.username || 'telegram_bot',
          firstName: me.result.first_name || 'Telegram Bot',
        },
        offset: 0,
        inbox: [],
        chats: new Map(),
        lastSyncedAt: null,
      };

      if (shareWithApproved) {
        sharedBotSession = session;
      } else {
        userBotSessions.set(uid, session);
      }

      res.json({
        connected: true,
        source: session.source,
        bot: session.botInfo,
        webhookActive,
        lastSyncedAt: null,
        inboxCount: 0,
      });
    } catch (err) {
      console.error('Bot connect failed:', err);
      res.status(500).json({ error: 'Failed to connect Telegram Bot.' });
    }
  });

  app.post('/api/telegram/disconnect', requireAuth, async (req: AuthenticatedRequest, res) => {
    const authUser = req.authUser!;
    const uid = authUser.uid;
    const scope = req.body?.scope === 'shared' ? 'shared' : 'session';
    if (scope === 'shared') {
      if (!authUser.isAdmin) {
        res.status(403).json({ error: 'Admin access required to disconnect shared bot.' });
        return;
      }
      sharedBotSession = null;
    } else {
      userBotSessions.delete(uid);
    }
    res.json({ disconnected: true });
  });

  app.post('/api/telegram/clear-webhook', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const uid = req.authUser!.uid;
      const session = await getActiveSession(uid);
      if (!session) {
        res.status(400).json({ error: 'No Telegram Bot connected.' });
        return;
      }

      const result = await telegramApiCall<boolean>(session.token, 'deleteWebhook', {
        drop_pending_updates: false,
      });
      if (!result.ok) {
        res.status(400).json({ error: result.description || 'Failed to clear webhook.' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('Clear webhook failed:', err);
      res.status(500).json({ error: 'Failed to clear Telegram webhook.' });
    }
  });

  app.get('/api/telegram/inbox', requireAuth, async (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const session = await getActiveSession(uid);
    if (!session) {
      res.json({ items: [], chats: [], lastSyncedAt: null });
      return;
    }
    res.json({
      items: session.inbox,
      chats: Array.from(session.chats.values()),
      lastSyncedAt: session.lastSyncedAt,
    });
  });

  app.post('/api/telegram/sync', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const uid = req.authUser!.uid;
      const session = await getActiveSession(uid);
      if (!session) {
        res.status(400).json({ error: 'Connect a Telegram Bot first.' });
        return;
      }

      const clearWebhookIfNeeded = Boolean(req.body?.clearWebhook);
      if (clearWebhookIfNeeded) {
        await telegramApiCall<boolean>(session.token, 'deleteWebhook', {
          drop_pending_updates: false,
        });
      }

      const updatesRes = await telegramApiCall<TelegramRawUpdate[]>(session.token, 'getUpdates', {
        offset: session.offset,
        limit: 200,
        timeout: 0,
        allowed_updates: JSON.stringify([
          'message',
          'edited_message',
          'channel_post',
          'edited_channel_post',
        ]),
      });

      if (!updatesRes.ok && updatesRes.error_code === 409) {
        res.status(409).json({
          error: 'This bot currently has an active webhook. Clear the webhook to read updates here.',
          code: 'WEBHOOK_CONFLICT',
        });
        return;
      }

      if (!updatesRes.ok || !updatesRes.result) {
        res.status(400).json({ error: updatesRes.description || 'Failed to fetch Telegram updates.' });
        return;
      }

      const existingByKey = new Map<string, TelegramPdfItem>(
        session.inbox.map((item) => [item.key, item])
      );

      let newCount = 0;
      for (const update of updatesRes.result) {
        if (update.update_id >= session.offset) {
          session.offset = update.update_id + 1;
        }
        const pdf = extractPdfFromUpdate(update);
        if (!pdf) continue;

        const existing = existingByKey.get(pdf.key);
        if (existing) {
          existingByKey.set(pdf.key, {
            ...pdf,
            driveFileId: existing.driveFileId,
            driveWebViewLink: existing.driveWebViewLink,
            uploadedFolderId: existing.uploadedFolderId,
            uploadedFolderName: existing.uploadedFolderName,
            uploadedAt: existing.uploadedAt,
          });
        } else {
          existingByKey.set(pdf.key, pdf);
          newCount += 1;
        }
      }

      const merged = Array.from(existingByKey.values())
        .sort((a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime())
        .slice(0, 3000);

      session.inbox = merged;
      session.chats = new Map();
      for (const item of merged) {
        const prev = session.chats.get(item.chatId);
        if (prev) {
          prev.pdfCount += 1;
        } else {
          session.chats.set(item.chatId, {
            id: item.chatId,
            title: item.chatTitle,
            type: item.chatType,
            pdfCount: 1,
          });
        }
      }
      session.lastSyncedAt = new Date().toISOString();

      res.json({
        newCount,
        items: session.inbox,
        chats: Array.from(session.chats.values()),
        lastSyncedAt: session.lastSyncedAt,
      });
    } catch (err) {
      console.error('Telegram sync failed:', err);
      res.status(500).json({ error: 'Failed to sync PDFs from Telegram.' });
    }
  });

  app.get(
    '/api/telegram/download/:fileId',
    requireAuth,
    async (req: AuthenticatedRequest, res) => {
      try {
        const uid = req.authUser!.uid;
        const session = await getActiveSession(uid);
        if (!session) {
          res.status(400).json({ error: 'No Telegram Bot connected.' });
          return;
        }

        const fileId = String(req.params.fileId || '').trim();
        if (!TELEGRAM_ID_REGEX.test(fileId)) {
          res.status(400).json({ error: 'Invalid Telegram file ID.' });
          return;
        }

        const fileInfo = await telegramApiCall<{ file_path?: string; file_size?: number }>(
          session.token,
          'getFile',
          { file_id: fileId }
        );

        const filePath = fileInfo.result?.file_path;
        if (!fileInfo.ok || !filePath || filePath.includes('..') || filePath.includes('://')) {
          res.status(404).json({ error: 'File could not be retrieved from Telegram.' });
          return;
        }

        const fileUrl = `https://api.telegram.org/file/bot${session.token}/${filePath}`;
        const tgRes = await fetch(fileUrl);
        if (!tgRes.ok) {
          res.status(502).json({ error: 'Failed to download file bytes from Telegram.' });
          return;
        }

        const arrayBuf = await tgRes.arrayBuffer();
        const buffer = Buffer.from(arrayBuf);
        const rawName = typeof req.query.name === 'string' ? req.query.name : path.basename(filePath);
        const safeName = sanitizeFileName(rawName);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`
        );
        res.setHeader('Content-Length', String(buffer.length));
        res.send(buffer);
      } catch (err) {
        console.error('Download error:', err);
        res.status(500).json({ error: 'Failed to download PDF from Telegram.' });
      }
    }
  );

  app.post(
    '/api/drive/upload-telegram-pdf',
    requireAuth,
    async (req: AuthenticatedRequest, res) => {
      try {
        const uid = req.authUser!.uid;
        const session = await getActiveSession(uid);
        if (!session) {
          res.status(400).json({ error: 'No Telegram Bot connected.' });
          return;
        }

        const authHeader = req.header('Authorization') || '';
        if (!authHeader.startsWith('Bearer ')) {
          res.status(401).json({ error: 'Google Drive access token is required.' });
          return;
        }

        const fileId = typeof req.body?.fileId === 'string' ? req.body.fileId.trim() : '';
        const fileUniqueId =
          typeof req.body?.fileUniqueId === 'string' ? req.body.fileUniqueId.trim() : '';
        const folderId = typeof req.body?.folderId === 'string' ? req.body.folderId.trim() : '';
        const folderName =
          typeof req.body?.folderName === 'string' ? req.body.folderName.trim() : '';
        const itemKey = typeof req.body?.itemKey === 'string' ? req.body.itemKey.trim() : '';
        const targetFileName = sanitizeFileName(
          typeof req.body?.targetFileName === 'string' ? req.body.targetFileName : 'document.pdf'
        );
        const skipDuplicates = req.body?.skipDuplicates !== false;
        const chatTitle = typeof req.body?.chatTitle === 'string' ? req.body.chatTitle.trim() : '';

        if (!TELEGRAM_ID_REGEX.test(fileId)) {
          res.status(400).json({ error: 'Invalid Telegram file ID.' });
          return;
        }
        if (!DRIVE_ID_REGEX.test(folderId)) {
          res.status(400).json({ error: 'Invalid Google Drive folder ID.' });
          return;
        }

        if (skipDuplicates && fileUniqueId && TELEGRAM_ID_REGEX.test(fileUniqueId)) {
          const q = `'${folderId}' in parents and trashed = false and appProperties has { key='telegramUniqueId' and value='${fileUniqueId}' }`;
          const checkUrl = new URL('https://www.googleapis.com/drive/v3/files');
          checkUrl.searchParams.set('q', q);
          checkUrl.searchParams.set('fields', 'files(id,name,webViewLink,createdTime)');
          checkUrl.searchParams.set('pageSize', '1');

          const checkRes = await fetch(checkUrl.toString(), {
            headers: { Authorization: authHeader },
          });

          if (checkRes.status === 401) {
            res.status(401).json({ error: 'Google Drive session expired. Please sign in again.' });
            return;
          }

          if (checkRes.ok) {
            const checkData = (await checkRes.json()) as {
              files?: Array<{ id: string; name: string; webViewLink?: string; createdTime?: string }>;
            };
            const existing = checkData.files?.[0];
            if (existing) {
              const foundItem = session.inbox.find((i) => i.key === itemKey);
              if (foundItem) {
                foundItem.driveFileId = existing.id;
                foundItem.driveWebViewLink = existing.webViewLink;
                foundItem.uploadedFolderId = folderId;
                foundItem.uploadedFolderName = folderName || undefined;
                foundItem.uploadedAt = existing.createdTime || new Date().toISOString();
              }
              res.json({
                duplicate: true,
                file: existing,
              });
              return;
            }
          }
        }

        const fileInfo = await telegramApiCall<{ file_path?: string; file_size?: number }>(
          session.token,
          'getFile',
          { file_id: fileId }
        );
        const filePath = fileInfo.result?.file_path;
        if (!fileInfo.ok || !filePath || filePath.includes('..') || filePath.includes('://')) {
          res.status(404).json({ error: 'Telegram file is no longer available or exceeds 20 MB Bot API limit.' });
          return;
        }

        const tgUrl = `https://api.telegram.org/file/bot${session.token}/${filePath}`;
        const tgRes = await fetch(tgUrl);
        if (!tgRes.ok) {
          res.status(502).json({ error: 'Failed to download PDF from Telegram.' });
          return;
        }

        const pdfBuffer = Buffer.from(await tgRes.arrayBuffer());
        if (pdfBuffer.length > 25 * 1024 * 1024) {
          res.status(413).json({ error: 'PDF exceeds 25 MB upload limit.' });
          return;
        }

        const metadata: Record<string, unknown> = {
          name: targetFileName,
          parents: [folderId],
          mimeType: 'application/pdf',
          description: chatTitle
            ? `Synced from Telegram (${chatTitle}) via TeleDrive`
            : 'Synced from Telegram via TeleDrive',
        };
        if (fileUniqueId && TELEGRAM_ID_REGEX.test(fileUniqueId)) {
          metadata.appProperties = {
            telegramUniqueId: fileUniqueId,
            source: 'TeleDrive',
          };
        }

        const { body, contentType } = buildMultipartRelated(
          metadata,
          pdfBuffer,
          'application/pdf'
        );

        const driveRes = await fetch(
          'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,mimeType,webViewLink,createdTime,parents',
          {
            method: 'POST',
            headers: {
              Authorization: authHeader,
              'Content-Type': contentType,
              'Content-Length': String(body.length),
            },
            body: new Uint8Array(body),
          }
        );

        if (driveRes.status === 401) {
          res.status(401).json({ error: 'Google Drive authorization expired. Please sign in again.' });
          return;
        }

        const driveJson = (await driveRes.json()) as {
          id?: string;
          name?: string;
          webViewLink?: string;
          createdTime?: string;
          error?: { message?: string };
        };

        if (!driveRes.ok || !driveJson.id) {
          res.status(driveRes.status || 500).json({
            error: driveJson.error?.message || 'Failed to upload PDF to Google Drive.',
          });
          return;
        }

        const inboxItem = session.inbox.find((i) => i.key === itemKey);
        if (inboxItem) {
          inboxItem.driveFileId = driveJson.id;
          inboxItem.driveWebViewLink = driveJson.webViewLink;
          inboxItem.uploadedFolderId = folderId;
          inboxItem.uploadedFolderName = folderName || undefined;
          inboxItem.uploadedAt = driveJson.createdTime || new Date().toISOString();
        }

        res.json({
          duplicate: false,
          file: driveJson,
        });
      } catch (err) {
        console.error('Upload to Drive failed:', err);
        res.status(500).json({ error: 'Unexpected error while saving PDF to Google Drive.' });
      }
    }
  );

  if (process.env.NODE_ENV !== 'production') {
    const vite = await import('vite');
    const viteServer = await vite.createServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(viteServer.middlewares);
  } else {
    const distPath = path.resolve('dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => {
    console.log(`TeleDrive server listening on port ${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
