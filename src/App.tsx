import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  AlertCircle,
  ArrowLeftRight,
  ArrowUpRight,
  Bot,
  Check,
  CheckCircle2,
  Clock,
  Database,
  Download,
  FileText,
  Folder,
  FolderOpen,
  Globe,
  HardDriveUpload,
  Loader2,
  LogOut,
  RefreshCw,
  Search,
  ShieldX,
  Trash2,
} from 'lucide-react';
import { AdminPanel } from './components/AdminPanel';
import { BotSetupPanel } from './components/BotSetupPanel';
import { ConfirmModal } from './components/ConfirmModal';
import { DriveFolderPicker } from './components/DriveFolderPicker';
import { GoogleSignInButton } from './components/GoogleSignInButton';
import {
  DriveAuthExpiredError,
  listDriveFolderPdfs,
  trashDriveFile,
} from './lib/drive';
import {
  clearAccessToken,
  getAccessToken,
  getDriveAccount,
  getFirebaseIdToken,
  googleSignIn,
  initAuth,
  logout,
  switchDriveAccount,
  type DriveAccountInfo,
} from './lib/firebase';
import {
  addRealtimeActivity,
  clearRealtimeActivities,
  ensureUserAccessOnLogin,
  isAdminUser,
  markPdfSavedInFirestore,
  removePdfRecordFromFirestore,
  saveWorkspaceSettings,
  subscribeActivities,
  subscribeMyAccessStatus,
  subscribePdfRecords,
  subscribeWorkspaceSettings,
  syncTelegramPdfsToFirestore,
  type WorkspaceSettingsDoc,
} from './lib/firestoreDb';
import { t } from './lib/i18n';
import type {
  AccessStatus,
  ActivityLogItem,
  DriveFileItem,
  DriveFolder,
  Language,
  NamingRule,
  SyncRuleSettings,
  TelegramChatSummary,
  TelegramPdfItem,
  TelegramStatusResponse,
} from './types';

type ActiveTab = 'inbox' | 'folder' | 'rules' | 'activity' | 'admin';
type InboxFilter = 'all' | 'pending' | 'saved';

const LANG_STORAGE_KEY = 'teledrive_lang_v1';

function loadInitialLang(): Language {
  try {
    const saved = localStorage.getItem(LANG_STORAGE_KEY);
    if (saved === 'my' || saved === 'en') return saved;
  } catch {
    // ignore storage errors
  }
  return 'my';
}

