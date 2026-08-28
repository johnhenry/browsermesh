// Run with: node --import ./test/_setup-globals.mjs --test test/identity-base.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_IDENTITY,
  IDENTITY_TEMPLATES,
  detectIdentityFormat,
  validateAIEOS,
  compileSystemPrompt,
  IdentityManager,
} from '../src/identity-base.mjs';

// ── detectIdentityFormat ────────────────────────────────────────

describe('detectIdentityFormat', () => {
  it('returns "plain" for a string', () => {
    assert.equal(detectIdentityFormat('hello'), 'plain');
  });

  it('returns "aieos" for an object with version 1.x', () => {
    assert.equal(detectIdentityFormat({ version: '1.1' }), 'aieos');
    assert.equal(detectIdentityFormat({ version: '1.0' }), 'aieos');
  });

  it('returns "openclaw" for an object with files key', () => {
    assert.equal(detectIdentityFormat({ files: { identity: '...' } }), 'openclaw');
  });

  it('returns "plain" for null/undefined/number', () => {
    assert.equal(detectIdentityFormat(null), 'plain');
    assert.equal(detectIdentityFormat(undefined), 'plain');
    assert.equal(detectIdentityFormat(42), 'plain');
  });

  it('returns "plain" for an empty object', () => {
    assert.equal(detectIdentityFormat({}), 'plain');
  });
});

// ── validateAIEOS ───────────────────────────────────────────────

describe('validateAIEOS', () => {
  it('returns valid with defaults for an empty object', () => {
    const { valid, identity, errors } = validateAIEOS({});
    assert.equal(valid, true);
    assert.equal(errors.length, 0);
    assert.equal(identity.version, '1.1');
  });

  it('returns invalid for null', () => {
    const { valid, errors } = validateAIEOS(null);
    assert.equal(valid, false);
    assert.ok(errors.length > 0);
  });

  it('merges names from input', () => {
    const { identity } = validateAIEOS({
      names: { display: 'TestBot', full: 'Test Bot Full', aliases: ['tb'] },
    });
    assert.equal(identity.names.display, 'TestBot');
    assert.equal(identity.names.full, 'Test Bot Full');
    assert.deepEqual(identity.names.aliases, ['tb']);
  });

  it('preserves version string from input', () => {
    const { identity } = validateAIEOS({ version: '1.2' });
    assert.equal(identity.version, '1.2');
  });

  it('fills in default bio when not provided', () => {
    const { identity } = validateAIEOS({});
    assert.equal(identity.bio, DEFAULT_IDENTITY.bio);
  });

  it('uses custom bio when provided', () => {
    const { identity } = validateAIEOS({ bio: 'Custom bio' });
    assert.equal(identity.bio, 'Custom bio');
  });

  it('validates linguistics with numeric fields', () => {
    const { identity } = validateAIEOS({
      linguistics: { formality: 0.9, verbosity: 0.1, tone: 'formal' },
    });
    assert.equal(identity.linguistics.formality, 0.9);
    assert.equal(identity.linguistics.verbosity, 0.1);
    assert.equal(identity.linguistics.tone, 'formal');
  });

  it('fills in default linguistics for non-numeric values', () => {
    const { identity } = validateAIEOS({
      linguistics: { formality: 'high' },
    });
    assert.equal(identity.linguistics.formality, 0.5); // default
  });
});

// ── compileSystemPrompt ────────────────────────────────────────

describe('compileSystemPrompt', () => {
  it('returns plain text for string input', () => {
    const prompt = compileSystemPrompt('Hello agent');
    assert.ok(prompt.includes('Hello agent'));
  });

  it('includes display name for aieos identity', () => {
    const prompt = compileSystemPrompt({
      version: '1.1',
      names: { display: 'TestBot' },
      bio: 'A test bot.',
    });
    assert.ok(prompt.includes('TestBot'));
    assert.ok(prompt.includes('A test bot'));
  });

  it('appends context sections', () => {
    const prompt = compileSystemPrompt('base', {
      memoryPrompt: 'memory section',
      goalPrompt: 'goal section',
    });
    assert.ok(prompt.includes('base'));
    assert.ok(prompt.includes('memory section'));
    assert.ok(prompt.includes('goal section'));
  });

  it('handles openclaw format with files', () => {
    const prompt = compileSystemPrompt({
      files: { identity: 'I am an agent.', soul: 'I am curious.' },
    });
    assert.ok(prompt.includes('I am an agent.'));
    assert.ok(prompt.includes('I am curious.'));
  });

  it('handles null/empty gracefully', () => {
    const prompt = compileSystemPrompt(null);
    assert.equal(typeof prompt, 'string');
  });
});

