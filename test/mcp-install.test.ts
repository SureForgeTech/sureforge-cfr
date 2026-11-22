import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  clientConfigPath,
  formatMcpSnippet,
  installClientConfig,
  runMcpInstallCommand,
} from '../src/commands/mcp-install.js';
import { CommandError, EXIT } from '../src/exit-codes.js';

describe('mcp-install', () => {
  it('formats snippet with npx command and mcp args', () => {
    const snippet = formatMcpSnippet();
    expect(snippet).toContain('"cfr-free"');
    expect(snippet).toContain('"command": "npx"');
    expect(snippet).toContain('"args": [');
    expect(snippet).toContain('"mcp"');
  });

  it('computes expected paths for cursor, vscode, and windsurf', () => {
    const cwd = '/test/workspace';
    const homedir = '/test/home';
    expect(clientConfigPath('cursor', { cwd, homedir })).toBe(
      path.join(cwd, '.cursor', 'mcp.json'),
    );
    expect(clientConfigPath('vscode', { cwd, homedir })).toBe(
      path.join(cwd, '.vscode', 'mcp.json'),
    );
    expect(clientConfigPath('windsurf', { cwd, homedir })).toBe(
      path.join(homedir, '.codeium', 'windsurf', 'mcp_config.json'),
    );
  });

  it('creates target file and injects cfr-free server entry', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cfr-mcp-install-'));
    try {
      const target = path.join(tempDir, '.cursor', 'mcp.json');
      const result = installClientConfig('cursor', target);
      expect(result.status).toBe('created');
      expect(result.updated).toBe(true);

      const content = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
      expect(content['mcpServers']).toBeDefined();
      const servers = content['mcpServers'] as Record<string, unknown>;
      expect(servers['cfr-free']).toBeDefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves existing servers when updating config', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cfr-mcp-preserve-'));
    try {
      const target = path.join(tempDir, 'mcp.json');
      writeFileSync(
        target,
        JSON.stringify({ mcpServers: { other: { command: 'other-cmd' } } }),
        'utf8',
      );
      const result = installClientConfig('cursor', target);
      expect(result.status).toBe('updated');

      const content = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
      const servers = content['mcpServers'] as Record<string, unknown>;
      expect(servers['other']).toEqual({ command: 'other-cmd' });
      expect(servers['cfr-free']).toBeDefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('accepts a config whose first byte is a byte-order mark', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cfr-mcp-bom-'));
    try {
      const target = path.join(tempDir, 'mcp.json');
      writeFileSync(target, '\uFEFF{"mcpServers":{"other":{"command":"other-cmd"}}}', 'utf8');
      expect(installClientConfig('cursor', target).status).toBe('updated');
      const content = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
      const servers = content['mcpServers'] as Record<string, unknown>;
      expect(servers['other']).toEqual({ command: 'other-cmd' });
      expect(servers['cfr-free']).toBeDefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses to clobber a config it cannot parse', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cfr-mcp-invalid-'));
    try {
      const target = path.join(tempDir, 'mcp.json');
      // JSONC: VS Code and Cursor both accept comments and trailing commas in
      // their config files, and `JSON.parse` rejects them. The previous
      // behaviour replaced the whole file with `{"mcpServers": …}`.
      const original = '{\n  // my servers\n  "mcpServers": { "other": { "command": "x" } },\n}\n';
      writeFileSync(target, original, 'utf8');

      expect(() => installClientConfig('cursor', target)).toThrow(CommandError);
      try {
        installClientConfig('cursor', target);
      } catch (error) {
        expect((error as CommandError).exitCode).toBe(EXIT.REFUSED);
      }
      expect(readFileSync(target, 'utf8')).toBe(original);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses to clobber a config whose root is not a JSON object', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cfr-mcp-array-'));
    try {
      const target = path.join(tempDir, 'mcp.json');
      writeFileSync(target, '[]\n', 'utf8');
      expect(() => installClientConfig('cursor', target)).toThrow(CommandError);
      expect(readFileSync(target, 'utf8')).toBe('[]\n');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects a client name it does not know', () => {
    expect(() => runMcpInstallCommand({ client: 'emacs' })).toThrow(CommandError);
    try {
      runMcpInstallCommand({ client: 'cursor,emacs' });
    } catch (error) {
      expect((error as CommandError).exitCode).toBe(EXIT.USAGE);
    }
  });

  it('supports --print mode without writing files', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cfr-mcp-print-'));
    try {
      const res = runMcpInstallCommand({ print: true, cwd: tempDir, homedir: tempDir });
      expect(res.output).toContain('```json');
      expect(res.output).toContain('"cfr-free"');
      expect(res.results.every((r) => r.status === 'printed')).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('installs across clients in specified cwd and homedir', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cfr-mcp-run-'));
    try {
      const res = runMcpInstallCommand({
        client: 'cursor,vscode',
        cwd: tempDir,
        homedir: tempDir,
      });
      expect(res.results.length).toBe(2);
      expect(res.output).toContain('Configured cfr-free for cursor');
      expect(res.output).toContain('Configured cfr-free for vscode');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
