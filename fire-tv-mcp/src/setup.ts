export function adbInstallGuidance(): string {
  const lines = [
    'adb (Android Platform Tools) was not found on PATH.',
    '',
    'Install adb, then restart your terminal:',
    '',
  ];

  if (process.platform === 'darwin') {
    lines.push('  macOS (Homebrew):');
    lines.push('    brew install --cask android-platform-tools');
  } else if (process.platform === 'win32') {
    lines.push('  Windows:');
    lines.push('    1) Install Android SDK Platform Tools from:');
    lines.push('       https://developer.android.com/tools/releases/platform-tools');
    lines.push('    2) Add the extracted platform-tools folder to PATH.');
  } else {
    lines.push('  Linux (Debian/Ubuntu):');
    lines.push('    sudo apt-get update && sudo apt-get install -y android-sdk-platform-tools');
    lines.push('  Linux (Arch):');
    lines.push('    sudo pacman -S android-tools');
  }

  lines.push('');
  lines.push('Official docs: https://developer.android.com/tools/adb');
  return lines.join('\n');
}

export function fireTvReachabilityGuidance(ip: string, port: number): string {
  return [
    `Fire TV is not reachable at ${ip}:${port}.`,
    '',
    'Checklist:',
    '  1) Fire TV: Settings > My Fire TV > Developer Options > ADB debugging = On',
    '  2) Fire TV and this computer are on the same LAN/subnet',
    '  3) If prompted on TV, accept the ADB trust dialog',
    '  4) Re-run: npm run check-deps',
    '',
    'If discover finds no Fire TV devices, toggle ADB debugging off/on and retry.',
  ].join('\n');
}

export function fireTvUnauthorizedGuidance(ip: string, port: number): string {
  return [
    `Fire TV at ${ip}:${port} is connected but not authorized.`,
    '',
    "On the TV, accept the 'Allow USB debugging' prompt and then retry.",
    'If no prompt appears, toggle ADB debugging off/on and retry.',
  ].join('\n');
}
