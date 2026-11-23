import { getApps, initializeApp } from 'firebase/app';
import {
  browserLocalPersistence,
  getAuth,
  GoogleAuthProvider,
  inMemoryPersistence,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  type User,
} from 'firebase/auth';
import { doc, getDocFromServer, getFirestore } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

// Guarantee browser local persistence so user session persists across page reloads and browser restarts
void setPersistence(auth, browserLocalPersistence).catch((err) => {
  console.warn('Failed to set local persistence:', err);
});

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
void testConnection();

export const SCOPES = ['https://www.googleapis.com/auth/drive'];

export const createGoogleProvider = (options?: {
  forceSelectAccount?: boolean;
  loginHint?: string;
}) => {
  const p = new GoogleAuthProvider();
  for (const scope of SCOPES) {
    p.addScope(scope);
  }
  const customParams: Record<string, string> = {};
  if (options?.forceSelectAccount) {
    customParams.prompt = 'select_account';
  }
  if (options?.loginHint) {
    customParams.login_hint = options.loginHint;
  }
  if (Object.keys(customParams).length > 0) {
    p.setCustomParameters(customParams);
  }
  return p;
};

export interface DriveAccountInfo {
  email: string;
  displayName: string;
}

let isSigningIn = false;
let isSwitchingDrive = false;
let cachedAccessToken: string | null = null;
let cachedDriveAccount: DriveAccountInfo | null = null;

function getDriveOAuthAuth() {
  const existing = getApps().find((item) => item.name === 'drive-oauth');
  const driveApp = existing || initializeApp(firebaseConfig, 'drive-oauth');
  return getAuth(driveApp);
}

export const initAuth = (
  onAuthSuccess?: (user: User, token: string | null) => void,
  onSignedOut?: () => void
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      if (onAuthSuccess) onAuthSuccess(user, cachedAccessToken);
    } else {
      cachedAccessToken = null;
      cachedDriveAccount = null;
      if (onSignedOut) onSignedOut();
    }
  });
};

export type GoogleSignInOutcome =
  | { status: 'success'; user: User; accessToken: string }
  | { status: 'cancelled' }
  | { status: 'blocked' };

export const googleSignIn = async (
  loginHint?: string,
  forceSelectAccount = false
): Promise<GoogleSignInOutcome> => {
  if (isSigningIn) {
    return { status: 'cancelled' };
  }
  try {
    isSigningIn = true;
    const effectiveHint =
      loginHint ||
      auth.currentUser?.email ||
      cachedDriveAccount?.email ||
      'linhteteducation@gmail.com';
    const provider = createGoogleProvider({
      loginHint: effectiveHint,
      forceSelectAccount,
    });
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Failed to obtain Google Drive access token.');
    }
    cachedAccessToken = credential.accessToken;
    cachedDriveAccount = {
      email: result.user.email || effectiveHint,
      displayName: result.user.displayName || '',
    };
    return { status: 'success', user: result.user, accessToken: cachedAccessToken };
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
    if (
      code === 'auth/popup-closed-by-user' ||
      code === 'auth/cancelled-popup-request'
    ) {
      return { status: 'cancelled' };
    }
    if (code === 'auth/popup-blocked') {
      return { status: 'blocked' };
    }
    throw error;
  } finally {
    isSigningIn = false;
  }
};

export type SwitchDriveOutcome =
  | { status: 'success'; accessToken: string; driveAccount: DriveAccountInfo }
  | { status: 'cancelled' }
  | { status: 'blocked' };

export const switchDriveAccount = async (): Promise<SwitchDriveOutcome> => {
  if (isSigningIn || isSwitchingDrive) {
    return { status: 'cancelled' };
  }
  try {
    isSwitchingDrive = true;
    const driveAuth = getDriveOAuthAuth();
    await setPersistence(driveAuth, inMemoryPersistence);
    const provider = createGoogleProvider({ forceSelectAccount: true });
    const result = await signInWithPopup(driveAuth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Failed to obtain Google Drive access token.');
    }
    const driveAccount: DriveAccountInfo = {
      email: result.user.email || '',
      displayName: result.user.displayName || '',
    };
    cachedAccessToken = credential.accessToken;
    cachedDriveAccount = driveAccount;
    await driveAuth.signOut().catch(() => {});
    return {
      status: 'success',
      accessToken: cachedAccessToken,
      driveAccount,
    };
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
    if (
      code === 'auth/popup-closed-by-user' ||
      code === 'auth/cancelled-popup-request'
    ) {
      return { status: 'cancelled' };
    }
    if (code === 'auth/popup-blocked') {
      return { status: 'blocked' };
    }
    throw error;
  } finally {
    isSwitchingDrive = false;
  }
};

export const getAccessToken = (): string | null => {
  return cachedAccessToken;
};

export const getDriveAccount = (): DriveAccountInfo | null => {
  return cachedDriveAccount;
};

export const clearAccessToken = (): void => {
  cachedAccessToken = null;
  cachedDriveAccount = null;
};

export const getFirebaseIdToken = async (): Promise<string | null> => {
  if (!auth.currentUser) return null;
  return auth.currentUser.getIdToken();
};

export const logout = async (): Promise<void> => {
  await auth.signOut();
  cachedAccessToken = null;
  cachedDriveAccount = null;
};
