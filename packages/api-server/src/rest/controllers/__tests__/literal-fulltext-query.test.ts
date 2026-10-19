// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import { literalFulltextQuery } from '../literal-fulltext-query';

it('treats reserved Boolean operators and punctuation as literal search terms', () => {
  expect(literalFulltextQuery('  OR  host:name* && NOT  '))
    .toBe('"OR"  host\\:name\\* \\&\\& "NOT"');
});
