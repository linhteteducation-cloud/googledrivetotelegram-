import { useState } from 'react';
import { Bot, CheckCircle2, ExternalLink, Loader2, Unplug } from 'lucide-react';
import { t } from '../lib/i18n';
import type { Language, TelegramStatusResponse } from '../types';

interface BotSetupPanelProps {
  status: TelegramStatusResponse;
  lang: Language;
  onConnect: (botToken: string) => Promise<void>;
  onDisconnect: () => Promise<void>;
  onClearWebhook: () => Promise<void>;
}

export function BotSetupPanel({
  status,
  lang,
  onConnect,
  onDisconnect,
  onClearWebhook,
}: BotSetupPanelProps) {
  const copyText = t(lang);
  const [tokenInput, setTokenInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [clearingWebhook, setClearingWebhook] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = tokenInput.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      await onConnect(trimmed);
      setTokenInput('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to connect Telegram bot.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleClearWebhook = async () => {
    setClearingWebhook(true);
    setError(null);
    try {
      await onClearWebhook();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear webhook.');
    } finally {
      setClearingWebhook(false);
    }
  };

  if (status.connected && status.bot) {
    return (
      <div className="space-y-4">
        <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700">
              <Bot className="h-5 w-5" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-semibold text-slate-900">
                  {status.bot.firstName}
                </span>
                <span className="text-slate-400" aria-hidden="true">
                  ·
                </span>
                <a
                  href={`https://t.me/${status.bot.username}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-xs text-blue-600 hover:underline"
                >
                  @{status.bot.username}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-xs text-emerald-700">
                <CheckCircle2 className="h-3.5 w-3.5" />
                <span>
                  {copyText.connected}
                  {status.source === 'env' ? ` · ${copyText.envBotActive}` : ''}
                  {status.source === 'shared' ? ` · ${copyText.sharedBotActive}` : ''}
                </span>
              </div>
            </div>
          </div>

          {status.source === 'session' && (
            <button
              type="button"
              onClick={onDisconnect}
              className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 hover:text-red-600 whitespace-nowrap shrink-0"
            >
              <Unplug className="h-3.5 w-3.5" />
              {copyText.disconnectBot}
            </button>
          )}
        </div>

        {status.webhookActive && (
          <div className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-amber-900">
                {copyText.webhookTitle}
              </p>
              <p className="mt-0.5 text-xs text-amber-800">
                {copyText.webhookDesc}
              </p>
            </div>
            <button
              type="button"
              onClick={handleClearWebhook}
              disabled={clearingWebhook}
              className="inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg bg-amber-700 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-amber-800 whitespace-nowrap shrink-0"
            >
              {clearingWebhook && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {copyText.clearWebhookBtn}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6">
      <div className="grid gap-6 lg:grid-cols-12">
        <div className="lg:col-span-6">
          <h3 className="text-base font-semibold text-slate-900">
            {copyText.botGuideTitle}
          </h3>
          <ol className="mt-3 space-y-2.5 text-sm leading-relaxed text-slate-600">
            <li>1. {copyText.botGuide1}</li>
            <li>2. {copyText.botGuide2}</li>
            <li>3. {copyText.botGuide3}</li>
          </ol>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col justify-center lg:col-span-6">
          <label
            htmlFor="telegram-bot-token"
            className="text-xs font-semibold text-slate-700"
          >
            {copyText.botTokenLabel}
          </label>
          <div className="mt-2 flex flex-col gap-2.5 sm:flex-row">
            <input
              id="telegram-bot-token"
              type="password"
              autoComplete="off"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder={copyText.botTokenPlaceholder}
              className="h-10 flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:bg-white focus:outline-none"
            />
            <button
              type="submit"
              disabled={!tokenInput.trim() || submitting}
              className="inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {submitting ? copyText.connectingBot : copyText.connectBot}
            </button>
          </div>
          {error && (
            <p className="mt-2 text-xs font-medium text-red-600">{error}</p>
          )}
        </form>
      </div>
    </div>
  );
}
