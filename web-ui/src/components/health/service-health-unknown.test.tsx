// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('axios', () => ({ default: { create: () => ({
  get, interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
}) } }));
// Only Icon is stubbed (the assertions read its name); the rest of the design system is the real one. CI also runs
// this file with vitest.connector-wizard.config.ts, which aliases the module to an Icon-only stub so no design-system
// checkout is needed: the plain stand-ins below fill what that stub lacks and are overridden by the real components.
vi.mock('@happy-technologies/design-system', async (importOriginal) => {
  const plain = ({ children, title, label, description, action }: Record<string, ReactNode>) => (
    <div>{title}{label}{description}{children}{action}</div>
  );
  const plainButton = ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  );
  return {
    Badge: plain, Banner: plain, Card: plain, EmptyState: plain, PageHeader: plain, SectionHeading: plain, Skeleton: plain,
    Button: plainButton,
    ...(await importOriginal<typeof import('@happy-technologies/design-system')>()),
    Icon: ({ name }: { name: string }) => <span data-icon={name} />,
  };
});
import { HealthDashboard } from './HealthDashboard';
import { ServiceHealthDots } from '../layout/ServiceHealthDots';

const at = '2026-01-01T00:00:00Z';
const renderWithQuery = (ui: ReactNode) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter>{ui}</MemoryRouter>
  </QueryClientProvider>,
);

it('HealthDashboard shows an unknown component as not probed, never as failed or measured', async () => {
  get.mockResolvedValue({ data: [
    { service: 'Neo4j', status: 'healthy', last_check: at, response_time_ms: 3 },
    { service: 'Redis', status: 'down', last_check: at },
    { service: 'ETL Processor', status: 'unknown', last_check: at },
  ] });
  renderWithQuery(<HealthDashboard />);
  await waitFor(() => expect(screen.getByText('ETL Processor')).toBeInTheDocument());
  // The service name's grandparent holds the status icon, the name and the latency text.
  const card = (name: string) => screen.getByText(name).parentElement!.parentElement!;
  const icon = (name: string) => card(name).querySelector('[data-icon]')!.getAttribute('data-icon');
  expect(icon('ETL Processor')).toBe('question');
  expect(within(card('ETL Processor')).getByText('Not probed')).toBeInTheDocument();
  expect(icon('Redis')).toBe('x-circle');
  expect(icon('Neo4j')).toBe('check-circle');
  expect(within(card('Neo4j')).getByText('3ms')).toBeInTheDocument();
});

it('the topbar service dots paint an unknown graph dot neutral and without the live pulse', async () => {
  get.mockResolvedValue({ data: [
    { service: 'Neo4j', status: 'unknown', last_check: at },
    { service: 'Data Mart', status: 'down', last_check: at },
  ] });
  renderWithQuery(<ServiceHealthDots />);
  const dot = (title: string) => screen.getByTitle(title).firstElementChild!.className;
  // The mart dot turning red proves the services query has rendered.
  await waitFor(() => expect(dot('Data mart: down')).toContain('hh-danger'));
  const graph = dot('Neo4j graph: unknown');
  expect(graph).toContain('bg-[var(--hh-border-strong)]');
  expect(graph).not.toContain('undefined');
  expect(graph).not.toContain('animate-');
});
