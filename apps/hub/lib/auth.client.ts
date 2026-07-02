'use client';

import { createAuthClient } from 'better-auth/react';

// baseURL undefined → the client uses the current window origin, which is the
// same host that serves the hub (localhost/hetzner/vercel), so no config needed.
const authClient = createAuthClient({ baseURL: undefined });

export const { signIn, signOut, useSession } = authClient;
