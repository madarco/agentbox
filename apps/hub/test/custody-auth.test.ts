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
        custodyByteReadAuthorized({ mode: 'password', adminToken: admin, providedToken: '' }),
      ).toBe(false);
    });

    it('refuses a wrong admin token', () => {
      expect(
        custodyByteReadAuthorized({ mode: 'password', adminToken: admin, providedToken: 'nope' }),
      ).toBe(false);
    });

    it('refuses when the admin token env is unset (cannot degrade to API-key-only)', () => {
      // Even a caller that sends *some* header is refused when the hub holds no
      // admin token to compare against — never fall open.
      expect(
        custodyByteReadAuthorized({ mode: 'password', adminToken: '', providedToken: 'anything' }),
      ).toBe(false);
      expect(
        custodyByteReadAuthorized({ mode: 'password', adminToken: '', providedToken: '' }),
      ).toBe(false);
    });

    it('allows only a matching admin token', () => {
      expect(
        custodyByteReadAuthorized({ mode: 'password', adminToken: admin, providedToken: admin }),
      ).toBe(true);
    });
  });

  describe('token profile (plain local hub) — the hub token is the trusted credential', () => {
    it('allows a byte-read with no admin token (single trusted machine)', () => {
      expect(custodyByteReadAuthorized({ mode: 'token', adminToken: '', providedToken: '' })).toBe(
        true,
      );
    });
  });

  describe('off profile (auth disabled)', () => {
    it('allows a byte-read (the whole API is open; nothing to bypass)', () => {
      expect(custodyByteReadAuthorized({ mode: 'off', adminToken: '', providedToken: '' })).toBe(
        true,
      );
    });
  });
});
