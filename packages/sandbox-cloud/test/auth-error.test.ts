import { describe, expect, it } from 'vitest';
import { isAuthError, isNotAuthenticatedError, NotAuthenticatedError } from '../src/auth-error.js';

/**
 * Shapes taken from real failures, not invented: the EC2 query-protocol codes
 * arrive on `AwsApiError.code`, while the SDK's credential chain throws plain
 * `Error`s whose `name` is the code and whose message is the only signal.
 */
function awsApiError(code: string, message = 'boom'): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.name = 'AwsApiError';
  err.code = code;
  return err;
}

describe('isAuthError', () => {
  it('matches the EC2 credential-rejection codes', () => {
    for (const code of [
      'ExpiredToken',
      'ExpiredTokenException',
      'TokenRefreshRequired',
      'AuthFailure',
      'InvalidClientTokenId',
      'UnrecognizedClientException',
      'SignatureDoesNotMatch',
      'AccessDenied',
    ]) {
      expect(isAuthError(awsApiError(code)), code).toBe(true);
    }
  });

  it('matches the SDK credential-chain error names (the ones the old switch missed)', () => {
    for (const name of ['CredentialsProviderError', 'SSOTokenProviderFailure']) {
      const err = new Error('could not load credentials from any providers');
      err.name = name;
      expect(isAuthError(err), name).toBe(true);
    }
  });

  it('matches the expired-SSO message even without a code (what the SDK actually threw)', () => {
    // Verbatim from a stale `controlclaw` profile.
    const err = new Error(
      "Token is expired. To refresh this SSO session run 'aws sso login' with the corresponding profile.",
    );
    expect(isAuthError(err)).toBe(true);
  });

  it('matches generic 401/403 from the non-AWS backends', () => {
    expect(isAuthError({ statusCode: 401, message: 'unauthorized' })).toBe(true);
    expect(isAuthError({ response: { status: 403 }, message: 'forbidden' })).toBe(true);
  });

  it('does NOT match resource-level failures — the false positive that would send users chasing a login', () => {
    for (const code of [
      'InvalidInstanceID.NotFound',
      'InvalidInstanceID.Malformed',
      'InvalidAMIID.NotFound',
      'InvalidGroup.NotFound',
      'InsufficientInstanceCapacity',
      'VcpuLimitExceeded',
      'Unsupported',
    ]) {
      expect(isAuthError(awsApiError(code, 'the instance does not exist')), code).toBe(false);
    }
  });

  it('does not match a plain error, a 404, or a non-object', () => {
    expect(isAuthError(new Error('connection reset'))).toBe(false);
    expect(isAuthError({ statusCode: 404, message: 'not found' })).toBe(false);
    expect(isAuthError(null)).toBe(false);
    expect(isAuthError('ExpiredToken')).toBe(false);
  });

  it('UnauthorizedOperation is an auth error (a rejected caller), distinct from a missing IAM action', () => {
    // The preflight maps UnauthorizedOperation to its own "missing permission"
    // message BEFORE consulting the classifier, so the overlap is intentional
    // and harmless — but the classifier must still recognize it for backends
    // that have no such mapping.
    expect(isAuthError(awsApiError('UnauthorizedOperation'))).toBe(true);
  });
});

describe('NotAuthenticatedError', () => {
  it('carries the provider + the fix, and survives the name-based instanceof', () => {
    const err = new NotAuthenticatedError('aws', 'AWS rejected the credentials', 'run `aws sso login`');
    expect(err.provider).toBe('aws');
    expect(err.hint).toBe('run `aws sso login`');
    expect(isNotAuthenticatedError(err)).toBe(true);
    // The CLI renders UserFacingError stack-free; the subclass must keep that.
    expect(err.name).toBe('NotAuthenticatedError');
  });

  it('isNotAuthenticatedError matches across a bundling boundary (name, not identity)', () => {
    const impostor = new Error('rejected');
    impostor.name = 'NotAuthenticatedError';
    expect(isNotAuthenticatedError(impostor)).toBe(true);
    expect(isNotAuthenticatedError(new Error('nope'))).toBe(false);
  });
});
