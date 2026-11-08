// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1733: what the GraphQL server sends for an uncaught resolver throw (code
 * INTERNAL_SERVER_ERROR) carries no error text, originalError or stacktrace in
 * any NODE_ENV; client errors keep their text and code.
 */

import { SECRET } from '../../__tests__/support/throwing-deps';
import { formatGraphQLError } from '../server';

describe('formatGraphQLError', () => {
  const uncaught = {
    message: SECRET,
    extensions: { code: 'INTERNAL_SERVER_ERROR', originalError: SECRET, stacktrace: [`Error: ${SECRET}`, '    at resolver (x.ts:1:1)'] },
  };

  it.each(['production', 'development', 'test'])('answers an INTERNAL_SERVER_ERROR with fixed text and only its code (NODE_ENV=%s)', env => {
    const before = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = env;
    try {
      const out = formatGraphQLError(uncaught);
      expect(JSON.stringify(out)).not.toContain(SECRET);
      expect(out.extensions).toEqual({ code: 'INTERNAL_SERVER_ERROR' });
    } finally {
      process.env['NODE_ENV'] = before;
    }
  });

  it('keeps the text and code of a client error but never forwards a stacktrace', () => {
    const out = formatGraphQLError({ message: 'CI not found', extensions: { code: 'NOT_FOUND', stacktrace: ['at x'] } });
    expect(out).toEqual({ message: 'CI not found', extensions: { code: 'NOT_FOUND' } });
  });
});
