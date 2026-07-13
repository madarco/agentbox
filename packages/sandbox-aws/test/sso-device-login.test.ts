import { describe, expect, it } from 'vitest';
import { parseDeviceLoginOutput } from '../src/sso-device-login.js';

/**
 * The parser is the load-bearing half of the device flow: whatever it pulls out
 * of `aws sso login --use-device-code --no-browser`'s output is the URL the
 * human is asked to open. Getting it wrong strands the user on a dead link, so
 * the fixtures below are real CLI output shapes, not invented ones.
 */
describe('parseDeviceLoginOutput', () => {
  it('extracts the URL and the embedded user_code (AWS CLI v2 shape)', () => {
    const out = [
      'Attempting to automatically open the SSO authorization page in your default browser.',
      'If the browser does not open or you wish to use a different device to authorize this request, open the following URL:',
      '',
      'https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH',
      '',
    ].join('\n');
    expect(parseDeviceLoginOutput(out)).toEqual({
      url: 'https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH',
      userCode: 'ABCD-EFGH',
    });
  });

  it('falls back to a separately-printed code when the URL carries none', () => {
    const out = [
      'Browser will not be automatically opened.',
      'Please visit the following URL:',
      '',
      'https://device.sso.eu-west-1.amazonaws.com/',
      '',
      'Then enter the code:',
      '',
      'WXYZ-MNOP',
      '',
    ].join('\n');
    expect(parseDeviceLoginOutput(out)).toEqual({
      url: 'https://device.sso.eu-west-1.amazonaws.com/',
      userCode: 'WXYZ-MNOP',
    });
  });

  it('returns null until the URL has actually been printed (output arrives in chunks)', () => {
    expect(parseDeviceLoginOutput('')).toBeNull();
    expect(parseDeviceLoginOutput('Attempting to automatically open the SSO')).toBeNull();
  });

  it('strips trailing punctuation the CLI wraps the URL in', () => {
    const hit = parseDeviceLoginOutput('open https://device.sso.us-east-1.amazonaws.com/?user_code=AAAA-BBBB.');
    expect(hit?.url).toBe('https://device.sso.us-east-1.amazonaws.com/?user_code=AAAA-BBBB');
    expect(hit?.userCode).toBe('AAAA-BBBB');
  });

  it('yields a URL with no code rather than nothing, when the CLI prints no code at all', () => {
    const hit = parseDeviceLoginOutput('Please visit https://device.sso.us-east-1.amazonaws.com/verify');
    expect(hit).toEqual({ url: 'https://device.sso.us-east-1.amazonaws.com/verify', userCode: undefined });
  });
});
