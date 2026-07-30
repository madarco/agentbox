import { describe, expect, it } from 'vitest';
import { custodyByteReadAuthorized } from '../lib/custody-auth';

// The load-bearing invariant of the custody two-tier contract: on a control box a
// byte-read needs the admin token, and it FAILS CLOSED. These tests exist so a
// future refactor of the route can't silently let the hub API key alone read a
// stored value (agent creds / .env / per-box SSH private keys).
describe('custodyByteReadAuthorized (byte-read elevation)', () => {
  const admin = 'the-admin-token';

  describe('password profile (control box) — FAIL CLOSED', () => {
    it('refuses an API-key-only caller (no admin header) — THE invariant', () => {
      expect(
        custodyByteReadAuthorized({
          mode: 'password',
          adminToken: admin,
          providedToken: '',
          isLoopback: true,
        }),
      ).toBe(false);
    });

    it('refuses a wrong admin token', () => {
      expect(
        custodyByteReadAuthorized({
          mode: 'password',
          adminToken: admin,
          providedToken: 'nope',
          isLoopback: true,
        }),
      ).toBe(false);
    });

    it('refuses when the admin token env is unset (cannot degrade to API-key-only)', () => {
      // Even a caller that sends *some* header is refused when the hub holds no
      // admin token to compare against — never fall open.
      expect(
        custodyByteReadAuthorized({
          mode: 'password',
          adminToken: '',
          providedToken: 'anything',
          isLoopback: true,
        }),
      ).toBe(false);
      expect(
        custodyByteReadAuthorized({
          mode: 'password',
          adminToken: '',
          providedToken: '',
          isLoopback: true,
        }),
      ).toBe(false);
    });

    it('allows a matching admin token regardless of loopback (behind Caddy it looks loopback anyway)', () => {
      expect(
        custodyByteReadAuthorized({
          mode: 'password',
          adminToken: admin,
          providedToken: admin,
          isLoopback: true,
        }),
      ).toBe(true);
      expect(
        custodyByteReadAuthorized({
          mode: 'password',
          adminToken: admin,
          providedToken: admin,
          isLoopback: false,
        }),
      ).toBe(true);
    });
  });

  describe('token profile (plain local hub) — the hub token is trusted ONLY over loopback', () => {
    it('allows a loopback byte-read with no admin token (the PC reads from its own machine)', () => {
      expect(
        custodyByteReadAuthorized({
          mode: 'token',
          adminToken: '',
          providedToken: '',
          isLoopback: true,
        }),
      ).toBe(true);
    });

    it('REFUSES a non-loopback byte-read even with a valid hub token — the emergent Step 2+10 fix', () => {
      // The localhost hub binds 0.0.0.0 (docker boxes reach the embedded relay), so
      // the token profile's routes are LAN-reachable and the token leaks into
      // scrollback via the printed `?token=…` URL. Custody bytes (creds, SSH private
      // keys) must never leave the machine over the network on the token profile.
      expect(
        custodyByteReadAuthorized({
          mode: 'token',
          adminToken: '',
          providedToken: '',
          isLoopback: false,
        }),
      ).toBe(false);
    });
  });

  describe('off profile (auth disabled)', () => {
    it('allows a byte-read (the whole API is open; nothing to bypass)', () => {
      expect(
        custodyByteReadAuthorized({
          mode: 'off',
          adminToken: '',
          providedToken: '',
          isLoopback: false,
        }),
      ).toBe(true);
    });
  });
});
