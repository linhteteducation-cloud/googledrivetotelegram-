import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Timestamp,
} from 'firebase/firestore';
import type { User } from 'firebase/auth';
import { auth, db } from './firebase';
import type {
  AccessStatus,
  ActivityLogItem,
  AllowedEmailEntry,
  Language,
  NamingRule,
  TelegramPdfItem,
  UserAccessEntry,
} from '../types';

export const PRIMARY_ADMIN_EMAIL = 'linhteteducation@gmail.com';

export function isAdminUser(user: User | null): boolean {
  return Boolean(
    user &&
      user.emailVerified &&
      user.email &&
      user.email.trim().toLowerCase() === PRIMARY_ADMIN_EMAIL
  );
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export interface WorkspaceSettingsDoc {
  ownerId: string;
  targetFolderId: string;
  targetFolderName: string;
  targetFolderWebLink: string;
  namingRule: NamingRule;
  skipDuplicates: boolean;
  language: Language;
  botUsername: string;
}

const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function sha256Email(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const data = new TextEncoder().encode(normalized);
  const hashBuf = await window.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function normalizePdfDocId(rawKey: string): string {
  const sanitized = rawKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
  return sanitized || `pdf_${Date.now()}`;
}

function clampString(val: string | undefined, fallback: string, maxLen: number): string {
  const trimmed = (val || '').trim();
  const base = trimmed || fallback;
  return base.slice(0, maxLen);
}

function sanitizeHttpsOrEmpty(url: string | undefined): string {
  const trimmed = (url || '').trim().slice(0, 512);
  if (!trimmed) return '';
  return trimmed.startsWith('https://') ? trimmed : '';
}

function sanitizeId(id: string | undefined, maxLen = 128): string {
  const trimmed = (id || '').trim().slice(0, maxLen);
  return ID_PATTERN.test(trimmed) ? trimmed : '';
}

function timestampToIso(ts: unknown): string {
  if (
    ts &&
    typeof ts === 'object' &&
    'toDate' in ts &&
    typeof (ts as Timestamp).toDate === 'function'
  ) {
    return (ts as Timestamp).toDate().toISOString();
  }
  if (typeof ts === 'string') return ts;
  return new Date().toISOString();
}

export async function ensureUserAccessOnLogin(user: User): Promise<AccessStatus> {
  const email = (user.email || '').trim().toLowerCase();
  if (!email || !EMAIL_PATTERN.test(email) || !user.emailVerified) {
    return 'pending';
  }
  const emailHash = await sha256Email(email);
  const displayName = (user.displayName || '').trim().slice(0, 120);

  if (isAdminUser(user)) {
    const ref = doc(db, 'userAccess', user.uid);
    const path = `userAccess/${user.uid}`;
    try {
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        await setDoc(ref, {
          uid: user.uid,
          email,
          emailHash,
          displayName,
          status: 'approved',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, path);
    }
    return 'approved';
  }

  let allowlistStatus: string | null = null;
  const allowPath = `allowedEmails/${emailHash}`;
  try {
    const allowSnap = await getDoc(doc(db, 'allowedEmails', emailHash));
    if (allowSnap.exists()) {
      allowlistStatus = String(allowSnap.data().status || '');
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, allowPath);
  }

  const accessRef = doc(db, 'userAccess', user.uid);
  const accessPath = `userAccess/${user.uid}`;
  try {
    const accessSnap = await getDoc(accessRef);
    if (!accessSnap.exists()) {
      const initialStatus: AccessStatus =
        allowlistStatus === 'approved' ? 'approved' : 'pending';
      await setDoc(accessRef, {
        uid: user.uid,
        email,
        emailHash,
        displayName,
        status: initialStatus,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      return initialStatus;
    }

    const currentStatus = String(accessSnap.data().status || 'pending') as AccessStatus;
    if (allowlistStatus === 'revoked' || currentStatus === 'revoked') {
      return 'revoked';
    }
    if (currentStatus === 'pending' && allowlistStatus === 'approved') {
      await updateDoc(accessRef, {
        status: 'approved',
        displayName,
        updatedAt: serverTimestamp(),
      });
      return 'approved';
    }
    return currentStatus;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, accessPath);
  }
}

export function subscribeMyAccessStatus(
  user: User,
  onStatus: (status: AccessStatus) => void,
  onError: (err: Error) => void
): () => void {
  if (isAdminUser(user)) {
    onStatus('approved');
    return () => {};
  }

  const email = (user.email || '').trim().toLowerCase();
  let active = true;
  let unsubAccess: (() => void) | null = null;
  let unsubAllowlist: (() => void) | null = null;

  let accessDocStatus: AccessStatus = 'pending';
  let allowlistDocStatus: 'approved' | 'revoked' | null = null;

  const evaluate = async () => {
    if (!active) return;
    if (allowlistDocStatus === 'revoked' || accessDocStatus === 'revoked') {
      onStatus('revoked');
      return;
    }
    if (accessDocStatus === 'approved') {
      onStatus('approved');
      return;
    }
    if (allowlistDocStatus === 'approved') {
      try {
        await updateDoc(doc(db, 'userAccess', user.uid), {
          status: 'approved',
          displayName: (user.displayName || '').trim().slice(0, 120),
          updatedAt: serverTimestamp(),
        });
      } catch {
        // will retry on next snapshot if needed
      }
      onStatus('approved');
      return;
    }
    onStatus('pending');
  };

  const accessPath = `userAccess/${user.uid}`;
  unsubAccess = onSnapshot(
    doc(db, 'userAccess', user.uid),
    (snap) => {
      if (snap.exists()) {
        accessDocStatus = String(snap.data().status || 'pending') as AccessStatus;
      }
      void evaluate();
    },
    (err) => {
      try {
        handleFirestoreError(err, OperationType.GET, accessPath);
      } catch (wrapped) {
        onError(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
      }
    }
  );

  void sha256Email(email).then((emailHash) => {
    if (!active) return;
    const allowPath = `allowedEmails/${emailHash}`;
    unsubAllowlist = onSnapshot(
      doc(db, 'allowedEmails', emailHash),
      (snap) => {
        allowlistDocStatus = snap.exists()
          ? (String(snap.data().status || 'revoked') as 'approved' | 'revoked')
          : null;
        void evaluate();
      },
      (err) => {
        try {
          handleFirestoreError(err, OperationType.GET, allowPath);
        } catch (wrapped) {
          onError(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
        }
      }
    );
  });

  return () => {
    active = false;
    if (unsubAccess) unsubAccess();
    if (unsubAllowlist) unsubAllowlist();
  };
}

export function subscribeAllAllowedEmails(
  onData: (items: AllowedEmailEntry[]) => void,
  onError: (err: Error) => void
): () => void {
  const path = 'allowedEmails';
  return onSnapshot(
    query(collection(db, 'allowedEmails'), limit(2000)),
    (snapshot) => {
      const list: AllowedEmailEntry[] = snapshot.docs.map((d) => {
        const data = d.data();
        return {
          emailHash: String(data.emailHash || d.id),
          email: String(data.email || ''),
          status: data.status === 'revoked' ? 'revoked' : 'approved',
          note: String(data.note || ''),
          addedByUid: String(data.addedByUid || ''),
          createdAt: timestampToIso(data.createdAt),
          updatedAt: timestampToIso(data.updatedAt),
        };
      });
      list.sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
      onData(list);
    },
    (err) => {
      try {
        handleFirestoreError(err, OperationType.LIST, path);
      } catch (wrapped) {
        onError(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
      }
    }
  );
}

export function subscribeAllUserAccess(
  onData: (items: UserAccessEntry[]) => void,
  onError: (err: Error) => void
): () => void {
  const path = 'userAccess';
  return onSnapshot(
    query(collection(db, 'userAccess'), limit(2000)),
    (snapshot) => {
      const list: UserAccessEntry[] = snapshot.docs.map((d) => {
        const data = d.data();
        return {
          uid: String(data.uid || d.id),
          email: String(data.email || ''),
          emailHash: String(data.emailHash || ''),
          displayName: String(data.displayName || ''),
          status: (data.status || 'pending') as AccessStatus,
          createdAt: timestampToIso(data.createdAt),
          updatedAt: timestampToIso(data.updatedAt),
        };
      });
      const rank: Record<AccessStatus, number> = {
        pending: 0,
        approved: 1,
        revoked: 2,
      };
      list.sort((a, b) => {
        if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      });
      onData(list);
    },
    (err) => {
      try {
        handleFirestoreError(err, OperationType.LIST, path);
      } catch (wrapped) {
        onError(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
      }
    }
  );
}

export async function adminSetEmailStatus(
  adminUid: string,
  rawEmail: string,
  status: 'approved' | 'revoked',
  note: string,
  matchingUser?: UserAccessEntry | null
): Promise<void> {
  const email = rawEmail.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    throw new Error('Please enter a valid email address.');
  }

  const emailHash = await sha256Email(email);
  const safeNote = note.trim().slice(0, 200);
  const allowRef = doc(db, 'allowedEmails', emailHash);
  const allowPath = `allowedEmails/${emailHash}`;

  try {
    const snap = await getDoc(allowRef);
    if (!snap.exists()) {
      await setDoc(allowRef, {
        emailHash,
        email,
        status,
        note: safeNote,
        addedByUid: adminUid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(allowRef, {
        status,
        note: safeNote || String(snap.data().note || ''),
        addedByUid: adminUid,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, allowPath);
  }

  if (matchingUser) {
    const userPath = `userAccess/${matchingUser.uid}`;
    try {
      await updateDoc(doc(db, 'userAccess', matchingUser.uid), {
        status,
        displayName: matchingUser.displayName.slice(0, 120),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, userPath);
    }
  }
}

export async function adminDeleteAllowedEmail(
  emailHash: string,
  matchingUser?: UserAccessEntry | null
): Promise<void> {
  const path = `allowedEmails/${emailHash}`;
  try {
    await deleteDoc(doc(db, 'allowedEmails', emailHash));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }

  if (matchingUser && matchingUser.email.toLowerCase() !== PRIMARY_ADMIN_EMAIL) {
    const userPath = `userAccess/${matchingUser.uid}`;
    try {
      await updateDoc(doc(db, 'userAccess', matchingUser.uid), {
        status: 'revoked',
        displayName: matchingUser.displayName.slice(0, 120),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, userPath);
    }
  }
}

export function subscribeWorkspaceSettings(
  uid: string,
  onData: (settings: WorkspaceSettingsDoc | null) => void,
  onError: (err: Error) => void
): () => void {
  const path = `users/${uid}/settings/workspace`;
  const ref = doc(db, 'users', uid, 'settings', 'workspace');

  return onSnapshot(
    ref,
    (snapshot) => {
      if (!snapshot.exists()) {
        onData(null);
        return;
      }
      const d = snapshot.data();
      onData({
        ownerId: String(d.ownerId || uid),
        targetFolderId: String(d.targetFolderId || ''),
        targetFolderName: String(d.targetFolderName || ''),
        targetFolderWebLink: String(d.targetFolderWebLink || ''),
        namingRule:
          d.namingRule === 'date_prefix' || d.namingRule === 'chat_prefix'
            ? d.namingRule
            : 'original',
        skipDuplicates: d.skipDuplicates !== false,
        language: d.language === 'en' ? 'en' : 'my',
        botUsername: String(d.botUsername || ''),
      });
    },
    (err) => {
      try {
        handleFirestoreError(err, OperationType.GET, path);
      } catch (wrapped) {
        onError(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
      }
    }
  );
}

export async function saveWorkspaceSettings(
  uid: string,
  settings: Omit<WorkspaceSettingsDoc, 'ownerId'>
): Promise<void> {
  const path = `users/${uid}/settings/workspace`;
  const ref = doc(db, 'users', uid, 'settings', 'workspace');
  const payload = {
    targetFolderId: sanitizeId(settings.targetFolderId, 128),
    targetFolderName: (settings.targetFolderName || '').trim().slice(0, 255),
    targetFolderWebLink: sanitizeHttpsOrEmpty(settings.targetFolderWebLink),
    namingRule: settings.namingRule,
    skipDuplicates: Boolean(settings.skipDuplicates),
    language: settings.language,
    botUsername: (settings.botUsername || '').trim().slice(0, 100),
  };

  try {
    const existingSnap = await getDoc(ref);
    if (!existingSnap.exists()) {
      await setDoc(ref, {
        ownerId: uid,
        ...payload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        ...payload,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export function subscribePdfRecords(
  uid: string,
  onData: (items: TelegramPdfItem[]) => void,
  onError: (err: Error) => void
): () => void {
  const path = `users/${uid}/pdfs`;
  const q = query(
    collection(db, 'users', uid, 'pdfs'),
    where('ownerId', '==', uid),
    limit(2000)
  );

  return onSnapshot(
    q,
    (snapshot) => {
      const items: TelegramPdfItem[] = snapshot.docs.map((docSnap) => {
        const d = docSnap.data();
        return {
          key: String(d.pdfKey || docSnap.id),
          updateId: Number(d.updateId || 0),
          messageId: Number(d.messageId || 0),
          chatId: Number(d.chatId || 0),
          chatTitle: String(d.chatTitle || 'Telegram'),
          chatType: String(d.chatType || 'private'),
          senderName: String(d.senderName || 'Unknown'),
          fileId: String(d.fileId || ''),
          fileUniqueId: String(d.fileUniqueId || ''),
          fileName: String(d.fileName || 'document.pdf'),
          fileSize: Number(d.fileSize || 0),
          mimeType: String(d.mimeType || 'application/pdf'),
          caption: String(d.caption || ''),
          postedAt: String(d.postedAt || new Date().toISOString()),
          driveFileId: d.driveFileId ? String(d.driveFileId) : undefined,
          driveWebViewLink: d.driveWebViewLink ? String(d.driveWebViewLink) : undefined,
          uploadedFolderId: d.uploadedFolderId ? String(d.uploadedFolderId) : undefined,
          uploadedFolderName: d.uploadedFolderName ? String(d.uploadedFolderName) : undefined,
          uploadedAt: d.uploadedAt ? String(d.uploadedAt) : undefined,
        };
      });

      items.sort(
        (a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime()
      );
      onData(items);
    },
    (err) => {
      try {
        handleFirestoreError(err, OperationType.LIST, path);
      } catch (wrapped) {
        onError(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
      }
    }
  );
}

export async function syncTelegramPdfsToFirestore(
  uid: string,
  items: TelegramPdfItem[]
): Promise<void> {
  for (const item of items) {
    const pdfKey = normalizePdfDocId(item.key);
    const path = `users/${uid}/pdfs/${pdfKey}`;
    const ref = doc(db, 'users', uid, 'pdfs', pdfKey);
    const fileId = sanitizeId(item.fileId, 256);
    const fileUniqueId = sanitizeId(item.fileUniqueId, 256);
    if (fileId.length < 5 || fileUniqueId.length < 3) continue;

    try {
      const existingSnap = await getDoc(ref);
      if (!existingSnap.exists()) {
        const isSaved = Boolean(item.driveFileId && item.uploadedFolderId);
        await setDoc(ref, {
          ownerId: uid,
          pdfKey,
          updateId: Number(item.updateId || 0),
          messageId: Number(item.messageId || 0),
          chatId: Number(item.chatId || 0),
          chatTitle: clampString(item.chatTitle, 'Telegram', 200),
          chatType: clampString(item.chatType, 'private', 40),
          senderName: clampString(item.senderName, 'Telegram User', 200),
          fileId,
          fileUniqueId,
          fileName: clampString(item.fileName, 'document.pdf', 255),
          fileSize: Math.max(0, Number(item.fileSize || 0)),
          mimeType: clampString(item.mimeType, 'application/pdf', 100),
          caption: (item.caption || '').trim().slice(0, 1000),
          postedAt: clampString(item.postedAt, new Date().toISOString(), 40),
          status: isSaved ? 'saved' : 'pending',
          driveFileId: sanitizeId(item.driveFileId, 128),
          driveWebViewLink: sanitizeHttpsOrEmpty(item.driveWebViewLink),
          uploadedFolderId: sanitizeId(item.uploadedFolderId, 128),
          uploadedFolderName: (item.uploadedFolderName || '').trim().slice(0, 255),
          uploadedAt: (item.uploadedAt || '').trim().slice(0, 40),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } else {
        const existingData = existingSnap.data();
        const nextFileName = clampString(item.fileName, 'document.pdf', 255);
        const nextCaption = (item.caption || '').trim().slice(0, 1000);
        if (
          existingData.fileId !== fileId ||
          existingData.fileName !== nextFileName ||
          existingData.caption !== nextCaption
        ) {
          await updateDoc(ref, {
            fileId,
            fileName: nextFileName,
            caption: nextCaption,
            updateId: Number(item.updateId || 0),
            updatedAt: serverTimestamp(),
          });
        }
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, path);
    }
  }
}

export async function markPdfSavedInFirestore(
  uid: string,
  item: TelegramPdfItem,
  driveFile: { id: string; webViewLink?: string; createdTime?: string },
  folderId: string,
  folderName: string
): Promise<void> {
  const pdfKey = normalizePdfDocId(item.key);
  const path = `users/${uid}/pdfs/${pdfKey}`;
  const ref = doc(db, 'users', uid, 'pdfs', pdfKey);
  const safeDriveFileId = sanitizeId(driveFile.id, 128);
  const safeFolderId = sanitizeId(folderId, 128);
  const safeFileId = sanitizeId(item.fileId, 256);
  const safeUniqueId = sanitizeId(item.fileUniqueId, 256);

  if (!safeDriveFileId || !safeFolderId) return;

  try {
    const existingSnap = await getDoc(ref);
    if (!existingSnap.exists()) {
      await setDoc(ref, {
        ownerId: uid,
        pdfKey,
        updateId: Number(item.updateId || 0),
        messageId: Number(item.messageId || 0),
        chatId: Number(item.chatId || 0),
        chatTitle: clampString(item.chatTitle, 'Telegram', 200),
        chatType: clampString(item.chatType, 'private', 40),
        senderName: clampString(item.senderName, 'Telegram User', 200),
        fileId: safeFileId,
        fileUniqueId: safeUniqueId,
        fileName: clampString(item.fileName, 'document.pdf', 255),
        fileSize: Math.max(0, Number(item.fileSize || 0)),
        mimeType: clampString(item.mimeType, 'application/pdf', 100),
        caption: (item.caption || '').trim().slice(0, 1000),
        postedAt: clampString(item.postedAt, new Date().toISOString(), 40),
        status: 'saved',
        driveFileId: safeDriveFileId,
        driveWebViewLink: sanitizeHttpsOrEmpty(driveFile.webViewLink),
        uploadedFolderId: safeFolderId,
        uploadedFolderName: folderName.trim().slice(0, 255),
        uploadedAt: clampString(driveFile.createdTime, new Date().toISOString(), 40),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        status: 'saved',
        driveFileId: safeDriveFileId,
        driveWebViewLink: sanitizeHttpsOrEmpty(driveFile.webViewLink),
        uploadedFolderId: safeFolderId,
        uploadedFolderName: folderName.trim().slice(0, 255),
        uploadedAt: clampString(driveFile.createdTime, new Date().toISOString(), 40),
        fileId: safeFileId,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function removePdfRecordFromFirestore(
  uid: string,
  rawKey: string
): Promise<void> {
  const pdfKey = normalizePdfDocId(rawKey);
  const path = `users/${uid}/pdfs/${pdfKey}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'pdfs', pdfKey));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export function subscribeActivities(
  uid: string,
  onData: (items: ActivityLogItem[]) => void,
  onError: (err: Error) => void
): () => void {
  const path = `users/${uid}/activities`;
  const q = query(
    collection(db, 'users', uid, 'activities'),
    where('ownerId', '==', uid),
    limit(100)
  );

  return onSnapshot(
    q,
    (snapshot) => {
      const items: ActivityLogItem[] = snapshot.docs.map((docSnap) => {
        const d = docSnap.data();
        return {
          id: docSnap.id,
          timestamp: timestampToIso(d.createdAt),
          action: (d.action || 'sync') as ActivityLogItem['action'],
          title: String(d.title || ''),
          detail: String(d.detail || ''),
          status: (d.status || 'success') as ActivityLogItem['status'],
        };
      });

      items.sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );
      onData(items);
    },
    (err) => {
      try {
        handleFirestoreError(err, OperationType.LIST, path);
      } catch (wrapped) {
        onError(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
      }
    }
  );
}

export async function addRealtimeActivity(
  uid: string,
  action: ActivityLogItem['action'],
  title: string,
  detail: string,
  status: ActivityLogItem['status'] = 'success'
): Promise<void> {
  const activityId = `act_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const path = `users/${uid}/activities/${activityId}`;
  try {
    await setDoc(doc(db, 'users', uid, 'activities', activityId), {
      ownerId: uid,
      action,
      title: clampString(title, action, 255),
      detail: clampString(detail, action, 500),
      status,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function clearRealtimeActivities(
  uid: string,
  activityIds: string[]
): Promise<void> {
  for (const id of activityIds) {
    const safeId = sanitizeId(id, 128);
    if (!safeId) continue;
    const path = `users/${uid}/activities/${safeId}`;
    try {
      await deleteDoc(doc(db, 'users', uid, 'activities', safeId));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
  }
}
