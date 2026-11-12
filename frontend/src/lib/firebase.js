const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

export const isGoogleSignInConfigured = Object.values(firebaseConfig).every(Boolean);

const DISMISSED_POPUP_CODES = ['auth/popup-closed-by-user', 'auth/cancelled-popup-request'];

/**
 * Open the Google account chooser and return a Firebase ID token, or null if the user dismissed it.
 * Firebase only proves identity here: the backend exchanges the token for a RecoverIQ session.
 */
export async function requestGoogleIdToken() {
  const [{ initializeApp, getApps }, { getAuth, GoogleAuthProvider, signInWithPopup, signOut }] = await Promise.all([
    import('firebase/app'),
    import('firebase/auth'),
  ]);

  const auth = getAuth(getApps()[0] || initializeApp(firebaseConfig));
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });

  try {
    const { user } = await signInWithPopup(auth, provider);
    const idToken = await user.getIdToken();
    await signOut(auth);
    return idToken;
  } catch (error) {
    if (DISMISSED_POPUP_CODES.includes(error.code)) return null;
    if (error.code === 'auth/popup-blocked') {
      throw new Error('Your browser blocked the Google window. Allow pop-ups and try again.');
    }
    throw new Error('Google sign-in failed. Please try again.');
  }
}
