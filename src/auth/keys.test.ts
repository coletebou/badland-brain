import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { KeyStore, addKey, hashKey, isKeyShaped, mintKey, parseKeys, readKeysFile, revokeKey, writeKeysFile } from './keys.js';
import { findSecretShapes } from '../brain/redact.js';

const tempFile = (): string => join(mkdtempSync(join(tmpdir(), 'brain-keys-')), 'keys.json');

describe('keys', () => {
  it('mints a 256-bit key shaped so secret scanners and the write gate recognise it, storing only its hash', () => {
    const { raw, record } = mintKey({ name: 'codex@laptop', role: 'agent', namespaces: ['agent:codex', 'shared'], expiresDays: 30, now: new Date('2026-01-01T00:00:00Z') });
    expect(isKeyShaped(raw)).toBe(true);
    expect(findSecretShapes(raw)).toEqual(['brain-api-key']);
    expect(record).toMatchObject({ name: 'codex@laptop', role: 'agent', namespaces: ['agent:codex', 'shared'], hash: hashKey(raw), createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-31T00:00:00.000Z' });
    expect(JSON.stringify(record)).not.toContain(raw);
    expect(mintKey({ name: 'a', role: 'read' }).raw).not.toBe(mintKey({ name: 'a', role: 'read' }).raw);
  });

  it('refuses bad names, an owner confined to namespaces, and bad namespaces', () => {
    expect(() => mintKey({ name: 'has space', role: 'agent' })).toThrow(/name/u);
    expect(() => mintKey({ name: `ghp_${'k'.repeat(24)}`, role: 'agent' })).toThrow(/looks like a secret/u);
    expect(() => mintKey({ name: 'boss', role: 'owner', namespaces: ['shared'] })).toThrow(/owner key cannot be confined/u);
    expect(() => mintKey({ name: 'x', role: 'agent', namespaces: ['team:x'] })).toThrow(/namespaces/u);
    expect(() => mintKey({ name: 'x', role: 'admin' as never })).toThrow(/role/u);
  });

  it('parses the file format or a bare array, naming the first bad field and never a value', () => {
    const { record } = mintKey({ name: 'reader', role: 'read' });
    expect(parseKeys(JSON.stringify({ version: 1, keys: [record] }), 'f')).toEqual([record]);
    expect(parseKeys(JSON.stringify([record]), 'f')).toEqual([record]);
    expect(() => parseKeys('{', 'f')).toThrow('f is not valid JSON');
    expect(() => parseKeys(JSON.stringify({ version: 2, keys: [] }), 'f')).toThrow(/must be/u);
    expect(() => parseKeys(JSON.stringify([{ ...record, hash: 'nothex' }]), 'f')).toThrow(/key 1: hash/u);
    expect(() => parseKeys(JSON.stringify([record, record]), 'f')).toThrow(/appears twice/u);
    expect(() => parseKeys(JSON.stringify([{ ...record, extra: true }]), 'f')).toThrow(/key 1/u);
  });

  it('looks keys up by hash, refuses unknown, malformed and expired keys', () => {
    const file = tempFile();
    const live = mintKey({ name: 'live', role: 'agent' });
    const old = mintKey({ name: 'old', role: 'agent', expiresDays: 1, now: new Date('2020-01-01T00:00:00Z') });
    writeKeysFile(file, [live.record, old.record]);
    const store = new KeyStore({ file });
    expect(store.lookup(live.raw)).toEqual({ ok: true, key: live.record });
    expect(store.lookup(old.raw)).toEqual({ ok: false, reason: 'expired' });
    expect(store.lookup(`bbk_${'z'.repeat(43)}`)).toEqual({ ok: false, reason: 'unknown' });
    expect(store.lookup('not-a-key')).toEqual({ ok: false, reason: 'unknown' });
    expect(store.lookup(`${live.raw}x`)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('reloads the file when it changes, and fails closed on a file it cannot parse', () => {
    const file = tempFile();
    const first = mintKey({ name: 'first', role: 'agent' });
    writeKeysFile(file, [first.record]);
    const store = new KeyStore({ file });
    expect(store.lookup(first.raw).ok).toBe(true);
    const second = mintKey({ name: 'second', role: 'read' });
    addKey(file, second.record);
    expect(store.lookup(second.raw).ok).toBe(true);
    writeFileSync(file, '{ "version": 1, "keys": [ {"broken": true} ] }');
    expect(store.lookup(first.raw)).toEqual({ ok: false, reason: 'unknown' });
    expect(store.fileError()).toMatch(/key 1/u);
    writeKeysFile(file, [first.record]);
    expect(store.lookup(first.raw).ok).toBe(true);
    expect(store.lookup(second.raw).ok).toBe(false);
  });

  it('accepts inline keys beside the file, and an inline set that cannot be parsed stops startup', () => {
    const inline = mintKey({ name: 'inline', role: 'owner' });
    const store = new KeyStore({ file: tempFile(), inline: JSON.stringify([inline.record]) });
    expect(store.lookup(inline.raw)).toEqual({ ok: true, key: inline.record });
    expect(() => new KeyStore({ inline: '[{"nope": 1}]' })).toThrow(/BRAIN_KEYS: key 1/u);
  });

  it('writes the file owner-only and atomically, refuses duplicate names, and revokes by id or unique name', () => {
    const file = tempFile();
    const a = mintKey({ name: 'a', role: 'agent' });
    const b = mintKey({ name: 'b', role: 'agent' });
    addKey(file, a.record);
    addKey(file, b.record);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(() => addKey(file, mintKey({ name: 'a', role: 'read' }).record)).toThrow(/already exists/u);
    expect(revokeKey(file, a.record.id).map((r) => r.name)).toEqual(['a']);
    expect(revokeKey(file, 'b').map((r) => r.id)).toEqual([b.record.id]);
    expect(revokeKey(file, 'missing')).toEqual([]);
    expect(readKeysFile(file)).toEqual([]);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, keys: [] });
  });

  it('serializes key commands on a lock beside the file, so a mint never writes back a revoked key', () => {
    const file = tempFile();
    const a = mintKey({ name: 'a', role: 'read' });
    addKey(file, a.record);
    expect(existsSync(`${file}.lock`)).toBe(false);
    // Another command holds the lock: both mutators wait for it, then give up without touching the file.
    writeFileSync(`${file}.lock`, '');
    const before = readFileSync(file, 'utf8');
    expect(() => addKey(file, mintKey({ name: 'b', role: 'read' }).record, { lockWaitMs: 60 })).toThrow(/another keys command holds .*keys\.json\.lock/u);
    expect(() => revokeKey(file, 'a', { lockWaitMs: 60 })).toThrow(/another keys command holds/u);
    expect(readFileSync(file, 'utf8')).toBe(before);
    // Once it is released they proceed, and leave no lock behind, even when the update itself fails.
    rmSync(`${file}.lock`);
    expect(revokeKey(file, 'a').map((r) => r.name)).toEqual(['a']);
    addKey(file, a.record);
    expect(() => addKey(file, mintKey({ name: 'a', role: 'read' }).record)).toThrow(/already exists/u);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it('still loads a group-readable file, warning about its permissions', () => {
    const file = tempFile();
    const key = mintKey({ name: 'loose', role: 'agent' });
    writeKeysFile(file, [key.record]);
    chmodSync(file, 0o644);
    const warnings: string[] = [];
    const store = new KeyStore({ file, logger: { debug() {}, info() {}, warn: (m) => warnings.push(m), error() {} } });
    expect(store.lookup(key.raw).ok).toBe(true);
    expect(warnings.some((w) => w.includes('chmod 600'))).toBe(process.platform !== 'win32');
  });
});
