import { describe, it, expect } from 'vitest';
import {
  adbInstallGuidance,
  fireTvReachabilityGuidance,
  fireTvUnauthorizedGuidance,
} from '../src/setup.js';

describe('adbInstallGuidance', () => {
  it('returns a non-empty string', () => {
    const msg = adbInstallGuidance();
    expect(typeof msg).toBe('string');
    expect(msg.length).toBeGreaterThan(0);
  });

  it('mentions the official ADB docs URL', () => {
    expect(adbInstallGuidance()).toContain('developer.android.com');
  });

  it('mentions install instructions for the current platform', () => {
    const msg = adbInstallGuidance();
    // Should always mention at least one package manager or download step
    const hasSomeInstructions =
      msg.includes('brew') ||
      msg.includes('apt-get') ||
      msg.includes('pacman') ||
      msg.includes('Platform Tools');
    expect(hasSomeInstructions).toBe(true);
  });
});

describe('fireTvReachabilityGuidance', () => {
  it('includes the IP and port in the message', () => {
    const msg = fireTvReachabilityGuidance('10.0.0.42', 5555);
    expect(msg).toContain('10.0.0.42');
    expect(msg).toContain('5555');
  });

  it('mentions ADB debugging', () => {
    expect(fireTvReachabilityGuidance('1.2.3.4', 5555)).toContain('ADB debugging');
  });

  it('returns a multi-line string with actionable steps', () => {
    const lines = fireTvReachabilityGuidance('1.2.3.4', 5555).split('\n');
    expect(lines.length).toBeGreaterThan(2);
  });
});

describe('fireTvUnauthorizedGuidance', () => {
  it('includes the IP and port', () => {
    const msg = fireTvUnauthorizedGuidance('192.168.5.5', 5555);
    expect(msg).toContain('192.168.5.5');
    expect(msg).toContain('5555');
  });

  it('mentions the trust dialog', () => {
    const msg = fireTvUnauthorizedGuidance('1.2.3.4', 5555);
    expect(msg.toLowerCase()).toContain('debugging');
  });
});
