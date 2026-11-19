import config from './vitest.config';

// CI runs the HAP-1210 / HAP-1234 / HAP-567 regression tests under this config.
// It resolves @happy-technologies/design-system to the real installed package,
// so components that render design-system primitives behave as in production.
export default config;
