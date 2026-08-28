import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Logger, LOG_LEVEL } from '../src/logger.mjs';
import { Tracer } from '../src/tracer.mjs';

describe('LOG_LEVEL', () => {
  it('has expected values', () => {
    assert.equal(LOG_LEVEL.DEBUG, 0);
    assert.equal(LOG_LEVEL.INFO, 1);
    assert.equal(LOG_LEVEL.WARN, 2);
    assert.equal(LOG_LEVEL.ERROR, 3);
  });

  it('is frozen', () => {
    assert.ok(Object.isFrozen(LOG_LEVEL));
  });
});

describe('Logger', () => {
  it('logs at all levels', () => {
    const logger = new Logger();
    logger.debug('mod', 'debug msg');
    logger.info('mod', 'info msg');
    logger.warn('mod', 'warn msg');
    logger.error('mod', 'error msg');
    const entries = logger.snapshot();
    assert.equal(entries.length, 4);
    assert.equal(entries[0].level, LOG_LEVEL.DEBUG);
    assert.equal(entries[1].level, LOG_LEVEL.INFO);
    assert.equal(entries[2].level, LOG_LEVEL.WARN);
    assert.equal(entries[3].level, LOG_LEVEL.ERROR);
  });

  it('snapshot filters by module', () => {
    const logger = new Logger();
    logger.info('a', 'from a');
    logger.info('b', 'from b');
    const filtered = logger.snapshot({ module: 'a' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].module, 'a');
  });

  it('snapshot filters by minLevel', () => {
    const logger = new Logger();
    logger.debug('m', 'low');
    logger.error('m', 'high');
    const filtered = logger.snapshot({ minLevel: LOG_LEVEL.ERROR });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].level, LOG_LEVEL.ERROR);
  });

  it('forModule creates scoped logger', () => {
    const logger = new Logger();
    const log = logger.forModule('myMod');
    log.info('test message');
    const entries = logger.snapshot();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].module, 'myMod');
    assert.equal(entries[0].message, 'test message');
  });

  it('pipes to tracer when provided', () => {
    const tracer = new Tracer();
    const logger = new Logger({ tracer });
    logger.info('mod', 'hello');
    const events = tracer.snapshot();
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'log');
    assert.equal(events[0].message, 'hello');
  });

  it('evict-half at capacity', () => {
    const logger = new Logger({ capacity: 4 });
    for (let i = 0; i < 5; i++) logger.info('m', `msg ${i}`);
    const entries = logger.snapshot();
    assert.ok(entries.length <= 4);
    assert.ok(entries.length >= 2);
  });

  it('entries() async iterable with filter', async () => {
    const logger = new Logger();
    const iter = logger.entries({ minLevel: LOG_LEVEL.WARN })[Symbol.asyncIterator]();

    queueMicrotask(() => {
      logger.debug('m', 'skip');
      logger.warn('m', 'catch');
    });

    const result = await iter.next();
    assert.equal(result.value.level, LOG_LEVEL.WARN);
    assert.equal(result.value.message, 'catch');
    await iter.return();
  });
});
