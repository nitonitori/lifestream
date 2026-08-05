import { describe, it, expect } from 'vitest';
import { nextBackoffMs } from '../../src/daemon.js';
import { renderLaunchdPlist } from '../../src/launchd.js';

describe('nextBackoffMs', () => {
  it('grows exponentially from base and caps', () => {
    expect(nextBackoffMs(0, 500, 30000)).toBe(500);
    expect(nextBackoffMs(1, 500, 30000)).toBe(1000);
    expect(nextBackoffMs(3, 500, 30000)).toBe(4000);
    expect(nextBackoffMs(20, 500, 30000)).toBe(30000); // capped
  });
});

describe('renderLaunchdPlist', () => {
  const plist = renderLaunchdPlist({
    label: 'com.lifestream.daemon',
    programArguments: ['/usr/local/bin/node', '/app/dist/cli.js', 'daemon'],
    workingDirectory: '/app',
    stdoutPath: '/app/.lifestream/daemon.log',
    stderrPath: '/app/.lifestream/daemon.log',
  });
  it('keeps the service alive and runs at load', () => {
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<true/>');
  });
  it('embeds label and program arguments', () => {
    expect(plist).toContain('<string>com.lifestream.daemon</string>');
    expect(plist).toContain('<string>daemon</string>');
    expect(plist).toContain('<string>/app/dist/cli.js</string>');
  });
  it('is valid plist header', () => {
    expect(plist.startsWith('<?xml')).toBe(true);
    expect(plist).toContain('<!DOCTYPE plist');
  });
  it('omits EnvironmentVariables when no env given', () => {
    expect(plist).not.toContain('EnvironmentVariables');
  });
  // launchd 只给 /usr/bin:/bin:/usr/sbin:/sbin。tmux/claude 都在 /opt/homebrew/bin，
  // 且 tmux 起的会话会继承这份 env —— PATH 必须显式带上，否则装上就是全线哑火。
  it('embeds env vars so PATH survives launchd', () => {
    const withEnv = renderLaunchdPlist({
      label: 'com.lifestream.daemon',
      programArguments: ['/usr/local/bin/node', '/app/dist/cli.js', 'daemon'],
      workingDirectory: '/app',
      stdoutPath: '/app/out.log',
      stderrPath: '/app/err.log',
      env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin' },
    });
    expect(withEnv).toContain('<key>EnvironmentVariables</key>');
    expect(withEnv).toContain('<key>PATH</key>');
    expect(withEnv).toContain('<string>/opt/homebrew/bin:/usr/bin:/bin</string>');
  });
});
