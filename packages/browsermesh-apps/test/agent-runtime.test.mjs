// Run with: node --import ./test/_setup-globals.mjs --test test/agent-runtime.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRuntime } from '../src/agent-runtime.mjs';
import { BrowserTool, BrowserToolRegistry } from '../src/compat.mjs';
import { DhtStoreTool, DhtLookupTool, meshToolsContext } from '../src/tools.mjs';

// ---------------------------------------------------------------------------
// A tiny throwaway fake DHT -- just enough for DhtStoreTool/DhtLookupTool
// (real BrowserTool subclasses from tools.mjs) to exercise a real round trip
// through createAgentRuntime()'s dispatch loop, without pulling in a real
// mesh-dht.mjs node.
// ---------------------------------------------------------------------------
function makeFakeDht() {
  const data = new Map();
  return {
    store(key, value) { data.set(key, value); },
    findValue(key) {
      return data.has(key) ? { found: true, value: data.get(key) } : { found: false, closest: [] };
    },
  };
}

/** A tiny throwaway BrowserTool subclass whose execute() always throws, used to prove a rejecting tool doesn't crash the loop. */
class ThrowingTool extends BrowserTool {
  get name() { return 'throwing_tool'; }
  get description() { return 'Always throws, for testing dispatch error handling.'; }
  async execute() { throw new Error('boom'); }
}

/** A tiny throwaway BrowserTool subclass that always succeeds trivially, used for the maxTurns test (an llmFn that never stops requesting it). */
class NoopTool extends BrowserTool {
  get name() { return 'noop_tool'; }
  get description() { return 'Always succeeds trivially.'; }
  async execute() { return { success: true, output: 'ok' }; }
}

describe('createAgentRuntime -- constructor validation', () => {
  it('throws when registry is missing', () => {
    assert.throws(() => createAgentRuntime({ llmFn: async () => ({ content: 'hi' }) }), /registry is required/);
  });

  it('throws when registry does not look like a BrowserToolRegistry', () => {
    assert.throws(
      () => createAgentRuntime({ registry: {}, llmFn: async () => ({ content: 'hi' }) }),
      /registry is required/,
    );
  });

  it('throws when llmFn is missing', () => {
    const registry = new BrowserToolRegistry();
    assert.throws(() => createAgentRuntime({ registry }), /llmFn is required/);
  });

  it('throws when llmFn is not a function', () => {
    const registry = new BrowserToolRegistry();
    assert.throws(() => createAgentRuntime({ registry, llmFn: 'not a function' }), /llmFn is required/);
  });

  it('accepts a duck-typed registry (not an instanceof BrowserToolRegistry)', () => {
    const fakeRegistry = { listSpecs: () => [], get: () => undefined };
    assert.doesNotThrow(() => createAgentRuntime({ registry: fakeRegistry, llmFn: async () => ({ content: 'hi' }) }));
  });
});

