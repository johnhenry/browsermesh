// Run with: node --import ./test/_setup-globals.mjs --test test/acl.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ScopeTemplate,
  DEFAULT_TEMPLATES,
  RosterEntry,
  InvitationToken,
  MeshACL,
} from '../src/acl.mjs';

// ---------------------------------------------------------------------------
// ScopeTemplate
// ---------------------------------------------------------------------------

describe('ScopeTemplate', () => {
  it('constructs with name and scopes', () => {
    const t = new ScopeTemplate({ name: 'viewer', scopes: ['chat:read', 'files:read'] });
    assert.equal(t.name, 'viewer');
    assert.deepEqual(t.scopes, ['chat:read', 'files:read']);
    assert.equal(t.description, undefined);
  });

  it('stores optional description', () => {
    const t = new ScopeTemplate({ name: 'x', scopes: ['*:*'], description: 'full access' });
    assert.equal(t.description, 'full access');
  });

  it('matches exact scope', () => {
    const t = new ScopeTemplate({ name: 'v', scopes: ['chat:read', 'files:read'] });
    assert.ok(t.matches('chat:read'));
    assert.ok(t.matches('files:read'));
    assert.ok(!t.matches('chat:write'));
  });

  it('matches wildcard scope', () => {
    const t = new ScopeTemplate({ name: 'admin', scopes: ['*:*'] });
    assert.ok(t.matches('chat:read'));
    assert.ok(t.matches('files:write'));
    assert.ok(t.matches('anything:else'));
  });

  it('matches partial wildcard', () => {
    const t = new ScopeTemplate({ name: 'chatter', scopes: ['chat:*'] });
    assert.ok(t.matches('chat:read'));
    assert.ok(t.matches('chat:write'));
    assert.ok(!t.matches('files:read'));
  });

  it('round-trips via JSON', () => {
    const t = new ScopeTemplate({ name: 'v', scopes: ['a:b'], description: 'desc' });
    const t2 = ScopeTemplate.fromJSON(t.toJSON());
    assert.equal(t2.name, 'v');
    assert.deepEqual(t2.scopes, ['a:b']);
    assert.equal(t2.description, 'desc');
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_TEMPLATES
// ---------------------------------------------------------------------------

describe('DEFAULT_TEMPLATES', () => {
  it('is frozen', () => {
    assert.ok(Object.isFrozen(DEFAULT_TEMPLATES));
  });

  it('has guest, collaborator, admin', () => {
    assert.ok(DEFAULT_TEMPLATES.guest);
    assert.ok(DEFAULT_TEMPLATES.collaborator);
    assert.ok(DEFAULT_TEMPLATES.admin);
  });

  it('guest covers chat:read and files:read', () => {
    assert.ok(DEFAULT_TEMPLATES.guest.matches('chat:read'));
    assert.ok(DEFAULT_TEMPLATES.guest.matches('files:read'));
    assert.ok(!DEFAULT_TEMPLATES.guest.matches('chat:write'));
  });

  it('collaborator covers chat:* and files:*', () => {
    assert.ok(DEFAULT_TEMPLATES.collaborator.matches('chat:read'));
    assert.ok(DEFAULT_TEMPLATES.collaborator.matches('chat:write'));
    assert.ok(DEFAULT_TEMPLATES.collaborator.matches('files:read'));
    assert.ok(DEFAULT_TEMPLATES.collaborator.matches('files:write'));
    assert.ok(DEFAULT_TEMPLATES.collaborator.matches('compute:submit'));
  });

  it('admin covers everything', () => {
    assert.ok(DEFAULT_TEMPLATES.admin.matches('anything:at:all'));
  });
});

// ---------------------------------------------------------------------------
// RosterEntry
// ---------------------------------------------------------------------------

describe('RosterEntry', () => {
  it('constructs with required fields', () => {
    const e = new RosterEntry({ identity: 'fp1', templateName: 'guest' });
    assert.equal(e.identity, 'fp1');
    assert.equal(e.templateName, 'guest');
    assert.ok(!e.isExpired());
  });

  it('respects expires', () => {
    const past = Date.now() - 10000;
    const e = new RosterEntry({ identity: 'fp1', templateName: 'guest', expires: past });
    assert.ok(e.isExpired());
  });

  it('not expired when expires is in the future', () => {
    const future = Date.now() + 60000;
    const e = new RosterEntry({ identity: 'fp1', templateName: 'guest', expires: future });
    assert.ok(!e.isExpired());
  });

  it('stores optional fields', () => {
    const e = new RosterEntry({
      identity: 'fp1',
      templateName: 'collaborator',
      scopes: ['extra:scope'],
      quotas: { maxCalls: 100 },
      label: 'My friend',
      expires: 9999999999999,
    });
    assert.deepEqual(e.scopes, ['extra:scope']);
    assert.deepEqual(e.quotas, { maxCalls: 100 });
    assert.equal(e.label, 'My friend');
  });

  it('round-trips via JSON', () => {
    const e = new RosterEntry({
      identity: 'fp1',
      templateName: 'admin',
      label: 'boss',
      expires: 9999999999999,
    });
    const e2 = RosterEntry.fromJSON(e.toJSON());
    assert.equal(e2.identity, 'fp1');
    assert.equal(e2.templateName, 'admin');
    assert.equal(e2.label, 'boss');
    assert.equal(e2.expires, 9999999999999);
  });
});

// ---------------------------------------------------------------------------
// InvitationToken
// ---------------------------------------------------------------------------

describe('InvitationToken', () => {
  it('constructs with owner and templateName', () => {
    const tok = new InvitationToken({ owner: 'fp_owner', templateName: 'guest' });
    assert.equal(tok.owner, 'fp_owner');
    assert.equal(tok.templateName, 'guest');
    assert.ok(typeof tok.nonce === 'string');
    assert.ok(tok.nonce.length > 0);
  });

  it('auto-generates nonce if not provided', () => {
    const a = new InvitationToken({ owner: 'x', templateName: 'guest' });
    const b = new InvitationToken({ owner: 'x', templateName: 'guest' });
    assert.notEqual(a.nonce, b.nonce);
  });

  it('uses provided nonce', () => {
    const tok = new InvitationToken({ owner: 'x', templateName: 'guest', nonce: 'fixed' });
    assert.equal(tok.nonce, 'fixed');
  });

  it('defaults to 15 min expiry', () => {
    const before = Date.now();
    const tok = new InvitationToken({ owner: 'x', templateName: 'guest' });
    const after = Date.now();
    // 15 min = 900000ms
    assert.ok(tok.expires >= before + 900000);
    assert.ok(tok.expires <= after + 900000);
  });

  it('accepts custom expires', () => {
    const tok = new InvitationToken({ owner: 'x', templateName: 'guest', expires: 12345 });
    assert.equal(tok.expires, 12345);
  });

  it('isExpired returns true when expired', () => {
    const tok = new InvitationToken({ owner: 'x', templateName: 'guest', expires: 1 });
    assert.ok(tok.isExpired());
  });

  it('isUsed / markUsed', () => {
    const tok = new InvitationToken({ owner: 'x', templateName: 'guest' });
    assert.ok(!tok.isUsed());
    tok.markUsed();
    assert.ok(tok.isUsed());
  });

  it('round-trips via JSON', () => {
    const tok = new InvitationToken({ owner: 'o', templateName: 'admin', nonce: 'n1' });
    const tok2 = InvitationToken.fromJSON(tok.toJSON());
    assert.equal(tok2.owner, 'o');
    assert.equal(tok2.templateName, 'admin');
    assert.equal(tok2.nonce, 'n1');
  });
});

// ---------------------------------------------------------------------------
// MeshACL — template management
// ---------------------------------------------------------------------------

describe('MeshACL template management', () => {
  let acl;
  beforeEach(() => {
    acl = new MeshACL({ owner: 'owner_fp' });
  });

  it('starts with default templates', () => {
    const templates = acl.listTemplates();
    const names = templates.map(t => t.name);
    assert.ok(names.includes('guest'));
    assert.ok(names.includes('collaborator'));
    assert.ok(names.includes('admin'));
  });

  it('addTemplate creates a new template', () => {
    const t = acl.addTemplate('viewer', ['files:read'], 'Read only');
    assert.equal(t.name, 'viewer');
    assert.ok(acl.getTemplate('viewer'));
  });

  it('removeTemplate removes a template', () => {
    acl.addTemplate('temp', ['x:y']);
    assert.ok(acl.removeTemplate('temp'));
    assert.equal(acl.getTemplate('temp'), null);
  });

  it('removeTemplate returns false for unknown', () => {
    assert.ok(!acl.removeTemplate('nonexistent'));
  });
});

// ---------------------------------------------------------------------------
// MeshACL — roster management
// ---------------------------------------------------------------------------

describe('MeshACL roster management', () => {
  let acl;
  beforeEach(() => {
    acl = new MeshACL({ owner: 'owner_fp' });
  });

  it('addEntry creates a roster entry', () => {
    const entry = acl.addEntry('fp1', 'guest');
    assert.equal(entry.identity, 'fp1');
    assert.equal(entry.templateName, 'guest');
  });

  it('addEntry with options', () => {
    const entry = acl.addEntry('fp1', 'collaborator', {
      label: 'Bob',
      expires: 9999999999999,
      quotas: { maxCalls: 50 },
    });
    assert.equal(entry.label, 'Bob');
    assert.equal(entry.expires, 9999999999999);
    assert.deepEqual(entry.quotas, { maxCalls: 50 });
  });

  it('addEntry throws for unknown template', () => {
    assert.throws(() => acl.addEntry('fp1', 'nonexistent'), Error);
  });

  it('getEntry retrieves existing entry', () => {
    acl.addEntry('fp1', 'guest');
    const e = acl.getEntry('fp1');
    assert.ok(e);
    assert.equal(e.identity, 'fp1');
  });

  it('getEntry returns null for missing', () => {
    assert.equal(acl.getEntry('nobody'), null);
  });

  it('removeEntry removes entry', () => {
    acl.addEntry('fp1', 'guest');
    assert.ok(acl.removeEntry('fp1'));
    assert.equal(acl.getEntry('fp1'), null);
  });

  it('listEntries returns all entries', () => {
    acl.addEntry('fp1', 'guest');
    acl.addEntry('fp2', 'admin');
    assert.equal(acl.listEntries().length, 2);
  });
});

// ---------------------------------------------------------------------------
// MeshACL — access checking
// ---------------------------------------------------------------------------

describe('MeshACL access checking', () => {
  let acl;
  beforeEach(() => {
    acl = new MeshACL({ owner: 'owner_fp' });
  });

  it('owner always has access', () => {
    const result = acl.check('owner_fp', 'anything', 'do');
    assert.ok(result.allowed);
  });

  it('guest can read chat', () => {
    acl.addEntry('fp1', 'guest');
    const result = acl.check('fp1', 'chat', 'read');
    assert.ok(result.allowed);
  });

  it('guest cannot write chat', () => {
    acl.addEntry('fp1', 'guest');
    const result = acl.check('fp1', 'chat', 'write');
    assert.ok(!result.allowed);
  });

  it('collaborator can write files', () => {
    acl.addEntry('fp1', 'collaborator');
    const result = acl.check('fp1', 'files', 'write');
    assert.ok(result.allowed);
  });

  it('admin can do anything', () => {
    acl.addEntry('fp1', 'admin');
    const result = acl.check('fp1', 'random', 'anything');
    assert.ok(result.allowed);
  });

  it('unknown identity is denied', () => {
    const result = acl.check('stranger', 'chat', 'read');
    assert.ok(!result.allowed);
  });

  it('expired entry is denied', () => {
    acl.addEntry('fp1', 'admin', { expires: 1 }); // expired
    const result = acl.check('fp1', 'chat', 'read');
    assert.ok(!result.allowed);
  });
});

// ---------------------------------------------------------------------------
// MeshACL — invitation flow
// ---------------------------------------------------------------------------

describe('MeshACL invitation flow', () => {
  let acl;
  beforeEach(() => {
    acl = new MeshACL({ owner: 'owner_fp' });
  });

  it('createInvitation returns a token', () => {
    const tok = acl.createInvitation('guest');
    assert.ok(tok instanceof InvitationToken);
    assert.equal(tok.owner, 'owner_fp');
    assert.equal(tok.templateName, 'guest');
  });

  it('createInvitation throws for unknown template', () => {
    assert.throws(() => acl.createInvitation('nonexistent'), Error);
  });

  it('redeemInvitation creates roster entry', () => {
    const tok = acl.createInvitation('guest');
    const entry = acl.redeemInvitation(tok, 'fp_new');
    assert.equal(entry.identity, 'fp_new');
    assert.equal(entry.templateName, 'guest');
    assert.ok(tok.isUsed());
  });

  it('redeemInvitation rejects expired token', () => {
    const tok = acl.createInvitation('guest', { expires: 1 });
    assert.throws(() => acl.redeemInvitation(tok, 'fp_new'), Error);
  });

  it('redeemInvitation rejects already-used token', () => {
    const tok = acl.createInvitation('guest');
    acl.redeemInvitation(tok, 'fp1');
    assert.throws(() => acl.redeemInvitation(tok, 'fp2'), Error);
  });
});

// ---------------------------------------------------------------------------
// MeshACL — revocation
// ---------------------------------------------------------------------------

describe('MeshACL revocation', () => {
  let acl;
  beforeEach(() => {
    acl = new MeshACL({ owner: 'owner_fp' });
  });

  it('revokeAll removes all access for identity', () => {
    acl.addEntry('fp1', 'admin');
    const count = acl.revokeAll('fp1');
    assert.equal(count, 1);
    assert.equal(acl.getEntry('fp1'), null);
  });

  it('revokeAll returns 0 for unknown identity', () => {
    assert.equal(acl.revokeAll('nobody'), 0);
  });
});

// ---------------------------------------------------------------------------
// MeshACL — maintenance
// ---------------------------------------------------------------------------

describe('MeshACL maintenance', () => {
  let acl;
  beforeEach(() => {
    acl = new MeshACL({ owner: 'owner_fp' });
  });

  it('pruneExpired removes expired entries', () => {
    acl.addEntry('fp1', 'guest', { expires: 1 });
    acl.addEntry('fp2', 'admin', { expires: 9999999999999 });
    const pruned = acl.pruneExpired();
    assert.equal(pruned, 1);
    assert.equal(acl.getEntry('fp1'), null);
    assert.ok(acl.getEntry('fp2'));
  });

  it('pruneExpired returns 0 when nothing to prune', () => {
    acl.addEntry('fp1', 'guest');
    assert.equal(acl.pruneExpired(), 0);
  });
});

// ---------------------------------------------------------------------------
// MeshACL — serialization
// ---------------------------------------------------------------------------

describe('MeshACL serialization', () => {
  it('round-trips via JSON', () => {
    const acl = new MeshACL({ owner: 'owner_fp' });
    acl.addTemplate('custom', ['x:y'], 'Custom template');
    acl.addEntry('fp1', 'guest', { label: 'Alice' });
    acl.addEntry('fp2', 'custom');

    const acl2 = MeshACL.fromJSON(acl.toJSON());
    assert.equal(acl2.owner, 'owner_fp');
    assert.ok(acl2.getTemplate('custom'));
    assert.ok(acl2.getEntry('fp1'));
    assert.equal(acl2.getEntry('fp1').label, 'Alice');
    assert.ok(acl2.getEntry('fp2'));
  });

  it('preserves access checking after round-trip', () => {
    const acl = new MeshACL({ owner: 'owner_fp' });
    acl.addEntry('fp1', 'collaborator');
    const acl2 = MeshACL.fromJSON(acl.toJSON());
    assert.ok(acl2.check('fp1', 'chat', 'write').allowed);
    assert.ok(!acl2.check('fp1', 'admin', 'nuke').allowed);
  });
});
