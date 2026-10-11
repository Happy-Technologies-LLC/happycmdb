import path from 'path';
import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';

// The sibling design-system package is absent in isolated worktrees. Only the
// global-controls component tests need its Icon while exercising real API hooks.
export default mergeConfig(base, defineConfig({
  resolve: {
    alias: {
      '@happy-technologies/design-system': path.resolve(__dirname, './src/tests/mocks/design-system.tsx'),
    },
  },
}));