describe('createAgentRuntime -- full round trip with real tools', () => {
  let registry;

  beforeEach(() => {
    meshToolsContext.setDhtNode(makeFakeDht());
    registry = new BrowserToolRegistry();
    registry.register(new DhtStoreTool());
    registry.register(new DhtLookupTool());
  });

  it('dispatches a real tool call and returns the final content on the second llmFn turn', async () => {
    const calls = [];
    const llmFn = async (messages, toolSpecs) => {
      calls.push({ messages: [...messages], toolSpecs });
      if (calls.length === 1) {
        return { toolCalls: [{ id: 'call_1', name: 'dht_store', arguments: { key: 'foo', value: 'bar' } }] };
      }
      return { content: 'Stored it!' };
    };

    const runtime = createAgentRuntime({ registry, llmFn });
    const result = await runtime.run('Please store foo=bar in the DHT.');

    assert.equal(result.content, 'Stored it!');
    assert.equal(result.toolCalls, undefined);
    assert.equal(result.truncated, undefined);
    assert.equal(calls.length, 2);

    // toolSpecs handed to llmFn are the registry's real .spec entries.
    const names = calls[0].toolSpecs.map((s) => s.name);
    assert.ok(names.includes('dht_store'));
    assert.ok(names.includes('dht_lookup'));

    // Message shape: user -> assistant(toolCalls) -> tool(result) -> assistant(content)
    const messages = runtime.getMessages();
    assert.equal(messages.length, 4);
    assert.deepEqual(messages[0], { role: 'user', content: 'Please store foo=bar in the DHT.' });
    assert.equal(messages[1].role, 'assistant');
    assert.equal(messages[1].toolCalls[0].name, 'dht_store');
    assert.equal(messages[2].role, 'tool');
    assert.equal(messages[2].tool_call_id, 'call_1');
    assert.equal(messages[2].name, 'dht_store');
    const parsed = JSON.parse(messages[2].content);
    assert.equal(parsed.success, true);
    assert.match(parsed.output, /Stored key "foo"/);
    assert.deepEqual(messages[3], { role: 'assistant', content: 'Stored it!' });

    // The second llmFn call saw the tool result in its messages.
    assert.equal(calls[1].messages.length, 3);
    assert.equal(calls[1].messages[2].role, 'tool');
  });

  it('a real tool actually mutates real state visible to a follow-up lookup', async () => {
    let turn = 0;
    const llmFn = async () => {
      turn++;
      if (turn === 1) {
        return { toolCalls: [{ id: 'c1', name: 'dht_store', arguments: { key: 'k', value: 'v1' } }] };
      }
      if (turn === 2) {
        return { toolCalls: [{ id: 'c2', name: 'dht_lookup', arguments: { key: 'k' } }] };
      }
      return { content: 'done' };
    };

    const runtime = createAgentRuntime({ registry, llmFn });
    await runtime.run('store then look up');

    const messages = runtime.getMessages();
    const lookupResultMsg = messages.find((m) => m.role === 'tool' && m.tool_call_id === 'c2');
    const parsed = JSON.parse(lookupResultMsg.content);
    assert.equal(parsed.success, true);
    assert.match(parsed.output, /k.*=.*"v1"/);
  });
});

describe('createAgentRuntime -- graceful degradation', () => {
  let registry;

  beforeEach(() => {
    registry = new BrowserToolRegistry();
  });

  it('synthesizes an error result for an unregistered tool name instead of crashing', async () => {
    let turn = 0;
    const llmFn = async () => {
      turn++;
      if (turn === 1) {
        return { toolCalls: [{ id: 'c1', name: 'does_not_exist', arguments: {} }] };
      }
      return { content: 'recovered' };
    };

    const runtime = createAgentRuntime({ registry, llmFn });
    const result = await runtime.run('call a bogus tool');

    assert.equal(result.content, 'recovered');
    const messages = runtime.getMessages();
    const toolMsg = messages.find((m) => m.role === 'tool');
    const parsed = JSON.parse(toolMsg.content);
    assert.equal(parsed.success, false);
    assert.match(parsed.error, /Unknown tool "does_not_exist"/);
  });

  it('synthesizes an error result when a real tool.execute() throws, instead of crashing', async () => {
    registry.register(new ThrowingTool());
    let turn = 0;
    const llmFn = async () => {
      turn++;
      if (turn === 1) {
        return { toolCalls: [{ id: 'c1', name: 'throwing_tool', arguments: {} }] };
      }
      return { content: 'still alive' };
    };

    const runtime = createAgentRuntime({ registry, llmFn });
    const result = await runtime.run('call the throwing tool');

    assert.equal(result.content, 'still alive');
    const messages = runtime.getMessages();
    const toolMsg = messages.find((m) => m.role === 'tool');
    const parsed = JSON.parse(toolMsg.content);
    assert.equal(parsed.success, false);
    assert.match(parsed.error, /boom/);
  });

  it('dispatches every call in a batch even when an earlier one fails', async () => {
    registry.register(new ThrowingTool());
    registry.register(new NoopTool());
    let turn = 0;
    const llmFn = async () => {
      turn++;
      if (turn === 1) {
        return {
          toolCalls: [
            { id: 'c1', name: 'throwing_tool', arguments: {} },
            { id: 'c2', name: 'noop_tool', arguments: {} },
          ],
        };
      }
      return { content: 'done' };
    };

    const runtime = createAgentRuntime({ registry, llmFn });
    await runtime.run('batch call');

    const messages = runtime.getMessages();
    const toolMsgs = messages.filter((m) => m.role === 'tool');
    assert.equal(toolMsgs.length, 2);
    assert.equal(JSON.parse(toolMsgs[0].content).success, false);
    assert.equal(JSON.parse(toolMsgs[1].content).success, true);
  });
});

