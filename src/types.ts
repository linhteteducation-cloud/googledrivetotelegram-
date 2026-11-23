export type Language = 'my' | 'en';

export interface TelegramBotInfo {
  id: number;
  username: string;
  firstName: string;
}

export interface TelegramChatSummary {
  id: number;
  title: string;
  type: 'private' | 'group' | 'supergroup' | 'channel' | string;
  pdfCount: number;
}

export interface TelegramPdfItem {
  key: string;
  updateId: number;
  messageId: number;
  chatId: number;
  chatTitle: string;
  chatType: string;
  senderName: string;
  fileId: string;
  fileUniqueId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  caption: string;
  postedAt: string;
  driveFileId?: string;
  driveWebViewLink?: string;
  uploadedFolderId?: string;
  uploadedFolderName?: string;
  uploadedAt?: string;
}

export interface TelegramStatusResponse {
  connected: boolean;
  source: 'env' | 'shared' | 'session' | 'none';
  bot: TelegramBotInfo | null;
  lastSyncedAt: string | null;
  webhookActive?: boolean;
  inboxCount: number;
}

export type AccessStatus = 'pending' | 'approved' | 'revoked';

export interface AllowedEmailEntry {
  emailHash: string;
  email: string;
  status: 'approved' | 'revoked';
  note: string;
  addedByUid: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserAccessEntry {
  uid: string;
  email: string;
  emailHash: string;
  displayName: string;
  status: AccessStatus;
  createdAt: string;
  updatedAt: string;
}

export interface DriveFolder {
  id: string;
  name: string;
  parents?: string[];
  modifiedTime?: string;
  webViewLink?: string;
}

export interface DriveFileItem {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  createdTime?: string;
  webViewLink?: string;
  appProperties?: Record<string, string>;
}

export type NamingRule = 'original' | 'date_prefix' | 'chat_prefix';

export interface SyncRuleSettings {
  namingRule: NamingRule;
  skipDuplicates: boolean;
  autoSyncEnabled: boolean;
  pollIntervalSeconds: number;
  allowedChatIds: number[]; // empty means all chats
}

export interface ActivityLogItem {
  id: string;
  timestamp: string;
  action: 'sync' | 'upload' | 'download' | 'folder_create' | 'folder_delete' | 'error';
  title: string;
  detail: string;
  status: 'success' | 'warning' | 'error';
}
