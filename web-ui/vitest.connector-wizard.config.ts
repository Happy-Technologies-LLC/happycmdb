// The design system is an installed dependency, so these regression runs use the real package
// (HAP-1922: the credential screens render DS components, not only Icon). Kept as the config name the CI steps call.
export { default } from './vitest.config';
