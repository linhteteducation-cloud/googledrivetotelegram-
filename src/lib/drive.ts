import type { DriveFileItem, DriveFolder } from '../types';

const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const SAFE_DRIVE_ID_REGEX = /^[A-Za-z0-9_-]{3,128}$/;

function assertDriveId(id: string): string {
  if (!SAFE_DRIVE_ID_REGEX.test(id)) {
    throw new Error('Invalid Google Drive folder ID.');
  }
  return id;
}

export class DriveAuthExpiredError extends Error {
  constructor() {
    super('Google Drive authorization expired');
    this.name = 'DriveAuthExpiredError';
  }
}

async function driveFetch<T>(url: string, accessToken: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init?.headers || {}),
    },
  });

  if (res.status === 401) {
    throw new DriveAuthExpiredError();
  }

  if (!res.ok) {
    let message = `Google Drive request failed (${res.status})`;
    try {
      const errBody = (await res.json()) as { error?: { message?: string } };
      if (errBody.error?.message) {
        message = errBody.error.message;
      }
    } catch {
      // ignore JSON parse failure
    }
    throw new Error(message);
  }

  if (res.status === 204) {
    return {} as T;
  }
  return (await res.json()) as T;
}

export async function listDriveFolders(
  accessToken: string,
  parentId: string = 'root',
  searchQuery: string = ''
): Promise<DriveFolder[]> {
  const safeParentId = assertDriveId(parentId);
  const escapedSearch = searchQuery.trim().replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const clauses = [
    "mimeType = 'application/vnd.google-apps.folder'",
    'trashed = false',
  ];

  if (escapedSearch) {
    clauses.push(`name contains '${escapedSearch}'`);
  } else {
    clauses.push(`'${safeParentId}' in parents`);
  }

  const url = new URL(DRIVE_API);
  url.searchParams.set('q', clauses.join(' and '));
  url.searchParams.set('orderBy', 'folder,name');
  url.searchParams.set('pageSize', '100');
  url.searchParams.set('fields', 'files(id,name,parents,modifiedTime,webViewLink)');

  const data = await driveFetch<{ files?: DriveFolder[] }>(url.toString(), accessToken);
  return data.files || [];
}

export async function createDriveFolder(
  accessToken: string,
  name: string,
  parentId: string = 'root'
): Promise<DriveFolder> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('Folder name cannot be empty.');
  }

  return driveFetch<DriveFolder>(
    `${DRIVE_API}?fields=id,name,parents,modifiedTime,webViewLink`,
    accessToken,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: trimmed,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      }),
    }
  );
}

export async function listDriveFolderPdfs(
  accessToken: string,
  folderId: string
): Promise<DriveFileItem[]> {
  const safeFolderId = assertDriveId(folderId);
  const url = new URL(DRIVE_API);
  url.searchParams.set(
    'q',
    `'${safeFolderId}' in parents and trashed = false and mimeType = 'application/pdf'`
  );
  url.searchParams.set('orderBy', 'createdTime desc');
  url.searchParams.set('pageSize', '100');
  url.searchParams.set(
    'fields',
    'files(id,name,mimeType,size,modifiedTime,createdTime,webViewLink,appProperties)'
  );

  const data = await driveFetch<{ files?: DriveFileItem[] }>(url.toString(), accessToken);
  return data.files || [];
}

export async function trashDriveFile(accessToken: string, fileId: string): Promise<void> {
  await driveFetch(`${DRIVE_API}/${encodeURIComponent(fileId)}`, accessToken, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ trashed: true }),
  });
}
