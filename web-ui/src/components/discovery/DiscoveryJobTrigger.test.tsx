// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithQueryClient } from '@/tests/utils/test-utils';
import DiscoveryJobTrigger from './DiscoveryJobTrigger';
import * as useDiscoveryHook from '@hooks/useDiscovery';
import * as useDiscoveryDefinitionsHook from '@hooks/useDiscoveryDefinitions';
import { mockApiHandlers } from '@/tests/mocks/handlers';

// Mock the hooks
vi.mock('@hooks/useDiscovery');
vi.mock('@hooks/useDiscoveryDefinitions');

// Mock navigate
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// Capture callbacks passed to DiscoveryDefinitionForm
let capturedProps: any = {};
vi.mock('./DiscoveryDefinitionForm', () => ({
  default: (props: any) => {
    capturedProps = props;
    return (
      <div data-testid="discovery-definition-form">
        <span data-testid="show-adhoc">{String(props.showAdHocAction)}</span>
        <button
          data-testid="adhoc-run-btn"
          onClick={() =>
            props.onAdHocRun?.({
              provider: 'nmap',
              config: { targets: ['192.168.1.0/24'] },
              name: 'Test Scan',
              schedule: { enabled: false },
            })
          }
        >
          Ad Hoc Run
        </button>
        <button
          data-testid="save-run-btn"
          onClick={() =>
            props.onSubmit({
              provider: 'ssh',
              config: { hosts: ['10.0.0.1'] },
              name: 'SSH Scan',
              schedule: { enabled: false },
            })
          }
        >
          Save & Run
        </button>
        <button
          data-testid="cancel-btn"
          onClick={() => props.onCancel()}
        >
          Cancel
        </button>
      </div>
    );
  },
}));

describe('DiscoveryJobTrigger Component', () => {
  const mockTriggerJob = vi.fn();
  const mockCreateDefinition = vi.fn();

  const defaultDiscoveryMock = {
    stats: [],
    schedules: [],
    loading: false,
    error: null,
    loadStats: vi.fn(),
    loadSchedules: vi.fn(),
    triggerJob: mockTriggerJob,
    updateSchedule: vi.fn(),
    testCredentials: vi.fn(),
    retryJob: vi.fn(),
    cancelJob: vi.fn(),
    getJobResult: vi.fn(),
  };

  const defaultDefinitionsMock = {
    definitions: [],
    loading: false,
    error: null,
    filters: {},
    loadDefinitions: vi.fn(),
    createDefinition: mockCreateDefinition,
    updateDefinition: vi.fn(),
    deleteDefinition: vi.fn(),
    runDefinition: vi.fn(),
    enableSchedule: vi.fn(),
    disableSchedule: vi.fn(),
    setFilters: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    capturedProps = {};
    vi.mocked(useDiscoveryHook.useDiscovery).mockReturnValue(defaultDiscoveryMock as any);
    vi.mocked(useDiscoveryDefinitionsHook.useDiscoveryDefinitions).mockReturnValue(
      defaultDefinitionsMock as any
    );
  });

  it('renders the Ad Hoc Discovery heading and description', () => {
    renderWithQueryClient(<DiscoveryJobTrigger />);

    expect(screen.getByText('Ad Hoc Discovery')).toBeInTheDocument();
    expect(
      screen.getByText(/run a one-time discovery job/i)
    ).toBeInTheDocument();
  });

  it('renders an info alert with usage instructions', () => {
    renderWithQueryClient(<DiscoveryJobTrigger />);

    expect(
      screen.getByText(/configure your discovery settings below/i)
    ).toBeInTheDocument();
  });

  it('renders the DiscoveryDefinitionForm', () => {
    renderWithQueryClient(<DiscoveryJobTrigger />);

    expect(screen.getByTestId('discovery-definition-form')).toBeInTheDocument();
  });

  it('passes showAdHocAction=true to the form', () => {
    renderWithQueryClient(<DiscoveryJobTrigger />);

    expect(screen.getByTestId('show-adhoc')).toHaveTextContent('true');
  });

  it('triggers an ad-hoc discovery job and navigates on success', async () => {
    const user = userEvent.setup();
    mockTriggerJob.mockResolvedValue(mockApiHandlers.triggerDiscoveryJob.success);

    renderWithQueryClient(<DiscoveryJobTrigger />);

    await user.click(screen.getByTestId('adhoc-run-btn'));

    await waitFor(() => {
      expect(mockTriggerJob).toHaveBeenCalledWith({
        provider: 'nmap',
        config: { targets: ['192.168.1.0/24'] },
      });
    });

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/discovery?tab=jobs');
    });
  });

  it('does not navigate when ad-hoc trigger returns null (failure)', async () => {
    const user = userEvent.setup();
    mockTriggerJob.mockResolvedValue(null);

    renderWithQueryClient(<DiscoveryJobTrigger />);

    await user.click(screen.getByTestId('adhoc-run-btn'));

    await waitFor(() => {
      expect(mockTriggerJob).toHaveBeenCalled();
    });

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('saves definition then triggers ad-hoc job on Save & Run', async () => {
    const user = userEvent.setup();
    mockCreateDefinition.mockResolvedValue(undefined);
    mockTriggerJob.mockResolvedValue(mockApiHandlers.triggerDiscoveryJob.success);

    renderWithQueryClient(<DiscoveryJobTrigger />);

    await user.click(screen.getByTestId('save-run-btn'));

    await waitFor(() => {
      expect(mockCreateDefinition).toHaveBeenCalledWith({
        provider: 'ssh',
        config: { hosts: ['10.0.0.1'] },
        name: 'SSH Scan',
        schedule: { enabled: false },
      });
    });

    await waitFor(() => {
      expect(mockTriggerJob).toHaveBeenCalledWith({
        provider: 'ssh',
        config: { hosts: ['10.0.0.1'] },
      });
    });
  });

  it('does not trigger job when createDefinition fails on Save & Run', async () => {
    const user = userEvent.setup();
    mockCreateDefinition.mockRejectedValue(new Error('Creation failed'));

    renderWithQueryClient(<DiscoveryJobTrigger />);

    await user.click(screen.getByTestId('save-run-btn'));

    await waitFor(() => {
      expect(mockCreateDefinition).toHaveBeenCalled();
    });

    // triggerJob should NOT be called because createDefinition failed
    expect(mockTriggerJob).not.toHaveBeenCalled();
  });

  it('navigates to dashboard on cancel', async () => {
    const user = userEvent.setup();

    renderWithQueryClient(<DiscoveryJobTrigger />);

    await user.click(screen.getByTestId('cancel-btn'));

    expect(mockNavigate).toHaveBeenCalledWith('/discovery?tab=dashboard');
  });

  it('passes onAdHocRun callback to the form', () => {
    renderWithQueryClient(<DiscoveryJobTrigger />);

    expect(capturedProps.onAdHocRun).toBeDefined();
    expect(typeof capturedProps.onAdHocRun).toBe('function');
  });

  it('passes onSubmit callback to the form', () => {
    renderWithQueryClient(<DiscoveryJobTrigger />);

    expect(capturedProps.onSubmit).toBeDefined();
    expect(typeof capturedProps.onSubmit).toBe('function');
  });

  it('passes onCancel callback to the form', () => {
    renderWithQueryClient(<DiscoveryJobTrigger />);

    expect(capturedProps.onCancel).toBeDefined();
    expect(typeof capturedProps.onCancel).toBe('function');
  });
});