function formatBytes(bytes: number | string | undefined): string {
  const num = typeof bytes === 'string' ? Number(bytes) : bytes || 0;
  if (!num || num <= 0) return '—';
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  return `${(num / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDateTime(iso: string | undefined, lang: Language): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat(lang === 'my' ? 'en-GB' : 'en-US', {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function formatTargetFileName(item: TelegramPdfItem, rule: NamingRule): string {
  const baseName = item.fileName.toLowerCase().endsWith('.pdf')
    ? item.fileName
    : `${item.fileName}.pdf`;
  if (rule === 'date_prefix') {
    const datePart = item.postedAt.slice(0, 10);
    return `${datePart}_${baseName}`;
  }
  if (rule === 'chat_prefix') {
    const safeChat = item.chatTitle.replace(/[/\\:*?"<>|]/g, '_').trim() || 'Telegram';
    return `[${safeChat}]_${baseName}`;
  }
  return baseName;
}

export default function App() {
  const [lang, setLang] = useState<Language>(loadInitialLang);
  const copyText = t(lang);

  const [user, setUser] = useState<User | null>(null);
  const [driveAccount, setDriveAccount] = useState<DriveAccountInfo | null>(null);
  const [driveAccessToken, setDriveAccessToken] = useState<string | null>(null);
  const [switchingDriveAccount, setSwitchingDriveAccount] = useState<boolean>(false);
  const [needsAuth, setNeedsAuth] = useState<boolean>(true);
  const [accessStatus, setAccessStatus] = useState<AccessStatus | 'checking'>('checking');
  const [isLoggingIn, setIsLoggingIn] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<ActiveTab>('inbox');
  const [selectedFolder, setSelectedFolder] = useState<DriveFolder | null>(null);
  const [folderPickerOpen, setFolderPickerOpen] = useState<boolean>(false);
  const [firestoreReady, setFirestoreReady] = useState<boolean>(false);

  const [tgStatus, setTgStatus] = useState<TelegramStatusResponse>({
    connected: false,
    source: 'none',
    bot: null,
    lastSyncedAt: null,
    inboxCount: 0,
  });
  const [inbox, setInbox] = useState<TelegramPdfItem[]>([]);
  const [loadingInbox, setLoadingInbox] = useState<boolean>(false);
  const [syncingTelegram, setSyncingTelegram] = useState<boolean>(false);
  const [telegramError, setTelegramError] = useState<string | null>(null);

  const [inboxFilter, setInboxFilter] = useState<InboxFilter>('all');
  const [chatFilter, setChatFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [uploadingKeys, setUploadingKeys] = useState<Set<string>>(new Set());
  const [downloadingKeys, setDownloadingKeys] = useState<Set<string>>(new Set());
  const [batchUploading, setBatchUploading] = useState<boolean>(false);

  const [folderPdfs, setFolderPdfs] = useState<DriveFileItem[]>([]);
  const [loadingFolderPdfs, setLoadingFolderPdfs] = useState<boolean>(false);
  const [pendingDeleteFile, setPendingDeleteFile] = useState<DriveFileItem | null>(null);
  const [deletingFile, setDeletingFile] = useState<boolean>(false);

  const [pendingRemoveInboxItem, setPendingRemoveInboxItem] =
    useState<TelegramPdfItem | null>(null);
  const [removingInboxItem, setRemovingInboxItem] = useState<boolean>(false);

  const [pendingClearActivity, setPendingClearActivity] = useState<boolean>(false);
  const [clearingActivity, setClearingActivity] = useState<boolean>(false);

  const [rules, setRules] = useState<SyncRuleSettings>({
    namingRule: 'original',
    skipDuplicates: true,
    autoSyncEnabled: false,
    pollIntervalSeconds: 10,
    allowedChatIds: [],
  });
  const [pendingAutoSyncConfirm, setPendingAutoSyncConfirm] = useState<boolean>(false);

  const [bannerError, setBannerError] = useState<string | null>(null);
  const [fatalDbError, setFatalDbError] = useState<Error | null>(null);
  const [activities, setActivities] = useState<ActivityLogItem[]>([]);

  const autoSyncBusyRef = useRef<boolean>(false);
  const botUsernameRef = useRef<string>('');

  const userIsAdmin = isAdminUser(user);
  const isApproved = accessStatus === 'approved';

  if (fatalDbError) {
    throw fatalDbError;
  }

  const persistSettingsToFirestore = useCallback(
    async (overrides?: {
      folder?: DriveFolder | null;
      namingRule?: NamingRule;
      skipDuplicates?: boolean;
      language?: Language;
      botUsername?: string;
    }) => {
      if (!user) return;
      const folderVal =
        overrides && 'folder' in overrides ? overrides.folder : selectedFolder;
      const payload: Omit<WorkspaceSettingsDoc, 'ownerId'> = {
        targetFolderId: folderVal?.id || '',
        targetFolderName: folderVal?.name || '',
        targetFolderWebLink: folderVal?.webViewLink || '',
        namingRule: overrides?.namingRule ?? rules.namingRule,
        skipDuplicates: overrides?.skipDuplicates ?? rules.skipDuplicates,
        language: overrides?.language ?? lang,
        botUsername:
          overrides?.botUsername ?? (tgStatus.bot?.username || botUsernameRef.current || ''),
      };
      await saveWorkspaceSettings(user.uid, payload);
    },
    [user, selectedFolder, rules.namingRule, rules.skipDuplicates, lang, tgStatus.bot?.username]
  );

  const addActivity = useCallback(
    async (
      action: ActivityLogItem['action'],
      title: string,
      detail: string,
      status: ActivityLogItem['status'] = 'success'
    ) => {
      if (!user) return;
      try {
        await addRealtimeActivity(user.uid, action, title, detail, status);
      } catch (err) {
        console.error('Activity write failed:', err);
      }
    },
    [user]
  );

  useEffect(() => {
    try {
      localStorage.setItem(LANG_STORAGE_KEY, lang);
    } catch {
      // ignore
    }
  }, [lang]);

  const apiFetch = useCallback(async (url: string, init?: RequestInit) => {
    const idToken = await getFirebaseIdToken();
    if (!idToken) {
      throw new Error('Authentication required.');
    }
    const headers = new Headers(init?.headers || {});
    headers.set('x-firebase-id-token', idToken);
    if (init?.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    return fetch(url, { ...init, headers });
  }, []);

  const handleAuthExpired = useCallback(() => {
    clearAccessToken();
    setDriveAccount(null);
    setDriveAccessToken(null);
    setNeedsAuth(true);
    setRules((prev) => ({ ...prev, autoSyncEnabled: false }));
    setBannerError(copyText.authNeededWarning);
  }, [copyText.authNeededWarning]);

  const refreshTelegramStatus = useCallback(async () => {
    try {
      const statusRes = await apiFetch('/api/telegram/status');
      if (statusRes.ok) {
        const statusData = (await statusRes.json()) as TelegramStatusResponse;
        setTgStatus(statusData);
        setTelegramError(null);
        if (statusData.bot?.username) {
          botUsernameRef.current = statusData.bot.username;
        }
      } else {
        const errData = (await statusRes.json().catch(() => ({}))) as { error?: string };
        setTelegramError(errData.error || 'Unable to check Telegram bot status.');
      }
    } catch (err) {
      console.error('Failed to load Telegram status:', err);
      setTelegramError(
        err instanceof Error ? err.message : 'Unable to reach Telegram status service.'
      );
    }
  }, [apiFetch]);

  const refreshFolderPdfs = useCallback(async () => {
    const token = getAccessToken();
    if (!token || !selectedFolder) {
      setFolderPdfs([]);
      return;
    }
    setLoadingFolderPdfs(true);
    try {
      const files = await listDriveFolderPdfs(token, selectedFolder.id);
      setFolderPdfs(files);
    } catch (err) {
      if (err instanceof DriveAuthExpiredError) {
        handleAuthExpired();
        return;
      }
      setBannerError(err instanceof Error ? err.message : 'Unable to load Drive folder.');
    } finally {
      setLoadingFolderPdfs(false);
    }
  }, [selectedFolder, handleAuthExpired]);

  useEffect(() => {
    const unsubscribe = initAuth(
      (authedUser, token) => {
        setUser(authedUser);
        setDriveAccessToken(token);
        setDriveAccount(getDriveAccount());
        setNeedsAuth(false);
        setAccessStatus(isAdminUser(authedUser) ? 'approved' : 'checking');
      },
      (firebaseUser) => {
        setUser(firebaseUser);
        setDriveAccessToken(null);
        setDriveAccount(null);
        setNeedsAuth(true);
        setAccessStatus('checking');
      }
    );
    return () => unsubscribe();
  }, []);

  // Verify and subscribe to user's Admin-approved access status in real time
  useEffect(() => {
    if (!user || needsAuth) {
      setAccessStatus('checking');
      return;
    }

    let active = true;
    let unsubAccess: (() => void) | null = null;
    setAccessStatus(isAdminUser(user) ? 'approved' : 'checking');

    void ensureUserAccessOnLogin(user)
      .then((initialStatus) => {
        if (!active) return;
        setAccessStatus(initialStatus);
        unsubAccess = subscribeMyAccessStatus(
          user,
          (nextStatus) => {
            if (active) setAccessStatus(nextStatus);
          },
          (err) => {
            if (active) setFatalDbError(err);
          }
        );
      })
      .catch((err) => {
        if (active) {
          setFatalDbError(err instanceof Error ? err : new Error(String(err)));
        }
      });

    return () => {
      active = false;
      if (unsubAccess) unsubAccess();
    };
  }, [user, needsAuth]);

  useEffect(() => {
    if (!user || needsAuth || accessStatus !== 'approved') return;
    void refreshTelegramStatus();
  }, [user, needsAuth, accessStatus, refreshTelegramStatus]);

  useEffect(() => {
    if (activeTab === 'admin' && !userIsAdmin) {
      setActiveTab('inbox');
    }
  }, [activeTab, userIsAdmin]);

  // Attach real-time Firestore listeners ONLY when Firebase user is authenticated and approved
  useEffect(() => {
    if (!user || needsAuth || accessStatus !== 'approved') {
      setFirestoreReady(false);
      return;
    }

    setLoadingInbox(true);
    let initializedSettings = false;

    const unsubSettings = subscribeWorkspaceSettings(
      user.uid,
      (settings) => {
        setFirestoreReady(true);
        if (settings) {
          setSelectedFolder(
            settings.targetFolderId
              ? {
                  id: settings.targetFolderId,
                  name: settings.targetFolderName,
                  webViewLink: settings.targetFolderWebLink || undefined,
                }
              : null
          );
          setRules((prev) => ({
            ...prev,
            namingRule: settings.namingRule,
            skipDuplicates: settings.skipDuplicates,
          }));
          setLang(settings.language);
          botUsernameRef.current = settings.botUsername;
        } else if (!initializedSettings) {
          initializedSettings = true;
          void saveWorkspaceSettings(user.uid, {
            targetFolderId: '',
            targetFolderName: '',
            targetFolderWebLink: '',
            namingRule: 'original',
            skipDuplicates: true,
            language: lang,
            botUsername: botUsernameRef.current || '',
          }).catch((err) => {
            setFatalDbError(err instanceof Error ? err : new Error(String(err)));
          });
        }
      },
      (err) => {
        setFatalDbError(err);
      }
    );

    const unsubPdfs = subscribePdfRecords(
      user.uid,
      (items) => {
        setInbox(items);
        setLoadingInbox(false);
      },
      (err) => {
        setLoadingInbox(false);
        setFatalDbError(err);
      }
    );

    const unsubActivities = subscribeActivities(
      user.uid,
      (items) => {
        setActivities(items);
      },
      (err) => {
        setFatalDbError(err);
      }
    );

    return () => {
      unsubSettings();
      unsubPdfs();
      unsubActivities();
    };
  }, [user, needsAuth, accessStatus]);

  useEffect(() => {
    if (!needsAuth && accessStatus === 'approved' && selectedFolder) {
      void refreshFolderPdfs();
    } else if (!selectedFolder) {
      setFolderPdfs([]);
    }
  }, [needsAuth, accessStatus, selectedFolder?.id, refreshFolderPdfs]);

  const chats = useMemo<TelegramChatSummary[]>(() => {
    const map = new Map<number, TelegramChatSummary>();
    for (const item of inbox) {
      const existing = map.get(item.chatId);
      if (existing) {
        existing.pdfCount += 1;
      } else {
        map.set(item.chatId, {
          id: item.chatId,
          title: item.chatTitle,
          type: item.chatType,
          pdfCount: 1,
        });
      }
    }
    return Array.from(map.values());
  }, [inbox]);

  const handleLogin = async () => {
    setIsLoggingIn(true);
    setAuthError(null);
    setBannerError(null);
    try {
      const outcome = await googleSignIn();
      if (outcome.status === 'success') {
        setUser(outcome.user);
        setDriveAccessToken(outcome.accessToken);
        setDriveAccount(getDriveAccount());
        setNeedsAuth(false);
        setAccessStatus(isAdminUser(outcome.user) ? 'approved' : 'checking');
      } else if (outcome.status === 'cancelled') {
        setAuthError(copyText.signInCancelled);
      } else if (outcome.status === 'blocked') {
        setAuthError(copyText.signInBlocked);
      }
    } catch (err) {
      setAuthError(
        err instanceof Error ? err.message : copyText.signInCancelled
      );
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleSwitchDriveAccount = async (openPickerAfter = true) => {
    setSwitchingDriveAccount(true);
    setBannerError(null);
    try {
      const prevEmail = (driveAccount?.email || user?.email || '').trim().toLowerCase();
      const outcome = await switchDriveAccount();
      if (outcome.status === 'success') {
        setDriveAccessToken(outcome.accessToken);
        setDriveAccount(outcome.driveAccount);
        const nextEmail = outcome.driveAccount.email.trim().toLowerCase();
        if (nextEmail && nextEmail !== prevEmail) {
          setSelectedFolder(null);
          setFolderPdfs([]);
          setRules((prev) => ({ ...prev, autoSyncEnabled: false }));
          await persistSettingsToFirestore({ folder: null });
        } else {
          await refreshFolderPdfs();
        }
        void addActivity(
          'folder_create',
          'Google Drive Account Switched',
          outcome.driveAccount.email || 'Connected Drive account',
          'success'
        );
        if (openPickerAfter) {
          setFolderPickerOpen(true);
        }
      } else if (outcome.status === 'cancelled') {
        setBannerError(copyText.signInCancelled);
      } else if (outcome.status === 'blocked') {
        setBannerError(copyText.signInBlocked);
      }
    } catch (err) {
      setBannerError(
        err instanceof Error ? err.message : 'Unable to switch Google Drive account.'
      );
    } finally {
      setSwitchingDriveAccount(false);
    }
  };

  const handleLogout = async () => {
    setRules((prev) => ({ ...prev, autoSyncEnabled: false }));
    await logout();
    setUser(null);
    setDriveAccessToken(null);
    setDriveAccount(null);
    setNeedsAuth(true);
    setAccessStatus('checking');
    setActiveTab('inbox');
    setTgStatus({
      connected: false,
      source: 'none',
      bot: null,
      lastSyncedAt: null,
      inboxCount: 0,
    });
    setFolderPdfs([]);
    setInbox([]);
    setActivities([]);
    setSelectedFolder(null);
    setTelegramError(null);
  };

  const handleSyncTelegram = useCallback(
    async (clearWebhook = false): Promise<TelegramPdfItem[]> => {
      setSyncingTelegram(true);
      setBannerError(null);
      setTelegramError(null);
      try {
        const res = await apiFetch('/api/telegram/sync', {
          method: 'POST',
          body: JSON.stringify({ clearWebhook }),
        });
        const data = (await res.json()) as {
          newCount?: number;
          items?: TelegramPdfItem[];
          lastSyncedAt?: string;
          error?: string;
          code?: string;
        };

        if (res.status === 409 && data.code === 'WEBHOOK_CONFLICT') {
          const msg = data.error || 'Webhook conflict detected.';
          setTgStatus((prev) => ({ ...prev, webhookActive: true }));
          setBannerError(msg);
          setTelegramError(msg);
          return [];
        }

        if (!res.ok) {
          throw new Error(data.error || 'Sync failed.');
        }

        const syncedItems = data.items || [];
        if (user && syncedItems.length > 0) {
          await syncTelegramPdfsToFirestore(user.uid, syncedItems);
        }

        setTgStatus((prev) => ({
          ...prev,
          webhookActive: false,
          lastSyncedAt: data.lastSyncedAt || new Date().toISOString(),
          inboxCount: syncedItems.length,
        }));
        setTelegramError(null);

        if ((data.newCount || 0) > 0) {
          void addActivity(
            'sync',
            `+${data.newCount} Telegram PDF(s)`,
            'Captured from Telegram updates and synced to Firebase',
            'success'
          );
        }
        return syncedItems;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unable to sync Telegram.';
        setBannerError(message);
        setTelegramError(message);
        return [];
      } finally {
        setSyncingTelegram(false);
      }
    },
    [apiFetch, user, addActivity]
  );

  const handleConnectBot = async (botToken: string) => {
    const res = await apiFetch('/api/telegram/connect', {
      method: 'POST',
      body: JSON.stringify({ botToken }),
    });
    const data = (await res.json()) as TelegramStatusResponse & { error?: string };
    if (!res.ok) {
      throw new Error(data.error || 'Failed to verify bot token.');
    }
    setTgStatus(data);
    setTelegramError(null);
    if (data.bot?.username) {
      botUsernameRef.current = data.bot.username;
      await persistSettingsToFirestore({ botUsername: data.bot.username });
    }
    void addActivity(
      'sync',
      'Telegram Bot Connected',
      `@${data.bot?.username || 'bot'}`,
      'success'
    );
    await handleSyncTelegram(false);
  };

  const handleDisconnectBot = async () => {
    await apiFetch('/api/telegram/disconnect', { method: 'POST' });
    setTgStatus({
      connected: false,
      source: 'none',
      bot: null,
      lastSyncedAt: null,
      inboxCount: 0,
    });
    setTelegramError(null);
    botUsernameRef.current = '';
    await persistSettingsToFirestore({ botUsername: '' });
    setRules((prev) => ({ ...prev, autoSyncEnabled: false }));
    await refreshTelegramStatus();
  };

  const handleConnectSharedBot = async (botToken: string) => {
    const res = await apiFetch('/api/telegram/connect', {
      method: 'POST',
      body: JSON.stringify({ botToken, shareWithApproved: true }),
    });
    const data = (await res.json()) as TelegramStatusResponse & { error?: string };
    if (!res.ok) {
      throw new Error(data.error || 'Failed to verify shared bot token.');
    }
    setTgStatus(data);
    setTelegramError(null);
    if (data.bot?.username) {
      botUsernameRef.current = data.bot.username;
      await persistSettingsToFirestore({ botUsername: data.bot.username });
    }
    void addActivity(
      'sync',
      'Shared Telegram Bot Connected',
      `@${data.bot?.username || 'bot'}`,
      'success'
    );
  };

  const handleDisconnectSharedBot = async () => {
    await apiFetch('/api/telegram/disconnect', {
      method: 'POST',
      body: JSON.stringify({ scope: 'shared' }),
    });
    setTelegramError(null);
    setRules((prev) => ({ ...prev, autoSyncEnabled: false }));
    await refreshTelegramStatus();
  };

  const handleClearWebhookAndSync = async () => {
    const res = await apiFetch('/api/telegram/clear-webhook', { method: 'POST' });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok) {
      const msg = data.error || 'Unable to clear webhook.';
      setTelegramError(msg);
      throw new Error(msg);
    }
    setTgStatus((prev) => ({ ...prev, webhookActive: false }));
    setTelegramError(null);
    await handleSyncTelegram(true);
  };

  const uploadSinglePdfToDrive = useCallback(
    async (item: TelegramPdfItem): Promise<boolean> => {
      const token = getAccessToken();
      if (!token) {
        handleAuthExpired();
        return false;
      }
      if (!selectedFolder) {
        setBannerError(copyText.selectFolderFirstWarning);
        setFolderPickerOpen(true);
        return false;
      }

      setUploadingKeys((prev) => new Set(prev).add(item.key));
      setBannerError(null);
      try {
        const targetFileName = formatTargetFileName(item, rules.namingRule);
        const res = await apiFetch('/api/drive/upload-telegram-pdf', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            itemKey: item.key,
            fileId: item.fileId,
            fileUniqueId: item.fileUniqueId,
            folderId: selectedFolder.id,
            folderName: selectedFolder.name,
            targetFileName,
            skipDuplicates: rules.skipDuplicates,
            chatTitle: item.chatTitle,
          }),
        });

        if (res.status === 401) {
          handleAuthExpired();
          return false;
        }

        const data = (await res.json()) as {
          duplicate?: boolean;
          file?: { id: string; name: string; webViewLink?: string; createdTime?: string };
          error?: string;
        };

        if (!res.ok || !data.file) {
          throw new Error(data.error || 'Failed to upload PDF to Google Drive.');
        }

        if (user) {
          await markPdfSavedInFirestore(
            user.uid,
            item,
            data.file,
            selectedFolder.id,
            selectedFolder.name
          );
        }

        void addActivity(
          'upload',
          targetFileName,
          data.duplicate
            ? `Skipped duplicate in "${selectedFolder.name}"`
            : `Saved to "${selectedFolder.name}"`,
          'success'
        );
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Upload failed';
        setBannerError(message);
        void addActivity('error', item.fileName, message, 'error');
        return false;
      } finally {
        setUploadingKeys((prev) => {
          const next = new Set(prev);
          next.delete(item.key);
          return next;
        });
      }
    },
    [
      apiFetch,
      user,
      selectedFolder,
      rules.namingRule,
      rules.skipDuplicates,
      handleAuthExpired,
      copyText.selectFolderFirstWarning,
      addActivity,
    ]
  );

  useEffect(() => {
    if (
      !rules.autoSyncEnabled ||
      needsAuth ||
      accessStatus !== 'approved' ||
      !tgStatus.connected ||
      !selectedFolder
    ) {
      return;
    }

    const runAutoCycle = async () => {
      if (autoSyncBusyRef.current) return;
      autoSyncBusyRef.current = true;
      try {
        await handleSyncTelegram(false);
        const pendingItems = inbox.filter((item) => {
          if (item.driveFileId && item.uploadedFolderId === selectedFolder.id) return false;
          if (
            rules.allowedChatIds.length > 0 &&
            !rules.allowedChatIds.includes(item.chatId)
          ) {
            return false;
          }
          return true;
        });

        let uploadedAny = false;
        for (const item of pendingItems) {
          const ok = await uploadSinglePdfToDrive(item);
          if (ok) uploadedAny = true;
        }
        if (uploadedAny) {
          await refreshFolderPdfs();
        }
      } finally {
        autoSyncBusyRef.current = false;
      }
    };

    const intervalId = window.setInterval(
      () => void runAutoCycle(),
      rules.pollIntervalSeconds * 1000
    );
    return () => window.clearInterval(intervalId);
  }, [
    rules.autoSyncEnabled,
    rules.pollIntervalSeconds,
    rules.allowedChatIds,
    needsAuth,
    accessStatus,
    tgStatus.connected,
    selectedFolder,
    inbox,
    handleSyncTelegram,
    uploadSinglePdfToDrive,
    refreshFolderPdfs,
  ]);

  const handleDownloadLocal = async (item: TelegramPdfItem) => {
    setDownloadingKeys((prev) => new Set(prev).add(item.key));
    setBannerError(null);
    try {
      const targetName = formatTargetFileName(item, rules.namingRule);
      const res = await apiFetch(
        `/api/telegram/download/${encodeURIComponent(item.fileId)}?name=${encodeURIComponent(targetName)}`
      );
      if (!res.ok) {
        const errJson = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errJson.error || 'Download failed.');
      }

      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = targetName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);

      void addActivity('download', targetName, 'Downloaded PDF locally', 'success');
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : 'Download failed.');
    } finally {
      setDownloadingKeys((prev) => {
        const next = new Set(prev);
        next.delete(item.key);
        return next;
      });
    }
  };

  const handleBatchUpload = async (itemsToUpload: TelegramPdfItem[]) => {
    if (!selectedFolder) {
      setBannerError(copyText.selectFolderFirstWarning);
      setFolderPickerOpen(true);
      return;
    }
    if (itemsToUpload.length === 0) return;

    setBatchUploading(true);
    for (const item of itemsToUpload) {
      const ok = await uploadSinglePdfToDrive(item);
      if (!ok && !getAccessToken()) break;
    }
    setBatchUploading(false);
    setSelectedKeys(new Set());
    await refreshFolderPdfs();
  };

  const handleConfirmDeleteDriveFile = async () => {
    const token = getAccessToken();
    if (!token || !pendingDeleteFile) return;
    setDeletingFile(true);
    try {
      await trashDriveFile(token, pendingDeleteFile.id);
      void addActivity(
        'folder_delete',
        pendingDeleteFile.name,
        `Moved to Trash from "${selectedFolder?.name || 'Drive'}"`,
        'warning'
      );
      setPendingDeleteFile(null);
      await refreshFolderPdfs();
    } catch (err) {
      if (err instanceof DriveAuthExpiredError) {
        setPendingDeleteFile(null);
        handleAuthExpired();
        return;
      }
      setBannerError(err instanceof Error ? err.message : 'Failed to delete Drive file.');
      setPendingDeleteFile(null);
    } finally {
      setDeletingFile(false);
    }
  };

  const handleConfirmRemoveInboxRecord = async () => {
    if (!user || !pendingRemoveInboxItem) return;
    setRemovingInboxItem(true);
    try {
      await removePdfRecordFromFirestore(user.uid, pendingRemoveInboxItem.key);
      setPendingRemoveInboxItem(null);
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : 'Failed to remove record.');
      setPendingRemoveInboxItem(null);
    } finally {
      setRemovingInboxItem(false);
    }
  };

  const handleConfirmClearActivities = async () => {
    if (!user || activities.length === 0) return;
    setClearingActivity(true);
    try {
      await clearRealtimeActivities(
        user.uid,
        activities.map((a) => a.id)
      );
      setPendingClearActivity(false);
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : 'Failed to clear activity log.');
      setPendingClearActivity(false);
    } finally {
      setClearingActivity(false);
    }
  };

  const filteredInbox = useMemo(() => {
    return inbox.filter((item) => {
      const isSaved = Boolean(
        item.driveFileId && (!selectedFolder || item.uploadedFolderId === selectedFolder.id)
      );
      if (inboxFilter === 'pending' && isSaved) return false;
      if (inboxFilter === 'saved' && !isSaved) return false;
      if (chatFilter !== 'all' && String(item.chatId) !== chatFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const matchesName = item.fileName.toLowerCase().includes(q);
        const matchesChat = item.chatTitle.toLowerCase().includes(q);
        const matchesSender = item.senderName.toLowerCase().includes(q);
        if (!matchesName && !matchesChat && !matchesSender) return false;
      }
      return true;
    });
  }, [inbox, inboxFilter, chatFilter, searchQuery, selectedFolder]);

  const pendingItemsInView = useMemo(
    () =>
      filteredInbox.filter(
        (item) => !(item.driveFileId && selectedFolder && item.uploadedFolderId === selectedFolder.id)
      ),
    [filteredInbox, selectedFolder]
  );

  const selectedItems = useMemo(
    () => filteredInbox.filter((item) => selectedKeys.has(item.key)),
    [filteredInbox, selectedKeys]
  );

  const savedCount = useMemo(
    () =>
      inbox.filter(
        (item) => item.driveFileId && (!selectedFolder || item.uploadedFolderId === selectedFolder.id)
      ).length,
    [inbox, selectedFolder]
  );

  const toggleSelectAll = () => {
    if (selectedKeys.size === filteredInbox.length && filteredInbox.length > 0) {
      setSelectedKeys(new Set());
    } else {
      setSelectedKeys(new Set(filteredInbox.map((i) => i.key)));
    }
  };

  const toggleSelectItem = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleToggleAutoSync = () => {
    if (rules.autoSyncEnabled) {
      setRules((prev) => ({ ...prev, autoSyncEnabled: false }));
      return;
    }
    if (!selectedFolder) {
      setBannerError(copyText.selectFolderFirstWarning);
      setFolderPickerOpen(true);
      return;
    }
    setPendingAutoSyncConfirm(true);
  };

  const handleLanguageChange = (nextLang: Language) => {
    setLang(nextLang);
    if (user && !needsAuth && accessStatus === 'approved') {
      void persistSettingsToFirestore({ language: nextLang });
    }
  };

  const handleNamingRuleChange = (nextRule: NamingRule) => {
    setRules((prev) => ({ ...prev, namingRule: nextRule }));
    void persistSettingsToFirestore({ namingRule: nextRule });
  };

  const handleSkipDuplicatesChange = (checked: boolean) => {
    setRules((prev) => ({ ...prev, skipDuplicates: checked }));
    void persistSettingsToFirestore({ skipDuplicates: checked });
  };

  const navItems: Array<[ActiveTab, string]> = [
    ['inbox', copyText.navInbox],
    ['folder', copyText.navFolder],
    ['rules', copyText.navRules],
    ['activity', copyText.navActivity],
    ...(userIsAdmin ? ([['admin', copyText.navAdmin]] as Array<[ActiveTab, string]>) : []),
  ];

  const tgConnectionState: 'active' | 'idle' | 'error' =
    telegramError || tgStatus.webhookActive
      ? 'error'
      : tgStatus.connected
        ? 'active'
        : 'idle';

  const tgConnectionTitle =
    tgConnectionState === 'error'
      ? `${copyText.tgIndicatorError}${
          telegramError
            ? `: ${telegramError}`
            : tgStatus.webhookActive
              ? `: ${copyText.webhookTitle}`
              : ''
        }`
      : tgConnectionState === 'active'
        ? `${copyText.tgIndicatorActive}${
            tgStatus.bot?.username ? ` (@${tgStatus.bot.username})` : ''
          }`
        : copyText.tgIndicatorIdle;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Top Bar Contract: 3 zones, gap-8, single-line controls */}
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-16 max-w-[1400px] items-center justify-between gap-8 px-6">
          <button
            type="button"
            onClick={() => setActiveTab('inbox')}
            className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-blue-600"
          >
            {copyText.brand}
          </button>

          <nav
            aria-label="Primary navigation"
            className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600"
          >
            {!needsAuth &&
              isApproved &&
              navItems.map(([tabId, label]) => (
                <button
                  key={tabId}
                  type="button"
                  onClick={() => setActiveTab(tabId)}
                  className={`relative py-2 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-blue-600 ${
                    activeTab === tabId
                      ? 'font-semibold text-slate-900'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {label}
                  {activeTab === tabId && (
                    <span className="absolute inset-x-0 -bottom-[17px] h-0.5 bg-blue-600" />
                  )}
                </button>
              ))}
          </nav>

          <div className="flex items-center shrink-0">
            {needsAuth ? (
              <GoogleSignInButton
                onClick={handleLogin}
                disabled={isLoggingIn}
                label={copyText.signInGoogle}
              />
            ) : !isApproved ? (
              <button
                type="button"
                onClick={handleLogout}
                className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 hover:text-red-600 whitespace-nowrap shrink-0"
              >
                <LogOut className="h-4 w-4" />
                <span>{copyText.signOut}</span>
              </button>
            ) : (
              <button
                type="button"
                title={tgConnectionTitle}
                aria-label={`${syncingTelegram ? copyText.syncing : copyText.syncNow} (${tgConnectionTitle})`}
                onClick={() => {
                  if (!tgStatus.connected && telegramError) {
                    void refreshTelegramStatus();
                    return;
                  }
                  void handleSyncTelegram(false);
                }}
                disabled={(!tgStatus.connected && !telegramError) || syncingTelegram}
                className={`inline-flex min-h-[40px] items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 whitespace-nowrap shrink-0 ${
                  tgConnectionState === 'error'
                    ? 'bg-red-600 text-white hover:bg-red-700 focus-visible:outline-red-600 disabled:opacity-60'
                    : tgConnectionState === 'active'
                      ? 'bg-blue-600 text-white hover:bg-blue-700 focus-visible:outline-blue-600 disabled:opacity-60'
                      : 'border border-slate-200 bg-slate-100 text-slate-500 cursor-not-allowed'
                }`}
              >
                {tgConnectionState === 'error' ? (
                  <AlertCircle
                    className="h-4 w-4 shrink-0 text-white"
                    aria-hidden="true"
                  />
                ) : tgConnectionState === 'active' ? (
                  <span
                    className="relative flex h-2.5 w-2.5 shrink-0"
                    aria-hidden="true"
                  >
                    <span className="absolute inline-flex h-full w-full motion-safe:animate-ping rounded-full bg-emerald-300 opacity-75" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400 ring-1 ring-white/80" />
                  </span>
                ) : (
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full bg-slate-400 ring-1 ring-slate-300"
                    aria-hidden="true"
                  />
                )}
                <RefreshCw
                  className={`h-4 w-4 shrink-0 ${syncingTelegram ? 'animate-spin' : ''}`}
                />
                <span>{syncingTelegram ? copyText.syncing : copyText.syncNow}</span>
              </button>
            )}
          </div>
        </div>
      </header>

      {needsAuth ? (
        <main className="mx-auto max-w-[1200px] px-6 py-12 lg:py-16">
          <div className="grid items-stretch gap-8 lg:grid-cols-12">
            <div className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-8 lg:col-span-7">
              <div>
                <h1 className="text-balance text-2xl font-bold leading-snug tracking-tight text-slate-900 sm:text-3xl">
                  {copyText.heroTitle}
                </h1>
                <p className="mt-4 max-w-2xl text-base leading-relaxed text-slate-600">
                  {copyText.heroSubtitle}
                </p>

                {authError && (
                  <div className="mt-5 flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{authError}</span>
                  </div>
                )}

                <div className="mt-8 flex flex-wrap items-center gap-4">
                  <GoogleSignInButton
                    onClick={handleLogin}
                    disabled={isLoggingIn}
                    label={user ? copyText.reconnectDrive : copyText.signInGoogle}
                  />
                  <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1">
                    <button
                      type="button"
                      onClick={() => handleLanguageChange('my')}
                      className={`min-h-[32px] rounded-md px-3 text-xs font-medium transition-colors whitespace-nowrap ${
                        lang === 'my'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      မြန်မာ
                    </button>
                    <button
                      type="button"
                      onClick={() => handleLanguageChange('en')}
                      className={`min-h-[32px] rounded-md px-3 text-xs font-medium transition-colors whitespace-nowrap ${
                        lang === 'en'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      English
                    </button>
                  </div>
                </div>
              </div>

              <div className="mt-10 border-t border-slate-100 pt-6 text-xs text-slate-500">
                <span>Google Drive REST API v3</span>
                <span className="mx-2" aria-hidden="true">
                  ·
                </span>
                <span>Telegram Bot API</span>
                <span className="mx-2" aria-hidden="true">
                  ·
                </span>
                <span>Cloud Firestore Realtime Sync</span>
              </div>
            </div>

            <div className="flex flex-col justify-between divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white lg:col-span-5">
              <div className="p-6">
                <h2 className="text-sm font-semibold text-slate-900">
                  {copyText.step1Title}
                </h2>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
                  {copyText.step1Desc}
                </p>
              </div>
              <div className="p-6">
                <h2 className="text-sm font-semibold text-slate-900">
                  {copyText.step2Title}
                </h2>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
                  {copyText.step2Desc}
                </p>
              </div>
              <div className="p-6">
                <h2 className="text-sm font-semibold text-slate-900">
                  {copyText.step3Title}
                </h2>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
                  {copyText.step3Desc}
                </p>
              </div>
            </div>
          </div>
        </main>
      ) : !isApproved ? (
        <main className="mx-auto max-w-lg px-6 py-16">
          <div className="rounded-xl border border-slate-200 bg-white p-8">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-slate-200 bg-slate-50">
              {accessStatus === 'checking' ? (
                <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
              ) : accessStatus === 'revoked' ? (
                <ShieldX className="h-6 w-6 text-red-600" />
              ) : (
                <Clock className="h-6 w-6 text-amber-600" />
              )}
            </div>

            <h1 className="mt-5 text-xl font-bold tracking-tight text-slate-900">
              {accessStatus === 'checking'
                ? copyText.checkingApprovalLive
                : accessStatus === 'revoked'
                  ? copyText.revokedAccessTitle
                  : copyText.pendingApprovalTitle}
            </h1>

            <p className="mt-2.5 text-sm leading-relaxed text-slate-600">
              {accessStatus === 'revoked'
                ? copyText.revokedAccessDesc
                : copyText.pendingApprovalDesc}
            </p>

            {user?.email && (
              <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-xs font-medium text-slate-500">Google Account</p>
                <p className="mt-0.5 font-mono text-sm font-semibold text-slate-900">
                  {user.email}
                </p>
              </div>
            )}

            <p className="mt-4 text-xs text-slate-500">{copyText.checkingApprovalLive}</p>

            <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-5">
              <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1">
                <button
                  type="button"
                  onClick={() => handleLanguageChange('my')}
                  className={`min-h-[32px] rounded-md px-3 text-xs font-medium transition-colors whitespace-nowrap ${
                    lang === 'my'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  မြန်မာ
                </button>
                <button
                  type="button"
                  onClick={() => handleLanguageChange('en')}
                  className={`min-h-[32px] rounded-md px-3 text-xs font-medium transition-colors whitespace-nowrap ${
                    lang === 'en'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  English
                </button>
              </div>

              <button
                type="button"
                onClick={handleLogout}
                className="inline-flex min-h-[38px] items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 hover:text-red-600 whitespace-nowrap"
              >
                <LogOut className="h-3.5 w-3.5" />
                <span>{copyText.signOut}</span>
              </button>
            </div>
          </div>
        </main>
      ) : (
        <div className="mx-auto max-w-[1400px] px-6 py-6">
          {/* Mobile Section Switcher */}
          <div className="mb-4 flex items-center gap-1 overflow-x-auto rounded-lg border border-slate-200 bg-white p-1 md:hidden">
            {navItems.map(([tabId, label]) => (
              <button
                key={tabId}
                type="button"
                onClick={() => setActiveTab(tabId)}
                className={`min-h-[36px] flex-1 rounded-md px-3 text-xs font-medium transition-colors whitespace-nowrap ${
                  activeTab === tabId
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {bannerError && (
            <div className="mb-5 flex items-center justify-between gap-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              <div className="flex items-center gap-2.5">
                <AlertCircle className="h-4 w-4 shrink-0 text-red-600" />
                <span>{bannerError}</span>
              </div>
              <button
                type="button"
                onClick={() => setBannerError(null)}
                className="text-xs font-semibold text-red-700 hover:underline whitespace-nowrap shrink-0"
              >
                {copyText.cancelBtn}
              </button>
            </div>
          )}

          <div className="grid gap-6 lg:grid-cols-[268px_minmax(0,1fr)]">
            {/* Workspace Sidebar */}
            <aside className="space-y-4">
              {/* Target Folder Card */}
              <div className="rounded-xl border border-slate-200 bg-white p-5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-500">
                    {copyText.targetFolder}
                  </span>
                  <FolderOpen className="h-4 w-4 text-slate-400" />
                </div>

                {(driveAccount?.email || user?.email) && (
                  <p className="mt-2 truncate font-mono text-xs text-slate-500">
                    {driveAccount?.email || user?.email}
                  </p>
                )}

                {selectedFolder ? (
                  <div className="mt-2.5">
                    <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                      <Folder className="h-4 w-4 shrink-0 text-blue-600" />
                      <span className="truncate">{selectedFolder.name}</span>
                    </div>
                    <p className="mt-1 font-mono text-xs text-slate-500 tabular-nums">
                      {folderPdfs.length} PDF(s)
                    </p>
                  </div>
                ) : (
                  <p className="mt-2.5 text-sm text-amber-700">
                    {copyText.noFolderSelected}
                  </p>
                )}

                <div className="mt-4 space-y-2">
                  <button
                    type="button"
                    onClick={() => setFolderPickerOpen(true)}
                    className="inline-flex min-h-[40px] w-full items-center justify-center rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-800 transition-colors hover:border-blue-600 hover:bg-white hover:text-blue-600 whitespace-nowrap"
                  >
                    {selectedFolder ? copyText.changeFolder : copyText.selectFolderBtn}
                  </button>
                  <button
                    type="button"
                    disabled={switchingDriveAccount}
                    onClick={() => void handleSwitchDriveAccount(true)}
                    className="inline-flex min-h-[38px] w-full items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:border-blue-600 hover:text-blue-600 disabled:opacity-50 whitespace-nowrap"
                  >
                    {switchingDriveAccount ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ArrowLeftRight className="h-3.5 w-3.5" />
                    )}
                    <span>
                      {switchingDriveAccount
                        ? copyText.switchingDriveAccount
                        : copyText.switchDriveAccount}
                    </span>
                  </button>
                </div>
              </div>

              {/* Connection & Realtime DB Summary */}
              <div className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
                <div className="p-4">
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span>{copyText.telegramBot}</span>
                    <Bot className="h-3.5 w-3.5 text-slate-400" />
                  </div>
                  <p className="mt-1.5 text-sm font-semibold text-slate-900">
                    {tgStatus.connected && tgStatus.bot
                      ? `@${tgStatus.bot.username}`
                      : copyText.notConnected}
                  </p>
                  <p className="mt-1 text-xs text-slate-500 tabular-nums">
                    {inbox.length} PDF · {savedCount} {copyText.savedLabel}
                  </p>
                </div>

                <div className="p-4">
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span>{copyText.realtimeDbLabel}</span>
                    <Database className="h-3.5 w-3.5 text-slate-400" />
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5 text-xs font-medium text-emerald-700">
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                    <span>
                      {firestoreReady ? copyText.realtimeSynced : '...'}
                    </span>
                  </div>
                </div>

                <div className="p-4">
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span>{copyText.languageLabel}</span>
                    <Globe className="h-3.5 w-3.5 text-slate-400" />
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1">
                    <button
                      type="button"
                      onClick={() => handleLanguageChange('my')}
                      className={`min-h-[32px] rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                        lang === 'my'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      မြန်မာ
                    </button>
                    <button
                      type="button"
                      onClick={() => handleLanguageChange('en')}
                      className={`min-h-[32px] rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                        lang === 'en'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      English
                    </button>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-2 p-4">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-semibold text-slate-900">
                      {user?.displayName || 'Google User'}
                    </p>
                    <p className="truncate text-xs text-slate-500">
                      {user?.email || ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleLogout}
                    title={copyText.signOut}
                    aria-label={copyText.signOut}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition-colors hover:bg-slate-50 hover:text-red-600"
                  >
                    <LogOut className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </aside>

            {/* Main Viewport */}
            <main className="min-w-0 space-y-5">
              {activeTab === 'inbox' && (
                <>
                  <BotSetupPanel
                    status={tgStatus}
                    lang={lang}
                    onConnect={handleConnectBot}
                    onDisconnect={handleDisconnectBot}
                    onClearWebhook={handleClearWebhookAndSync}
                  />

                  <div className="rounded-xl border border-slate-200 bg-white">
                    {/* Toolbar */}
                    <div className="flex flex-col gap-3 border-b border-slate-200 p-4 lg:flex-row lg:items-center lg:justify-between">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
                          {(
                            [
                              ['all', `${copyText.filterAll} (${inbox.length})`],
                              [
                                'pending',
                                `${copyText.filterPending} (${Math.max(0, inbox.length - savedCount)})`,
                              ],
                              ['saved', `${copyText.filterSaved} (${savedCount})`],
                            ] as Array<[InboxFilter, string]>
                          ).map(([id, label]) => (
                            <button
                              key={id}
                              type="button"
                              onClick={() => setInboxFilter(id)}
                              className={`min-h-[32px] rounded-md px-3 text-xs font-medium transition-colors whitespace-nowrap tabular-nums ${
                                inboxFilter === id
                                  ? 'bg-white text-slate-900 shadow-xs'
                                  : 'text-slate-600 hover:text-slate-900'
                              }`}
                            >
                              {label}
                            </button>
                          ))}
                        </div>

                        {chats.length > 0 && (
                          <select
                            aria-label={copyText.allChats}
                            value={chatFilter}
                            onChange={(e) => setChatFilter(e.target.value)}
                            className="h-9 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 focus:border-blue-600 focus:outline-none"
                          >
                            <option value="all">{copyText.allChats}</option>
                            {chats.map((c) => (
                              <option key={c.id} value={String(c.id)}>
                                {c.title} ({c.pdfCount})
                              </option>
                            ))}
                          </select>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <div className="relative flex-1 sm:w-56 sm:flex-none">
                          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                          <input
                            type="text"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder={copyText.searchPdfPlaceholder}
                            className="h-9 w-full rounded-lg border border-slate-200 bg-slate-50 pl-8 pr-3 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:bg-white focus:outline-none"
                          />
                        </div>

                        {selectedItems.length > 0 ? (
                          <button
                            type="button"
                            disabled={batchUploading}
                            onClick={() => void handleBatchUpload(selectedItems)}
                            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap shrink-0"
                          >
                            {batchUploading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                            <HardDriveUpload className="h-3.5 w-3.5" />
                            <span>
                              {copyText.saveSelected} ({selectedItems.length})
                            </span>
                          </button>
                        ) : (
                          pendingItemsInView.length > 0 && (
                            <button
                              type="button"
                              disabled={batchUploading}
                              onClick={() => void handleBatchUpload(pendingItemsInView)}
                              className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-800 transition-colors hover:border-blue-600 hover:text-blue-600 disabled:opacity-50 whitespace-nowrap shrink-0"
                            >
                              {batchUploading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                              <HardDriveUpload className="h-3.5 w-3.5" />
                              <span>
                                {copyText.saveAllPending} ({pendingItemsInView.length})
                              </span>
                            </button>
                          )
                        )}
                      </div>
                    </div>

                    {/* Data Table */}
                    {loadingInbox ? (
                      <div className="space-y-2 p-4">
                        {[0, 1, 2, 3].map((idx) => (
                          <div
                            key={idx}
                            className="h-11 w-full animate-pulse rounded-lg bg-slate-100"
                          />
                        ))}
                      </div>
                    ) : filteredInbox.length === 0 ? (
                      <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
                        <FileText className="h-10 w-10 text-slate-300" />
                        <h3 className="mt-3 text-sm font-semibold text-slate-900">
                          {copyText.emptyInboxTitle}
                        </h3>
                        <p className="mt-1.5 max-w-md text-xs leading-relaxed text-slate-500">
                          {copyText.emptyInboxDesc}
                        </p>
                        {tgStatus.connected && (
                          <button
                            type="button"
                            onClick={() => void handleSyncTelegram(false)}
                            disabled={syncingTelegram}
                            className="mt-5 inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-700 whitespace-nowrap"
                          >
                            <RefreshCw
                              className={`h-3.5 w-3.5 ${syncingTelegram ? 'animate-spin' : ''}`}
                            />
                            {copyText.syncNow}
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full border-collapse text-left text-sm">
                          <thead>
                            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-500">
                              <th className="w-10 px-4 py-2.5">
                                <input
                                  type="checkbox"
                                  aria-label="Select all"
                                  checked={
                                    selectedKeys.size === filteredInbox.length &&
                                    filteredInbox.length > 0
                                  }
                                  onChange={toggleSelectAll}
                                  className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-600"
                                />
                              </th>
                              <th className="px-4 py-2.5">{copyText.colFile}</th>
                              <th className="px-4 py-2.5">{copyText.colSource}</th>
                              <th className="px-4 py-2.5 text-right">{copyText.colSize}</th>
                              <th className="px-4 py-2.5">{copyText.colTime}</th>
                              <th className="px-4 py-2.5">{copyText.colStatus}</th>
                              <th className="px-4 py-2.5 text-right">{copyText.colActions}</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {filteredInbox.map((item) => {
                              const isSaved = Boolean(
                                item.driveFileId &&
                                  (!selectedFolder || item.uploadedFolderId === selectedFolder.id)
                              );
                              const isUploading = uploadingKeys.has(item.key);
                              const isDownloading = downloadingKeys.has(item.key);

                              return (
                                <tr
                                  key={item.key}
                                  className="transition-colors hover:bg-slate-50/80"
                                >
                                  <td className="px-4 py-3">
                                    <input
                                      type="checkbox"
                                      aria-label={`Select ${item.fileName}`}
                                      checked={selectedKeys.has(item.key)}
                                      onChange={() => toggleSelectItem(item.key)}
                                      className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-600"
                                    />
                                  </td>
                                  <td className="max-w-[280px] px-4 py-3">
                                    <div className="flex items-center gap-2.5">
                                      <FileText className="h-4 w-4 shrink-0 text-red-600" />
                                      <div className="min-w-0">
                                        <p className="truncate text-xs font-semibold text-slate-900">
                                          {formatTargetFileName(item, rules.namingRule)}
                                        </p>
                                        {item.caption && (
                                          <p className="truncate text-xs text-slate-500">
                                            {item.caption}
                                          </p>
                                        )}
                                      </div>
                                    </div>
                                  </td>
                                  <td className="px-4 py-3">
                                    <div className="text-xs text-slate-700">
                                      <span className="font-medium text-slate-900">
                                        {item.chatTitle}
                                      </span>
                                      <span className="mx-1.5 text-slate-300" aria-hidden="true">
                                        ·
                                      </span>
                                      <span className="text-slate-500">{item.senderName}</span>
                                    </div>
                                  </td>
                                  <td className="px-4 py-3 text-right font-mono text-xs text-slate-600 tabular-nums whitespace-nowrap">
                                    {formatBytes(item.fileSize)}
                                  </td>
                                  <td className="px-4 py-3 font-mono text-xs text-slate-500 tabular-nums whitespace-nowrap">
                                    {formatDateTime(item.postedAt, lang)}
                                  </td>
                                  <td className="px-4 py-3 whitespace-nowrap">
                                    {isSaved ? (
                                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700">
                                        <CheckCircle2 className="h-3.5 w-3.5" />
                                        {copyText.savedLabel}
                                      </span>
                                    ) : (
                                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700">
                                        <Clock className="h-3.5 w-3.5" />
                                        {copyText.pendingLabel}
                                      </span>
                                    )}
                                  </td>
                                  <td className="px-4 py-3 text-right">
                                    <div className="inline-flex items-center justify-end gap-2">
                                      <button
                                        type="button"
                                        onClick={() => void handleDownloadLocal(item)}
                                        disabled={isDownloading}
                                        className="inline-flex min-h-[34px] items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
                                      >
                                        {isDownloading ? (
                                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                          <Download className="h-3.5 w-3.5" />
                                        )}
                                        <span>{copyText.downloadPdf}</span>
                                      </button>

                                      {isSaved && item.driveWebViewLink ? (
                                        <a
                                          href={item.driveWebViewLink}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="inline-flex min-h-[34px] items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800 transition-colors hover:bg-emerald-100 whitespace-nowrap"
                                        >
                                          <span>{copyText.openInDrive}</span>
                                          <ArrowUpRight className="h-3.5 w-3.5" />
                                        </a>
                                      ) : (
                                        <button
                                          type="button"
                                          disabled={isUploading || batchUploading}
                                          onClick={() =>
                                            void uploadSinglePdfToDrive(item).then((ok) => {
                                              if (ok) void refreshFolderPdfs();
                                            })
                                          }
                                          className="inline-flex min-h-[34px] items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
                                        >
                                          {isUploading ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                          ) : (
                                            <HardDriveUpload className="h-3.5 w-3.5" />
                                          )}
                                          <span>
                                            {isUploading ? copyText.saving : copyText.saveToDrive}
                                          </span>
                                        </button>
                                      )}

                                      <button
                                        type="button"
                                        title={copyText.removeRecord}
                                        aria-label={`${copyText.removeRecord} ${item.fileName}`}
                                        onClick={() => setPendingRemoveInboxItem(item)}
                                        className="flex h-[34px] w-[34px] items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-400 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                                      >
                                        <Trash2 className="h-3.5 w-3.5" />
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </>
              )}

              {activeTab === 'folder' && (
                <div className="rounded-xl border border-slate-200 bg-white">
                  <div className="flex flex-col gap-3 border-b border-slate-200 p-5 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h2 className="text-base font-semibold text-slate-900">
                        {copyText.folderViewTitle}
                      </h2>
                      <p className="mt-1 text-xs text-slate-500">
                        {(driveAccount?.email || user?.email) && (
                          <>
                            <span className="font-mono text-slate-700">
                              {driveAccount?.email || user?.email}
                            </span>
                            <span className="mx-1.5 text-slate-300" aria-hidden="true">
                              ·
                            </span>
                          </>
                        )}
                        {selectedFolder
                          ? `${selectedFolder.name} · ${folderPdfs.length} PDF`
                          : copyText.noFolderSelected}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={switchingDriveAccount}
                        onClick={() => void handleSwitchDriveAccount(true)}
                        className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:border-blue-600 hover:text-blue-600 disabled:opacity-50 whitespace-nowrap"
                      >
                        {switchingDriveAccount ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <ArrowLeftRight className="h-3.5 w-3.5" />
                        )}
                        <span>
                          {switchingDriveAccount
                            ? copyText.switchingDriveAccount
                            : copyText.switchDriveAccount}
                        </span>
                      </button>
                      {selectedFolder?.webViewLink && (
                        <a
                          href={selectedFolder.webViewLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 whitespace-nowrap"
                        >
                          <span>{copyText.openInDrive}</span>
                          <ArrowUpRight className="h-3.5 w-3.5" />
                        </a>
                      )}
                      <button
                        type="button"
                        onClick={() => setFolderPickerOpen(true)}
                        className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-700 whitespace-nowrap"
                      >
                        <Folder className="h-3.5 w-3.5" />
                        <span>{copyText.selectFolderBtn}</span>
                      </button>
                    </div>
                  </div>

                  {!selectedFolder ? (
                    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
                      <FolderOpen className="h-10 w-10 text-slate-300" />
                      <p className="mt-3 text-sm font-medium text-slate-700">
                        {copyText.selectFolderFirstWarning}
                      </p>
                    </div>
                  ) : loadingFolderPdfs ? (
                    <div className="space-y-2 p-5">
                      {[0, 1, 2].map((i) => (
                        <div key={i} className="h-11 animate-pulse rounded-lg bg-slate-100" />
                      ))}
                    </div>
                  ) : folderPdfs.length === 0 ? (
                    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
                      <FileText className="h-10 w-10 text-slate-300" />
                      <h3 className="mt-3 text-sm font-semibold text-slate-900">
                        {copyText.folderEmptyTitle}
                      </h3>
                      <p className="mt-1 max-w-md text-xs text-slate-500">
                        {copyText.folderEmptyDesc}
                      </p>
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-100">
                      {folderPdfs.map((file) => (
                        <div
                          key={file.id}
                          className="flex flex-col gap-3 px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div className="flex min-w-0 items-center gap-3">
                            <FileText className="h-4 w-4 shrink-0 text-red-600" />
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-slate-900">
                                {file.name}
                              </p>
                              <p className="mt-0.5 font-mono text-xs text-slate-500 tabular-nums">
                                {formatBytes(file.size)} ·{' '}
                                {formatDateTime(file.createdTime || file.modifiedTime, lang)}
                              </p>
                            </div>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            {file.webViewLink && (
                              <a
                                href={file.webViewLink}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex min-h-[36px] items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 whitespace-nowrap"
                              >
                                <span>{copyText.openInDrive}</span>
                                <ArrowUpRight className="h-3.5 w-3.5" />
                              </a>
                            )}
                            <button
                              type="button"
                              onClick={() => setPendingDeleteFile(file)}
                              className="inline-flex min-h-[36px] items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-red-600 transition-colors hover:border-red-200 hover:bg-red-50 whitespace-nowrap"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              <span>{copyText.moveToTrash}</span>
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'rules' && (
                <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
                  <div className="p-6">
                    <h2 className="text-base font-semibold text-slate-900">
                      {copyText.rulesTitle}
                    </h2>
                  </div>

                  <div className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">
                        {copyText.autoSyncLabel}
                      </p>
                      <p className="mt-1 max-w-xl text-xs leading-relaxed text-slate-500">
                        {copyText.autoSyncDesc}
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={rules.autoSyncEnabled}
                      onClick={handleToggleAutoSync}
                      className={`inline-flex min-h-[40px] items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                        rules.autoSyncEnabled
                          ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                          : 'border border-slate-200 bg-slate-50 text-slate-800 hover:bg-slate-100'
                      }`}
                    >
                      {rules.autoSyncEnabled && <Check className="h-3.5 w-3.5" />}
                      <span>
                        {rules.autoSyncEnabled ? 'Auto-Sync ON (10s)' : 'Auto-Sync OFF'}
                      </span>
                    </button>
                  </div>

                  <div className="p-6">
                    <label className="text-sm font-semibold text-slate-900">
                      {copyText.namingRuleLabel}
                    </label>
                    <div className="mt-3 grid gap-2.5 sm:grid-cols-3">
                      {(
                        [
                          ['original', copyText.namingOriginal],
                          ['date_prefix', copyText.namingDate],
                          ['chat_prefix', copyText.namingChat],
                        ] as Array<[NamingRule, string]>
                      ).map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => handleNamingRuleChange(value)}
                          className={`rounded-lg border p-3.5 text-left text-xs font-medium transition-colors ${
                            rules.namingRule === value
                              ? 'border-blue-600 bg-blue-50/50 text-blue-900'
                              : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">
                        {copyText.skipDuplicatesLabel}
                      </p>
                      <p className="mt-1 max-w-xl text-xs leading-relaxed text-slate-500">
                        {copyText.skipDuplicatesDesc}
                      </p>
                    </div>
                    <input
                      type="checkbox"
                      aria-label={copyText.skipDuplicatesLabel}
                      checked={rules.skipDuplicates}
                      onChange={(e) => handleSkipDuplicatesChange(e.target.checked)}
                      className="h-5 w-5 rounded border-slate-300 text-blue-600 focus:ring-blue-600"
                    />
                  </div>
                </div>
              )}

              {activeTab === 'activity' && (
                <div className="rounded-xl border border-slate-200 bg-white">
                  <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-6 py-4">
                    <h2 className="text-base font-semibold text-slate-900">
                      {copyText.activityTitle}
                    </h2>
                    {activities.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setPendingClearActivity(true)}
                        className="inline-flex min-h-[34px] items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600 whitespace-nowrap shrink-0"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        <span>{copyText.clearActivityBtn}</span>
                      </button>
                    )}
                  </div>
                  {activities.length === 0 ? (
                    <div className="px-6 py-14 text-center text-sm text-slate-500">
                      {copyText.activityEmpty}
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-100">
                      {activities.map((item) => (
                        <div
                          key={item.id}
                          className="flex flex-col gap-1 px-6 py-3.5 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div>
                            <p className="text-sm font-medium text-slate-900">
                              {item.title}
                            </p>
                            <p
                              className={`text-xs ${
                                item.status === 'error'
                                  ? 'text-red-600'
                                  : item.status === 'warning'
                                    ? 'text-amber-700'
                                    : 'text-slate-500'
                              }`}
                            >
                              {item.detail}
                            </p>
                          </div>
                          <span className="font-mono text-xs text-slate-400 tabular-nums whitespace-nowrap">
                            {formatDateTime(item.timestamp, lang)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {activeTab === 'admin' && userIsAdmin && user && (
                <AdminPanel
                  adminUid={user.uid}
                  lang={lang}
                  tgStatus={tgStatus}
                  onConnectSharedBot={handleConnectSharedBot}
                  onDisconnectSharedBot={handleDisconnectSharedBot}
                  onError={setFatalDbError}
                />
              )}
            </main>
          </div>
        </div>
      )}

      <DriveFolderPicker
        open={folderPickerOpen}
        accessToken={driveAccessToken || getAccessToken()}
        driveAccountEmail={driveAccount?.email || user?.email || ''}
        switchingDriveAccount={switchingDriveAccount}
        selectedFolder={selectedFolder}
        lang={lang}
        onSelect={(folder) => {
          setSelectedFolder(folder);
          setBannerError(null);
          void persistSettingsToFirestore({ folder });
        }}
        onSwitchDriveAccount={() => void handleSwitchDriveAccount(false)}
        onAuthExpired={handleAuthExpired}
        onFolderCreatedLog={(folder) =>
          void addActivity(
            'folder_create',
            folder.name,
            'Created target Google Drive folder',
            'success'
          )
        }
        onClose={() => setFolderPickerOpen(false)}
      />

      <ConfirmModal
        open={Boolean(pendingDeleteFile)}
        title={copyText.confirmDeleteTitle}
        body={copyText.confirmDeleteBody.replace('{name}', pendingDeleteFile?.name || '')}
        confirmLabel={copyText.confirmBtn}
        cancelLabel={copyText.cancelBtn}
        destructive
        busy={deletingFile}
        onConfirm={() => void handleConfirmDeleteDriveFile()}
        onCancel={() => setPendingDeleteFile(null)}
      />

      <ConfirmModal
        open={Boolean(pendingRemoveInboxItem)}
        title={copyText.confirmRemoveRecordTitle}
        body={copyText.confirmRemoveRecordBody.replace(
          '{name}',
          pendingRemoveInboxItem?.fileName || ''
        )}
        confirmLabel={copyText.confirmBtn}
        cancelLabel={copyText.cancelBtn}
        destructive
        busy={removingInboxItem}
        onConfirm={() => void handleConfirmRemoveInboxRecord()}
        onCancel={() => setPendingRemoveInboxItem(null)}
      />

      <ConfirmModal
        open={pendingClearActivity}
        title={copyText.confirmClearActivityTitle}
        body={copyText.confirmClearActivityBody}
        confirmLabel={copyText.confirmBtn}
        cancelLabel={copyText.cancelBtn}
        destructive
        busy={clearingActivity}
        onConfirm={() => void handleConfirmClearActivities()}
        onCancel={() => setPendingClearActivity(false)}
      />

      <ConfirmModal
        open={pendingAutoSyncConfirm}
        title={copyText.confirmAutoSyncTitle}
        body={copyText.confirmAutoSyncBody.replace(
          '{folder}',
          selectedFolder?.name || 'Google Drive'
        )}
        confirmLabel={copyText.confirmBtn}
        cancelLabel={copyText.cancelBtn}
        onConfirm={() => {
          setPendingAutoSyncConfirm(false);
          setRules((prev) => ({ ...prev, autoSyncEnabled: true }));
        }}
        onCancel={() => setPendingAutoSyncConfirm(false)}
      />
    </div>
  );
}