// ── IdentityManager ────────────────────────────────────────────

describe('IdentityManager', () => {
  it('constructor defaults to DEFAULT_IDENTITY', () => {
    const mgr = new IdentityManager();
    assert.equal(mgr.format, 'aieos');
    assert.equal(mgr.displayName, 'Clawser');
  });

  it('load() detects format and stores identity', () => {
    const mgr = new IdentityManager();
    mgr.load('simple prompt');
    assert.equal(mgr.format, 'plain');
    assert.equal(mgr.identity, 'simple prompt');
  });

  it('load() validates aieos input', () => {
    const mgr = new IdentityManager();
    mgr.load({ version: '1.1', names: { display: 'Bot' } });
    assert.equal(mgr.format, 'aieos');
    assert.equal(mgr.displayName, 'Bot');
  });

  it('compile() returns a string', () => {
    const mgr = new IdentityManager();
    const prompt = mgr.compile();
    assert.equal(typeof prompt, 'string');
    assert.ok(prompt.length > 0);
  });

  it('reset() restores default identity', () => {
    const mgr = new IdentityManager();
    mgr.load('custom');
    mgr.reset();
    assert.equal(mgr.format, 'aieos');
    assert.equal(mgr.displayName, 'Clawser');
  });

  it('toJSON() and fromJSON() round-trip', () => {
    const mgr = new IdentityManager({ version: '1.1', names: { display: 'X' } });
    const json = mgr.toJSON();
    const restored = IdentityManager.fromJSON(json);
    assert.equal(restored.format, mgr.format);
  });

  it('fromJSON() returns default manager for null input', () => {
    const mgr = IdentityManager.fromJSON(null);
    assert.equal(mgr.format, 'aieos');
  });

  it('loadFromFiles() sets openclaw format', () => {
    const mgr = new IdentityManager();
    mgr.loadFromFiles({ identity: 'I am agent', soul: 'curious' });
    assert.equal(mgr.format, 'openclaw');
  });

  it('fromTemplate() creates from known template', () => {
    const mgr = IdentityManager.fromTemplate('coding_assistant');
    assert.equal(mgr.displayName, 'CodeBot');
    assert.equal(mgr.format, 'aieos');
  });

  it('fromTemplate() throws for unknown template', () => {
    assert.throws(() => IdentityManager.fromTemplate('nonexistent'), /Unknown template/);
  });

  it('listTemplates() returns array with expected keys', () => {
    const templates = IdentityManager.listTemplates();
    assert.ok(Array.isArray(templates));
    assert.ok(templates.length >= 4);
    assert.ok(templates.every(t => t.key && t.name && t.description));
  });

  it('getCurrent() returns the in-memory identity (method-form alias)', () => {
    // Closes the silent ghost-method bug: clawser-ui-chat.js read the
    // active identity via `state.identityManager?.getCurrent?.()` to
    // pull the agent-message avatar URL, but `getCurrent` did not
    // exist — every agent message rendered without the avatar.
    const mgr = new IdentityManager({
      version: '1.1',
      names: { display: 'TestBot' },
      physicality: { avatar_url: 'https://example.com/a.png' },
    });
    const cur = mgr.getCurrent();
    assert.ok(cur);
    assert.equal(cur.names.display, 'TestBot');
    assert.equal(cur.physicality.avatar_url, 'https://example.com/a.png');
    // It should reference the same object as the `identity` getter.
    assert.equal(mgr.getCurrent(), mgr.identity);
  });
});

// ── IDENTITY_TEMPLATES ──────────────────────────────────────────

describe('IDENTITY_TEMPLATES', () => {
  it('contains known templates', () => {
    assert.ok(IDENTITY_TEMPLATES.coding_assistant);
    assert.ok(IDENTITY_TEMPLATES.creative_writer);
    assert.ok(IDENTITY_TEMPLATES.research_analyst);
    assert.ok(IDENTITY_TEMPLATES.productivity_coach);
  });

  it('each template has required AIEOS fields', () => {
    for (const [, tmpl] of Object.entries(IDENTITY_TEMPLATES)) {
      assert.ok(tmpl.version);
      assert.ok(tmpl.names?.display);
      assert.ok(tmpl.bio);
    }
  });
});
