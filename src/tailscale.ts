import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

export interface TailscaleEnv {
  ipv4: string;
  hostname: string;
  certPath: string;
  keyPath: string;
}

// The App Store build ships its CLI inside the bundle and installs nothing on PATH;
// the standalone build's /usr/local/bin shim is gone with it.
const CLI_CANDIDATES = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
];

// The CLI blocks indefinitely when the app is present but its backend is unreachable,
// and execFileSync has no default timeout — that wedges daemon startup rather than
// falling through to the loopback-only path.
const CLI_TIMEOUT_MS = 5000;

const SANDBOX_APP_PREFIX = '/Applications/Tailscale.app';
const SANDBOX_DATA_DIR = `${homedir()}/Library/Containers/io.tailscale.ipn.macos/Data`;

function resolveCli(): string {
  const override = process.env.OUTPOST_TAILSCALE_BIN;
  if (override) return override;
  return CLI_CANDIDATES.find((p) => existsSync(p)) ?? 'tailscale';
}

function run(bin: string, args: string[]): string {
  return execFileSync(bin, args, { encoding: 'utf8', timeout: CLI_TIMEOUT_MS }).trim();
}

// The sandboxed App Store CLI rejects an absolute --cert-file and redirects a relative
// one into its container, so the copy-out step is not optional there.
function certInstructions(bin: string, certDir: string, hostname: string): string {
  const certPath = `${certDir}/${hostname}.crt`;
  const keyPath = `${certDir}/${hostname}.key`;
  if (!bin.startsWith(SANDBOX_APP_PREFIX)) {
    return `tailscale cert files not found. Run: ${bin} cert --cert-file=${certPath} --key-file=${keyPath} ${hostname}`;
  }
  return [
    `tailscale cert files not found. The App Store Tailscale CLI is sandboxed and cannot`,
    `write to ${certDir}; mint into its container, then copy out:`,
    `  ${bin} cert --cert-file=${hostname}.crt --key-file=${hostname}.key ${hostname}`,
    `  cp ${SANDBOX_DATA_DIR}/${hostname}.crt ${certPath}`,
    `  cp ${SANDBOX_DATA_DIR}/${hostname}.key ${keyPath} && chmod 600 ${keyPath}`,
  ].join('\n');
}

export function discoverTailscaleEnv(opts: { certDir: string }): TailscaleEnv {
  const bin = resolveCli();

  const ipv4 = run(bin, ['ip', '--4']);
  if (!/^100\./.test(ipv4)) {
    throw new Error(`unexpected tailscale ip output: ${ipv4}`);
  }

  const statusJson = run(bin, ['status', '--json']);
  const status = JSON.parse(statusJson) as { Self?: { DNSName?: string } };
  const dns = status.Self?.DNSName ?? '';
  const hostname = dns.replace(/\.$/, '');
  if (!hostname.endsWith('.ts.net')) {
    throw new Error(`unexpected tailscale DNS name: ${dns}`);
  }

  const certPath = `${opts.certDir}/${hostname}.crt`;
  const keyPath = `${opts.certDir}/${hostname}.key`;
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    throw new Error(certInstructions(bin, opts.certDir, hostname));
  }
  readFileSync(certPath);
  readFileSync(keyPath);

  return { ipv4, hostname, certPath, keyPath };
}
