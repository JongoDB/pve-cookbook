import { mkdirSync } from 'node:fs';
import { Session } from './lib/api';
import { STATE, type Role } from './lib/env';

/** Log in once per role and save the session cookie for the tests. */
export default async function globalSetup() {
  mkdirSync('.auth', { recursive: true });
  for (const role of ['root', 'dev'] as Role[]) {
    const s = await Session.login(role);
    await s.dismissWhatsNew(); // the What's new test uses its own user (ops)
    await s.ctx.storageState({ path: STATE(role) });
    await s.dispose();
  }
}
