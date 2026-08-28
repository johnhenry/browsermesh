/**
 * Stdio — standard I/O streams as ByteStreams.
 *
 * Provides stdin, stdout, stderr as ByteStream-compatible objects with
 * convenience methods for text output.
 *
 * @module stdio
 */

import { devNull } from './byte-stream.mjs';

const encoder = new TextEncoder();

/**
 * Standard I/O container wrapping ByteStream-compatible streams.
 */
export class Stdio {
  #stdin;
  #stdout;
  #stderr;

  /**
   * @param {Object} [opts={}]
   * @param {Object} [opts.stdin] - Input ByteStream (defaults to devNull).
   * @param {Object} [opts.stdout] - Output ByteStream (defaults to devNull).
   * @param {Object} [opts.stderr] - Error ByteStream (defaults to devNull).
   */
  constructor({ stdin, stdout, stderr } = {}) {
    this.#stdin = stdin || devNull();
    this.#stdout = stdout || devNull();
    this.#stderr = stderr || devNull();
  }

  /** Standard input stream. */
  get stdin() { return this.#stdin; }

  /** Standard output stream. */
  get stdout() { return this.#stdout; }

  /** Standard error stream. */
  get stderr() { return this.#stderr; }

  /**
   * Write text to stdout (without trailing newline).
   *
   * @param {string} text - Text to write.
   * @returns {Promise<void>}
   */
  async print(text) {
    await this.#stdout.write(encoder.encode(text));
  }

  /**
   * Write text to stdout with a trailing newline.
   *
   * @param {string} text - Text to write.
   * @returns {Promise<void>}
   */
  async println(text) {
    await this.#stdout.write(encoder.encode(text + '\n'));
  }
}
