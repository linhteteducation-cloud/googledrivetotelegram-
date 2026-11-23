import { useEffect, useState } from 'react';
import {
  Check,
  ChevronRight,
  Folder,
  FolderPlus,
  Loader2,
  Search,
  X,
} from 'lucide-react';
import {
  createDriveFolder,
  DriveAuthExpiredError,
  listDriveFolders,
} from '../lib/drive';
import { t } from '../lib/i18n';
import type { DriveFolder, Language } from '../types';
import { ConfirmModal } from './ConfirmModal';

interface DriveFolderPickerProps {
  open: boolean;
  accessToken: string | null;
  selectedFolder: DriveFolder | null;
  lang: Language;
  onSelect: (folder: DriveFolder) => void;
  onAuthExpired: () => void;
  onFolderCreatedLog: (folder: DriveFolder) => void;
  onClose: () => void;
}

interface BreadcrumbItem {
  id: string;
  name: string;
}

export function DriveFolderPicker({
  open,
  accessToken,
  selectedFolder,
  lang,
  onSelect,
  onAuthExpired,
  onFolderCreatedLog,
  onClose,
}: DriveFolderPickerProps) {
  const copyText = t(lang);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([
    { id: 'root', name: copyText.myDriveRoot },
  ]);
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [newFolderName, setNewFolderName] = useState('');
  const [creating, setCreating] = useState(false);
  const [pendingCreateName, setPendingCreateName] = useState<string | null>(null);

  const currentParent = breadcrumbs[breadcrumbs.length - 1];

  useEffect(() => {
    setBreadcrumbs((prev) => [{ id: 'root', name: copyText.myDriveRoot }, ...prev.slice(1)]);
  }, [copyText.myDriveRoot]);

  const loadFolders = async (parentId: string, query: string) => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const items = await listDriveFolders(accessToken, parentId, query);
      setFolders(items);
    } catch (err) {
      if (err instanceof DriveAuthExpiredError) {
        onAuthExpired();
        return;
      }
      setError(err instanceof Error ? err.message : 'Unable to load Google Drive folders.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open || !accessToken) return;
    const timer = window.setTimeout(() => {
      void loadFolders(currentParent.id, searchQuery);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [open, accessToken, currentParent.id, searchQuery]);

  if (!open) return null;

  const handleOpenFolder = (folder: DriveFolder) => {
    setSearchQuery('');
    setBreadcrumbs((prev) => [...prev, { id: folder.id, name: folder.name }]);
  };

  const handleBreadcrumbClick = (index: number) => {
    setSearchQuery('');
    setBreadcrumbs((prev) => prev.slice(0, index + 1));
  };

  const handleRequestCreate = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newFolderName.trim();
    if (!trimmed) return;
    setPendingCreateName(trimmed);
  };

  const handleConfirmCreate = async () => {
    if (!accessToken || !pendingCreateName) return;
    setCreating(true);
    setError(null);
    try {
      const created = await createDriveFolder(
        accessToken,
        pendingCreateName,
        currentParent.id
      );
      setNewFolderName('');
      setPendingCreateName(null);
      onFolderCreatedLog(created);
      onSelect(created);
      onClose();
    } catch (err) {
      if (err instanceof DriveAuthExpiredError) {
        setPendingCreateName(null);
        onAuthExpired();
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to create folder.');
      setPendingCreateName(null);
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-[1px]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="drive-picker-title"
      >
        <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-slate-200 bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
            <div>
              <h2 id="drive-picker-title" className="text-base font-semibold text-slate-900">
                {copyText.targetFolder}
              </h2>
              <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-slate-500">
                {breadcrumbs.map((crumb, idx) => (
                  <span key={crumb.id} className="inline-flex items-center gap-1">
                    {idx > 0 && <ChevronRight className="h-3.5 w-3.5 text-slate-400" />}
                    <button
                      type="button"
                      onClick={() => handleBreadcrumbClick(idx)}
                      className={`rounded px-1 py-0.5 transition-colors hover:bg-slate-100 hover:text-slate-900 ${
                        idx === breadcrumbs.length - 1
                          ? 'font-semibold text-slate-900'
                          : 'text-slate-600'
                      }`}
                    >
                      {crumb.name}
                    </button>
                  </span>
                ))}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
              aria-label={copyText.cancelBtn}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="border-b border-slate-200 px-6 py-3.5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={copyText.searchFolders}
                className="h-10 w-full rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:bg-white focus:outline-none"
              />
            </div>
          </div>

          <div className="min-h-[260px] flex-1 overflow-y-auto px-6 py-3">
            {error && (
              <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
                {error}
              </div>
            )}

            {loading ? (
              <div className="space-y-2 py-2">
                {[0, 1, 2, 3, 4].map((row) => (
                  <div
                    key={row}
                    className="h-11 w-full animate-pulse rounded-lg bg-slate-100"
                  />
                ))}
              </div>
            ) : folders.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Folder className="h-8 w-8 text-slate-300" />
                <p className="mt-2 text-sm font-medium text-slate-600">
                  {copyText.noFoldersFound}
                </p>
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {folders.map((folder) => {
                  const isSelected = selectedFolder?.id === folder.id;
                  return (
                    <div
                      key={folder.id}
                      className="flex items-center justify-between gap-3 py-2.5"
                    >
                      <button
                        type="button"
                        onClick={() => handleOpenFolder(folder)}
                        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-slate-50"
                      >
                        <Folder className="h-4 w-4 shrink-0 text-slate-500" />
                        <span className="truncate text-sm font-medium text-slate-900">
                          {folder.name}
                        </span>
                      </button>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleOpenFolder(folder)}
                          className="min-h-[36px] rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 whitespace-nowrap"
                        >
                          {copyText.openFolder}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            onSelect(folder);
                            onClose();
                          }}
                          className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                            isSelected
                              ? 'bg-emerald-600 text-white'
                              : 'border border-slate-200 bg-white text-slate-800 hover:border-blue-600 hover:text-blue-600'
                          }`}
                        >
                          {isSelected && <Check className="h-3.5 w-3.5" />}
                          {copyText.useThisFolder}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <form
            onSubmit={handleRequestCreate}
            className="flex flex-col gap-2 border-t border-slate-200 bg-slate-50 px-6 py-4 sm:flex-row sm:items-center"
          >
            <div className="flex flex-1 items-center gap-2">
              <FolderPlus className="h-4 w-4 shrink-0 text-slate-500" />
              <input
                type="text"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder={copyText.newFolderPlaceholder}
                className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
              />
            </div>
            <button
              type="submit"
              disabled={!newFolderName.trim() || creating}
              className="inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              {creating && <Loader2 className="h-4 w-4 animate-spin" />}
              {copyText.createNewFolder}
            </button>
          </form>
        </div>
      </div>

      <ConfirmModal
        open={Boolean(pendingCreateName)}
        title={copyText.confirmCreateFolderTitle}
        body={copyText.confirmCreateFolderBody.replace('{name}', pendingCreateName || '')}
        confirmLabel={copyText.confirmBtn}
        cancelLabel={copyText.cancelBtn}
        busy={creating}
        onConfirm={handleConfirmCreate}
        onCancel={() => setPendingCreateName(null)}
      />
    </>
  );
}