describe('createAgentRuntime -- maxTurns', () => {
  it('stops after maxTurns llmFn calls and returns a truncated result rather than throwing', async () => {
    const registry = new BrowserToolRegistry();
    registry.register(new NoopTool());

    let calls = 0;
    const llmFn = async () => {
      calls++;
      // Never settles -- always asks for another tool call.
      return { toolCalls: [{ id: `c${calls}`, name: 'noop_tool', arguments: {} }] };
    };

    const runtime = createAgentRuntime({ registry, llmFn, maxTurns: 3 });
    const result = await runtime.run('loop forever');

    assert.equal(calls, 3);
    assert.equal(result.truncated, true);
    assert.ok(Array.isArray(result.toolCalls));
    assert.equal(result.toolCalls[0].name, 'noop_tool');
  });

  it('defaults maxTurns to 10 when not specified', async () => {
    const registry = new BrowserToolRegistry();
    registry.register(new NoopTool());

    let calls = 0;
    const llmFn = async () => {
      calls++;
      return { toolCalls: [{ id: `c${calls}`, name: 'noop_tool', arguments: {} }] };
    };

    const runtime = createAgentRuntime({ registry, llmFn });
    const result = await runtime.run('loop forever');

    assert.equal(calls, 10);
    assert.equal(result.truncated, true);
  });

  it('run() accepts a per-call maxTurns override', async () => {
    const registry = new BrowserToolRegistry();
    registry.register(new NoopTool());

    let calls = 0;
    const llmFn = async () => {
      calls++;
      return { toolCalls: [{ id: `c${calls}`, name: 'noop_tool', arguments: {} }] };
    };

    const runtime = createAgentRuntime({ registry, llmFn, maxTurns: 10 });
    const result = await runtime.run('loop forever', { maxTurns: 2 });

    assert.equal(calls, 2);
    assert.equal(result.truncated, true);
  });
});

describe('createAgentRuntime -- getMessages()/reset()', () => {
  it('getMessages returns a copy that does not affect internal state when mutated', async () => {
    const registry = new BrowserToolRegistry();
    const llmFn = async () => ({ content: 'hi' });
    const runtime = createAgentRuntime({ registry, llmFn });

    await runtime.run('hello');
    const snapshot = runtime.getMessages();
    snapshot.push({ role: 'user', content: 'sneaky mutation' });

    assert.equal(runtime.getMessages().length, 2);
  });

  it('reset() clears the running conversation for a fresh chat', async () => {
    const registry = new BrowserToolRegistry();
    const llmFn = async () => ({ content: 'hi' });
    const runtime = createAgentRuntime({ registry, llmFn });

    await runtime.run('hello');
    assert.equal(runtime.getMessages().length, 2);

    runtime.reset();
    assert.equal(runtime.getMessages().length, 0);

    await runtime.run('hello again');
    assert.equal(runtime.getMessages().length, 2);
  });

  it('supports a real multi-turn chat: run() called twice accumulates onto the same conversation', async () => {
    const registry = new BrowserToolRegistry();
    const seen = [];
    const llmFn = async (messages) => {
      seen.push(messages.length);
      return { content: `reply #${seen.length}` };
    };
    const runtime = createAgentRuntime({ registry, llmFn });

    const first = await runtime.run('first message');
    const second = await runtime.run('second message');

    assert.equal(first.content, 'reply #1');
    assert.equal(second.content, 'reply #2');
    // Second llmFn call saw the full history: user1, assistant1, user2.
    assert.equal(seen[1], 3);
    assert.equal(runtime.getMessages().length, 4);
  });
});
