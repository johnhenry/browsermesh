import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Router, parseAddress } from '../src/router.mjs';

describe('parseAddress', () => {
  it('parses scheme://host:port', () => {
    const r = parseAddress('tcp://example.com:443');
    assert.equal(r.scheme, 'tcp');
    assert.equal(r.host, 'example.com');
    assert.equal(r.port, 443);
  });

  it('parses mem:// scheme', () => {
    const r = parseAddress('mem://localhost:8080');
    assert.equal(r.scheme, 'mem');
    assert.equal(r.host, 'localhost');
    assert.equal(r.port, 8080);
  });

  it('parses loop:// scheme', () => {
    const r = parseAddress('loop://localhost:0');
    assert.equal(r.scheme, 'loop');
    assert.equal(r.port, 0);
  });

  it('parses IPv6 address', () => {
    const r = parseAddress('tcp://[::1]:8080');
    assert.equal(r.scheme, 'tcp');
    assert.equal(r.host, '::1');
    assert.equal(r.port, 8080);
  });

  it('parses IPv6 without port', () => {
    const r = parseAddress('tcp://[::1]');
    assert.equal(r.host, '::1');
    assert.equal(r.port, 0);
  });

  it('parses host without port', () => {
    const r = parseAddress('tcp://example.com');
    assert.equal(r.host, 'example.com');
    assert.equal(r.port, 0);
  });

  it('throws on missing scheme', () => {
    assert.throws(() => parseAddress('example.com:80'), /no scheme/);
  });
});

describe('Router', () => {
  it('routes mem:// to registered backend', () => {
    const router = new Router();
    const mockBackend = { name: 'loopback' };
    router.addRoute('mem', mockBackend);
    const { backend, parsed } = router.resolve('mem://localhost:8080');
    assert.equal(backend, mockBackend);
    assert.equal(parsed.scheme, 'mem');
    assert.equal(parsed.port, 8080);
  });

  it('routes tcp:// to registered backend', () => {
    const router = new Router();
    const mockGateway = { name: 'gateway' };
    router.addRoute('tcp', mockGateway);
    const { backend } = router.resolve('tcp://example.com:443');
    assert.equal(backend, mockGateway);
  });

  it('throws on unknown scheme', () => {
    const router = new Router();
    assert.throws(() => router.resolve('unknown://host:80'), { name: 'UnknownSchemeError' });
  });

  it('hasScheme', () => {
    const router = new Router();
    router.addRoute('mem', {});
    assert.equal(router.hasScheme('mem'), true);
    assert.equal(router.hasScheme('tcp'), false);
  });

  it('schemes list', () => {
    const router = new Router();
    router.addRoute('mem', {});
    router.addRoute('loop', {});
    assert.deepEqual(router.schemes.sort(), ['loop', 'mem']);
  });
});
