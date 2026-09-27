import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { persistDefaultModel } from '../src/default-model.js';
import { BUILTIN_PROFILES, loadSettings } from '../src/settings.js';

describe('default model persistence', () => {
  let directory: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-default-'));
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
  it('writes only the selected profile and changes memory after successful save', () => {
    const settings = loadSettings({ homeDir: directory, includeProject: false }).settings;
    const selected = BUILTIN_PROFILES.find((p) => p.id !== settings.defaultModel)!;
    persistDefaultModel(selected, settings, { homeDir: directory });
    const stored = JSON.parse(
      fs.readFileSync(path.join(directory, '.kapibala', 'settings.json'), 'utf8'),
    );
    expect(stored.profiles.map((p: { id: string }) => p.id)).toEqual([selected.id]);
    expect(settings.defaultModel).toBe(selected.id);
  });
  it('does not update memory when storage fails', () => {
    const settings = loadSettings({ homeDir: directory, includeProject: false }).settings;
    const before = settings.defaultModel;
    const selected = BUILTIN_PROFILES.find((p) => p.id !== before)!;
    expect(() =>
      persistDefaultModel(selected, settings, {
        homeDir: directory,
        saveSettings: () => {
          throw new Error('write failed');
        },
      }),
    ).toThrow('write failed');
    expect(settings.defaultModel).toBe(before);
  });
});
