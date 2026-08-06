import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { classifyError } from './errors.js';

describe('classifyError — LeaveWindowNotExpired (6079)', () => {
  it('classifies 6079 (decimal "Error Number") as not_ready', () => {
    const err = new Error(
      'finalize_gone: AnchorError caused by account: gateway. Error Code: LeaveWindowNotExpired. Error Number: 6079.',
    );
    assert.equal(classifyError(err), 'not_ready');
  });

  it('classifies 0x17bf (hex custom program error = 6079) as not_ready', () => {
    const err = new Error(
      'Transaction simulation failed: custom program error: 0x17bf',
    );
    assert.equal(classifyError(err), 'not_ready');
  });

  it('still classifies an unmapped program error as real', () => {
    const err = new Error('some failure. Error Number: 9999.');
    assert.equal(classifyError(err), 'real');
  });
});
