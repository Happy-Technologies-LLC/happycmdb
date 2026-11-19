import config from './vitest.config';

// CI runs these regressions with this config name. The design system is an installed dependency
// (@happy-technologies/design-system), so the connector screens render the real components here.
export default config;
