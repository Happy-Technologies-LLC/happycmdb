import path from 'node:path';
import { mergeConfig } from 'vitest/config';
import config from './vitest.config';

// The deployment test exercises the real wizard and API client; icons are decoration.
// Do not require a separate design-system checkout merely to run this regression.
export default mergeConfig(config, {
  resolve: {
    alias: {
      '@happy-technologies/design-system': path.resolve(__dirname, 'src/components/connectors/__tests__/design-system-icon.tsx'),
    },
  },
});
