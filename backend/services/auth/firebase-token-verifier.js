import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { config } from '../config/index.js';

const APP_NAME = 'recoveriq-auth';

/**
 * Verifies Firebase ID tokens. Signature checks use Google's public keys, so only the project ID
 * is needed: no service account credential is stored by this service.
 */
export class FirebaseTokenVerifier {
  static isConfigured() {
    return Boolean(config.firebase.projectId);
  }

  static async verify(idToken) {
    const app =
      getApps().find((existing) => existing.name === APP_NAME) ||
      initializeApp({ projectId: config.firebase.projectId }, APP_NAME);
    return getAuth(app).verifyIdToken(idToken);
  }
}
