// Settings view-model: pure functions deriving the sections-column nav shape
// and each detail card's rows from raw store/API data. No DOM, no layout —
// shared by the desktop Settings surface today and the mobile "More > Settings"
// pushed screens in P3 (D2).

import { KEYMAP_COMMANDS, DEFAULT_BINDINGS } from '../state/keymap-commands.js';

export const SETTINGS_SECTIONS = [
  {
    label: 'Appearance',
    items: [
      { key: 'theme', label: 'Theme', icon: '◐' },
      { key: 'density', label: 'Density', icon: '▤' },
    ],
  },
  {
    label: 'Runtime',
    items: [
      { key: 'model-defaults', label: 'Model defaults', icon: '◇' },
      { key: 'permissions', label: 'Permissions', icon: '◉' },
      { key: 'mcp', label: 'MCP connections', icon: '◈' },
      { key: 'notifications', label: 'Notifications', icon: '✉' },
      { key: 'projects', label: 'Projects', icon: '▣' },
    ],
  },
  {
    label: 'Daemon',
    items: [
      { key: 'tailscale', label: 'Tailscale', icon: '⬡' },
      { key: 'health', label: 'Health & logs', icon: '◔' },
      { key: 'advanced', label: 'Advanced', icon: '⚙' },
    ],
  },
  {
    label: 'Hotkeys',
    desktopOnly: true,
    items: [
      { key: 'hotkeys', label: 'Keyboard shortcuts', icon: '⌨' },
    ],
  },
];

// `warnFlags` is `{ [sectionKey]: boolean }` — currently only 'mcp' is ever
// true (an unreachable MCP server), computed by the caller from grants store
// state so this stays a pure function of already-derived booleans.
export function settingsSections(warnFlags = {}, desktop = true) {
  return SETTINGS_SECTIONS
    .filter((group) => desktop || !group.desktopOnly)
    .map((group) => ({
      ...group,
      items: group.items.map((item) => ({ ...item, warn: !!warnFlags[item.key] })),
    }));
}

const MCP_LABEL = { ok: 'Connected', configured: 'Configured (stdio)', unreachable: 'Unreachable' };
const MCP_TONE = { ok: 'ok', configured: 'ok', unreachable: 'danger' };

export function mcpServerRows(servers = []) {
  return [...servers]
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
    .map((s) => ({
      name: s.name,
      transport: s.transport,
      status: s.status,
      statusLabel: MCP_LABEL[s.status] ?? s.status,
      tone: MCP_TONE[s.status] ?? 'warn',
    }));
}

const HOTKEY_SURFACE_ORDER = ['shell', 'session', 'palette', 'diff'];
const HOTKEY_SURFACE_LABELS = { shell: 'Shell', session: 'Session', palette: 'Palette', diff: 'Diff review' };

// Pure grouping of the command catalog + user overrides into per-surface row
// groups for the Hotkeys settings page. No DOM.
export function hotkeyRows(overrides = {}) {
  return HOTKEY_SURFACE_ORDER.map((surface) => ({
    surface,
    surfaceLabel: HOTKEY_SURFACE_LABELS[surface] ?? surface,
    rows: KEYMAP_COMMANDS
      .filter((c) => c.surface === surface)
      .map((c) => {
        const binding = overrides[c.id] ?? DEFAULT_BINDINGS[c.id];
        return {
          id: c.id,
          label: c.label,
          description: c.description,
          binding,
          isDefault: binding === DEFAULT_BINDINGS[c.id],
        };
      }),
  }));
}
