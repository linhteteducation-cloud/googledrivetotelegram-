import { useEffect, useState } from 'react';
import {
  Bot,
  CheckCircle2,
  Clock,
  Loader2,
  MailPlus,
  ShieldCheck,
  ShieldX,
  Trash2,
  UserCheck,
  UserX,
} from 'lucide-react';
import {
  adminDeleteAllowedEmail,
  adminSetEmailStatus,
  PRIMARY_ADMIN_EMAIL,
  subscribeAllAllowedEmails,
  subscribeAllUserAccess,
} from '../lib/firestoreDb';
import { t } from '../lib/i18n';
import type {
  AllowedEmailEntry,
  Language,
  TelegramStatusResponse,
  UserAccessEntry,
} from '../types';
import { ConfirmModal } from './ConfirmModal';

interface AdminPanelProps {
  adminUid: string;
  lang: Language;
  tgStatus: TelegramStatusResponse;
  onConnectSharedBot: (botToken: string) => Promise<void>;
  onDisconnectSharedBot: () => Promise<void>;
  onError: (err: Error) => void;
}

export function AdminPanel({
  adminUid,
  lang,
  tgStatus,
  onConnectSharedBot,
  onDisconnectSharedBot,
  onError,
}: AdminPanelProps) {
  const copyText = t(lang);
  const [allowedEmails, setAllowedEmails] = useState<AllowedEmailEntry[]>([]);
  const [userAccessList, setUserAccessList] = useState<UserAccessEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const [emailInput, setEmailInput] = useState('');
  const [noteInput, setNoteInput] = useState('');
  const [submittingEmail, setSubmittingEmail] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [sharedTokenInput, setSharedTokenInput] = useState('');
  const [connectingBot, setConnectingBot] = useState(false);
  const [botError, setBotError] = useState<string | null>(null);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<{
    email: string;
    matchingUser?: UserAccessEntry | null;
  } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    entry: AllowedEmailEntry;
    matchingUser?: UserAccessEntry | null;
  } | null>(null);

  useEffect(() => {
    let loadedAllowed = false;
    let loadedUsers = false;
    const markReady = () => {
      if (loadedAllowed && loadedUsers) setLoading(false);
    };

    const unsubAllowed = subscribeAllAllowedEmails(
      (items) => {
        setAllowedEmails(items);
        loadedAllowed = true;
        markReady();
      },
      onError
    );
    const unsubUsers = subscribeAllUserAccess(
      (items) => {
        setUserAccessList(items);
        loadedUsers = true;
        markReady();
      },
      onError
    );

    return () => {
      unsubAllowed();
      unsubUsers();
    };
  }, [onError]);

  const findMatchingUser = (email: string): UserAccessEntry | null => {
    const normalized = email.trim().toLowerCase();
    return (
      userAccessList.find((u) => u.email.trim().toLowerCase() === normalized) || null
    );
  };

  const handleAddApproveEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = emailInput.trim().toLowerCase();
    if (!trimmed) return;
    setSubmittingEmail(true);
    setFormError(null);
    try {
      await adminSetEmailStatus(
        adminUid,
        trimmed,
        'approved',
        noteInput,
        findMatchingUser(trimmed)
      );
      setEmailInput('');
      setNoteInput('');
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Unable to approve email.');
    } finally {
      setSubmittingEmail(false);
    }
  };

  const handleApproveUserEntry = async (userEntry: UserAccessEntry) => {
    setBusyId(userEntry.uid);
    try {
      await adminSetEmailStatus(adminUid, userEntry.email, 'approved', '', userEntry);
    } finally {
      setBusyId(null);
    }
  };

  const handleConfirmRevoke = async () => {
    if (!pendingRevoke) return;
    setBusyId(pendingRevoke.email);
    try {
      await adminSetEmailStatus(
        adminUid,
        pendingRevoke.email,
        'revoked',
        '',
        pendingRevoke.matchingUser
      );
      setPendingRevoke(null);
    } finally {
      setBusyId(null);
    }
  };

  const handleConfirmDeleteAllowed = async () => {
    if (!pendingDelete) return;
    setBusyId(pendingDelete.entry.emailHash);
    try {
      await adminDeleteAllowedEmail(
        pendingDelete.entry.emailHash,
        pendingDelete.matchingUser
      );
      setPendingDelete(null);
    } finally {
      setBusyId(null);
    }
  };

  const handleSharedBotSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = sharedTokenInput.trim();
    if (!trimmed) return;
    setConnectingBot(true);
    setBotError(null);
    try {
      await onConnectSharedBot(trimmed);
      setSharedTokenInput('');
    } catch (err) {
      setBotError(err instanceof Error ? err.message : 'Failed to connect shared bot.');
    } finally {
      setConnectingBot(false);
    }
  };

  const pendingUsersCount = userAccessList.filter((u) => u.status === 'pending').length;
  const approvedEmailsCount = allowedEmails.filter((e) => e.status === 'approved').length;
  const revokedCount = allowedEmails.filter((e) => e.status === 'revoked').length;

  return (
    <div className="space-y-6">
      {/* Admin Summary Strip */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-semibold text-slate-500">
            {copyText.adminApprovedCount}
          </p>
          <p className="mt-2 font-mono text-2xl font-bold text-slate-900 tabular-nums">
            {approvedEmailsCount}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-semibold text-slate-500">
            {copyText.adminPendingCount}
          </p>
          <p className="mt-2 font-mono text-2xl font-bold text-amber-700 tabular-nums">
            {pendingUsersCount}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-semibold text-slate-500">
            {copyText.adminRevokedCount}
          </p>
          <p className="mt-2 font-mono text-2xl font-bold text-red-600 tabular-nums">
            {revokedCount}
          </p>
        </div>
      </div>

      {/* Pre-Approve Any Email Form */}
      <div className="rounded-xl border border-slate-200 bg-white p-6">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-blue-200 bg-blue-50 text-blue-600">
            <MailPlus className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              {copyText.adminApproveFormTitle}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              {copyText.adminApproveFormDesc}
            </p>
          </div>
        </div>

        <form
          onSubmit={handleAddApproveEmail}
          className="mt-5 grid gap-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto]"
        >
          <input
            type="email"
            required
            value={emailInput}
            onChange={(e) => setEmailInput(e.target.value)}
            placeholder={copyText.adminEmailPlaceholder}
            className="h-10 rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:bg-white focus:outline-none"
          />
          <input
            type="text"
            maxLength={200}
            value={noteInput}
            onChange={(e) => setNoteInput(e.target.value)}
            placeholder={copyText.adminNotePlaceholder}
            className="h-10 rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:bg-white focus:outline-none"
          />
          <button
            type="submit"
            disabled={!emailInput.trim() || submittingEmail}
            className="inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            {submittingEmail && <Loader2 className="h-4 w-4 animate-spin" />}
            <span>{copyText.adminApproveBtn}</span>
          </button>
        </form>
        {formError && <p className="mt-2 text-xs font-medium text-red-600">{formError}</p>}
      </div>

      {/* Shared Telegram Bot for Approved Emails */}
      <div className="rounded-xl border border-slate-200 bg-white p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-700">
              <Bot className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                {copyText.adminSharedBotTitle}
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-slate-500">
                {copyText.adminSharedBotDesc}
              </p>
            </div>
          </div>

          {tgStatus.connected && tgStatus.source === 'shared' && tgStatus.bot && (
            <div className="flex items-center gap-3 shrink-0">
              <span className="font-mono text-xs font-semibold text-emerald-700">
                @{tgStatus.bot.username}
              </span>
              <button
                type="button"
                onClick={() => void onDisconnectSharedBot()}
                className="min-h-[36px] rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 whitespace-nowrap"
              >
                {copyText.disconnectBot}
              </button>
            </div>
          )}
        </div>

        {!(tgStatus.connected && tgStatus.source === 'shared') && (
          <form onSubmit={handleSharedBotSubmit} className="mt-4 flex flex-col gap-2.5 sm:flex-row">
            <input
              type="password"
              autoComplete="off"
              value={sharedTokenInput}
              onChange={(e) => setSharedTokenInput(e.target.value)}
              placeholder={copyText.botTokenPlaceholder}
              className="h-10 flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:bg-white focus:outline-none"
            />
            <button
              type="submit"
              disabled={!sharedTokenInput.trim() || connectingBot}
              className="inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg border border-slate-200 bg-slate-900 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              {connectingBot && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              <span>{copyText.adminSetSharedBotBtn}</span>
            </button>
          </form>
        )}
        {botError && <p className="mt-2 text-xs font-medium text-red-600">{botError}</p>}
      </div>

      {/* Signed-in Users & Pending Approval Requests */}
      <div className="rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-6 py-4">
          <h3 className="text-base font-semibold text-slate-900">
            {copyText.adminUsersTableTitle}
          </h3>
        </div>
        {loading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-11 animate-pulse rounded-lg bg-slate-100" />
            ))}
          </div>
        ) : userAccessList.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-slate-500">
            {copyText.adminNoUsers}
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {userAccessList.map((entry) => {
              const isSelfAdmin = entry.email.toLowerCase() === PRIMARY_ADMIN_EMAIL;
              const isBusy = busyId === entry.uid || busyId === entry.email;

              return (
                <div
                  key={entry.uid}
                  className="flex flex-col gap-3 px-6 py-3.5 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-semibold text-slate-900">
                        {entry.displayName || entry.email}
                      </span>
                      <span className="text-slate-300" aria-hidden="true">
                        ·
                      </span>
                      <span className="font-mono text-xs text-slate-600">{entry.email}</span>
                      {isSelfAdmin && (
                        <>
                          <span className="text-slate-300" aria-hidden="true">
                            ·
                          </span>
                          <span className="text-xs font-semibold text-blue-700">Admin</span>
                        </>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-xs">
                      {entry.status === 'approved' ? (
                        <span className="inline-flex items-center gap-1 font-medium text-emerald-700">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          {copyText.adminStatusApproved}
                        </span>
                      ) : entry.status === 'revoked' ? (
                        <span className="inline-flex items-center gap-1 font-medium text-red-600">
                          <ShieldX className="h-3.5 w-3.5" />
                          {copyText.adminStatusRevoked}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 font-medium text-amber-700">
                          <Clock className="h-3.5 w-3.5" />
                          {copyText.adminStatusPending}
                        </span>
                      )}
                    </div>
                  </div>

                  {!isSelfAdmin && (
                    <div className="flex items-center gap-2 shrink-0">
                      {entry.status !== 'approved' && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleApproveUserEntry(entry)}
                          className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-50 whitespace-nowrap"
                        >
                          <UserCheck className="h-3.5 w-3.5" />
                          <span>{copyText.adminApproveBtn}</span>
                        </button>
                      )}
                      {entry.status !== 'revoked' && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() =>
                            setPendingRevoke({ email: entry.email, matchingUser: entry })
                          }
                          className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-red-600 transition-colors hover:border-red-200 hover:bg-red-50 disabled:opacity-50 whitespace-nowrap"
                        >
                          <UserX className="h-3.5 w-3.5" />
                          <span>{copyText.adminRevokeBtn}</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Pre-Approved Allowlist Table */}
      <div className="rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-6 py-4">
          <h3 className="text-base font-semibold text-slate-900">
            {copyText.adminAllowlistTitle}
          </h3>
        </div>
        {allowedEmails.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-slate-500">
            {copyText.adminNoAllowlist}
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {allowedEmails.map((entry) => {
              const matchingUser = findMatchingUser(entry.email);
              const isBusy = busyId === entry.emailHash || busyId === entry.email;

              return (
                <div
                  key={entry.emailHash}
                  className="flex flex-col gap-3 px-6 py-3.5 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-mono text-xs font-semibold text-slate-900">
                        {entry.email}
                      </span>
                      {entry.note && (
                        <>
                          <span className="text-slate-300" aria-hidden="true">
                            ·
                          </span>
                          <span className="text-xs text-slate-500">{entry.note}</span>
                        </>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-xs">
                      {entry.status === 'approved' ? (
                        <span className="inline-flex items-center gap-1 font-medium text-emerald-700">
                          <ShieldCheck className="h-3.5 w-3.5" />
                          {copyText.adminStatusApproved}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 font-medium text-red-600">
                          <ShieldX className="h-3.5 w-3.5" />
                          {copyText.adminStatusRevoked}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {entry.status === 'revoked' ? (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() =>
                          void adminSetEmailStatus(
                            adminUid,
                            entry.email,
                            'approved',
                            entry.note,
                            matchingUser
                          )
                        }
                        className="inline-flex min-h-[34px] items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-emerald-700 whitespace-nowrap"
                      >
                        <UserCheck className="h-3.5 w-3.5" />
                        <span>{copyText.adminApproveBtn}</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() =>
                          setPendingRevoke({ email: entry.email, matchingUser })
                        }
                        className="inline-flex min-h-[34px] items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-50 whitespace-nowrap"
                      >
                        <UserX className="h-3.5 w-3.5" />
                        <span>{copyText.adminRevokeBtn}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => setPendingDelete({ entry, matchingUser })}
                      aria-label={`${copyText.removeRecord} ${entry.email}`}
                      className="flex h-[34px] w-[34px] items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-400 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ConfirmModal
        open={Boolean(pendingRevoke)}
        title={copyText.adminConfirmRevokeTitle}
        body={copyText.adminConfirmRevokeBody.replace(
          '{email}',
          pendingRevoke?.email || ''
        )}
        confirmLabel={copyText.confirmBtn}
        cancelLabel={copyText.cancelBtn}
        destructive
        busy={Boolean(busyId)}
        onConfirm={() => void handleConfirmRevoke()}
        onCancel={() => setPendingRevoke(null)}
      />

      <ConfirmModal
        open={Boolean(pendingDelete)}
        title={copyText.adminConfirmDeleteTitle}
        body={copyText.adminConfirmDeleteBody.replace(
          '{email}',
          pendingDelete?.entry.email || ''
        )}
        confirmLabel={copyText.confirmBtn}
        cancelLabel={copyText.cancelBtn}
        destructive
        busy={Boolean(busyId)}
        onConfirm={() => void handleConfirmDeleteAllowed()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
