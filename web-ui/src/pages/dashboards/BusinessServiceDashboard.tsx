import React, { useId, useState, useEffect } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  IconWell,
  NativeSelect,
  PageHeader,
  ProgressBar,
  SectionHeading,
  TONE_LABEL,
  type StatusTone,
} from '@happy-technologies/design-system';
import { useBusinessServiceDashboard, useExportDashboard } from '@/hooks/useDashboardData';
import { KPICard } from '@/components/dashboard/KPICard';
import { QueryState } from '@/components/estate/SurfaceState';
import { brand } from '@/lib/brandColors';
import cytoscape from 'cytoscape';
import { UnavailableNotice } from '@/components/dashboard/UnavailableNotice';
import {
  EMPTY_VALUE,
  NOT_AVAILABLE,
  formatCount,
  formatCurrency,
  formatDecimal,
  formatPercent,
  isKnown,
  isUnavailable,
} from '@/lib/dashboardValue';

const COMPLIANCE_FRAMEWORK_COUNT = 4;

/** The tone of a health score: unknown is neutral (never a verdict), then healthy, warning, critical. */
function healthTone(score: number | null | undefined): StatusTone {
  if (!isKnown(score)) return 'neutral';
  if (score >= 80) return 'success';
  if (score >= 60) return 'warning';
  return 'danger';
}

/** A titled dashboard section: a labelled region with a heading and a one-line description. */
const Section: React.FC<{ title: string; description?: React.ReactNode; children: React.ReactNode }> = ({
  title,
  description,
  children,
}) => {
  const headingId = useId();
  return (
    <Card as="section" aria-labelledby={headingId}>
      <SectionHeading id={headingId} className="mb-1">
        {title}
      </SectionHeading>
      {description && <p className="mb-4 text-sm text-[var(--hh-text-muted)]">{description}</p>}
      {children}
    </Card>
  );
};

export const BusinessServiceDashboard: React.FC = () => {
  const [selectedService, setSelectedService] = useState<string>('');
  const [selectedBusinessUnit, setSelectedBusinessUnit] = useState<string>('');

  const {
    unavailable,
    serviceHealth,
    revenueAtRisk,
    customerImpact,
    complianceStatus,
    valueStreamHealth,
    serviceDependencies,
  } = useBusinessServiceDashboard(selectedService || undefined, selectedBusinessUnit || undefined);

  const { exportToPDF, exportToExcel } = useExportDashboard();

  const loading = serviceHealth.loading;
  const error = serviceHealth.error;

  // Initialize dependency graph
  useEffect(() => {
    if (serviceDependencies.data && !serviceDependencies.loading) {
      const container = document.getElementById('dependency-graph');
      if (container && serviceDependencies.data.nodes.length > 0) {
        const cy = cytoscape({
          container,
          elements: [
            ...serviceDependencies.data.nodes.map((node: any) => ({
              data: {
                id: node.id,
                label: node.label,
                type: node.type,
                healthScore: node.healthScore,
                status: node.status,
                layer: node.layer,
              },
            })),
            ...serviceDependencies.data.edges.map((edge: any) => ({
              data: {
                id: edge.id,
                source: edge.from,
                target: edge.to,
                label: edge.type,
                healthImpact: edge.healthImpact,
              },
            })),
          ],
          style: [
            {
              selector: 'node',
              style: {
                'background-color': (ele: any) => {
                  const health = ele.data('healthScore');
                  // Unknown health is neutral, never danger.
                  if (!isKnown(health)) return brand.inkSoft;
                  if (health >= 80) return brand.success;
                  if (health >= 60) return brand.warning;
                  return brand.danger;
                },
                label: 'data(label)',
                width: 60,
                height: 60,
                'text-valign': 'center',
                'text-halign': 'center',
                'font-size': '10px',
                color: brand.warm,
                'text-wrap': 'wrap',
                'text-max-width': '50px',
              },
            },
            {
              selector: 'node[layer="business"]',
              style: {
                shape: 'diamond',
                width: 80,
                height: 80,
              },
            },
            {
              selector: 'node[layer="application"]',
              style: {
                shape: 'roundrectangle',
              },
            },
            {
              selector: 'node[layer="infrastructure"]',
              style: {
                shape: 'ellipse',
              },
            },
            {
              selector: 'edge',
              style: {
                width: 2,
                'line-color': brand.inkSoft,
                'target-arrow-color': brand.inkSoft,
                'target-arrow-shape': 'triangle',
                'curve-style': 'bezier',
                label: 'data(label)',
                'font-size': '8px',
                color: brand.inkSoft,
              },
            },
            {
              selector: 'edge[healthImpact="high"]',
              style: {
                'line-color': brand.danger,
                'target-arrow-color': brand.danger,
                width: 3,
              },
            },
          ],
          layout: {
            name: 'breadthfirst',
            directed: true,
            spacingFactor: 1.5,
          },
        });

        // Cleanup on unmount
        return () => {
          cy.destroy();
        };
      }
    }
  }, [serviceDependencies.data, serviceDependencies.loading]);

  const refresh = () => {
    serviceHealth.refetch();
    if (selectedService) {
      revenueAtRisk.refetch();
      customerImpact.refetch();
      complianceStatus.refetch();
    }
  };

  const header = (
    <PageHeader
      eyebrow="Dashboards · Business Service"
      title="Business Service Dashboard"
      lede="Business value, customer impact, and service health"
      actions={
        <>
          <NativeSelect
            size="sm"
            aria-label="Business unit"
            value={selectedBusinessUnit}
            onChange={(e) => setSelectedBusinessUnit(e.target.value)}
          >
            <option value="">All Business Units</option>
            <option value="engineering">Engineering</option>
            <option value="sales">Sales</option>
            <option value="marketing">Marketing</option>
            <option value="finance">Finance</option>
            <option value="operations">Operations</option>
          </NativeSelect>
          <Button
            variant="secondary"
            icon="download-simple"
            onClick={() => exportToPDF('business-service', { selectedService, selectedBusinessUnit })}
          >
            Export PDF
          </Button>
          <Button
            variant="secondary"
            icon="download-simple"
            onClick={() => exportToExcel('business-service', { selectedService, selectedBusinessUnit })}
          >
            Export Excel
          </Button>
          <Button variant="secondary" onClick={refresh}>
            Refresh
          </Button>
        </>
      }
    />
  );

  if (error) {
    return (
      <div className="space-y-6 p-6">
        {header}
        <QueryState what="business service dashboard" error={error} onRetry={refresh} />
      </div>
    );
  }

  const dependencyNodes = serviceDependencies.data?.nodes ?? [];
  const anyHealthKnown = dependencyNodes.some((node) => isKnown(node.healthScore));
  const anyHealthUnknown = dependencyNodes.some((node) => !isKnown(node.healthScore));

  const knownComplianceFlags = [
    complianceStatus.data?.pciCompliant,
    complianceStatus.data?.hipaaCompliant,
    complianceStatus.data?.soxCompliant,
    complianceStatus.data?.gdprCompliant,
  ].filter((flag): flag is boolean => typeof flag === 'boolean');
  const compliantCount = knownComplianceFlags.filter(Boolean).length;

  return (
    <div className="p-6 space-y-6">
      {header}

      {/* Service Health Heat Map */}
      <Section title="Service Health by Business Unit" description="Click a service to view details">
        {loading ? (
          <QueryState what="service health" loading />
        ) : serviceHealth.data && serviceHealth.data.length > 0 ? (
          <div className="space-y-4">
            {serviceHealth.data.map((bu: any) => (
              <div key={bu.businessUnit}>
                <SectionHeading level={3} className="mb-2 capitalize">
                  {bu.businessUnit}
                </SectionHeading>
                <div className="grid grid-cols-4 gap-2 md:grid-cols-6 lg:grid-cols-8">
                  {bu.businessServices.map((service: any) => {
                    const healthKnown = isKnown(service.healthScore);
                    const tone = healthTone(service.healthScore);
                    return (
                      <Button
                        key={service.serviceId}
                        variant="secondary"
                        aria-pressed={selectedService === service.serviceId}
                        data-health-tone={tone}
                        className={`h-auto flex-col !rounded-[var(--hh-radius-md)] ${
                          selectedService === service.serviceId ? 'ring-2 ring-[var(--hh-accent-text)]' : ''
                        }`}
                        onClick={() => setSelectedService(service.serviceId)}
                        title={`${service.serviceName}: ${healthKnown ? `${service.healthScore}%` : NOT_AVAILABLE}`}
                      >
                        <span className="max-w-full truncate text-xs font-medium">{service.serviceName}</span>
                        <Badge variant={tone}>{healthKnown ? `${service.healthScore}%` : EMPTY_VALUE}</Badge>
                        <span className="sr-only">{healthKnown ? TONE_LABEL[tone] : 'unknown'}</span>
                      </Button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : serviceHealth.data && isUnavailable(unavailable, 'serviceHealth') ? (
          <UnavailableNotice label="Service health" />
        ) : serviceHealth.data === undefined ? (
          <EmptyState label="Select a business unit to view services" />
        ) : (
          <EmptyState
            icon="buildings"
            title="No business services"
            description="No business services were reported for this organization."
          />
        )}
      </Section>

      {/* Service-specific KPIs (only show if service is selected) */}
      {selectedService && (
        <>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <KPICard
              title="Revenue at Risk"
              value={formatCurrency(revenueAtRisk.data?.revenueAtRisk)}
              icon="currency-dollar"
              color={
                isKnown(revenueAtRisk.data?.percentageAtRisk)
                  ? revenueAtRisk.data.percentageAtRisk > 10 ? 'red' : 'green'
                  : 'blue'
              }
              description={
                isKnown(revenueAtRisk.data?.percentageAtRisk)
                  ? `${formatPercent(revenueAtRisk.data.percentageAtRisk)} of total revenue`
                  : NOT_AVAILABLE
              }
            />
            <KPICard
              title="Customers Impacted"
              value={formatCount(customerImpact.data?.customersImpacted)}
              icon="users"
              color={
                isKnown(customerImpact.data?.customersImpacted)
                  ? customerImpact.data.customersImpacted > 0 ? 'red' : 'green'
                  : 'blue'
              }
              description={
                isKnown(customerImpact.data?.totalCustomers)
                  ? `${formatCount(customerImpact.data.totalCustomers)} total customers`
                  : NOT_AVAILABLE
              }
            />
            <KPICard
              title="Estimated User Impact"
              value={formatCount(customerImpact.data?.estimatedUserImpact)}
              icon="warning"
              color={
                isKnown(customerImpact.data?.estimatedUserImpact)
                  ? customerImpact.data.estimatedUserImpact > 0 ? 'red' : 'green'
                  : 'blue'
              }
              description={
                isKnown(customerImpact.data?.estimatedUserImpact)
                  ? 'Users affected by incidents'
                  : NOT_AVAILABLE
              }
            />
            <KPICard
              title="Compliance Score"
              value={knownComplianceFlags.length > 0 ? `${compliantCount}/${knownComplianceFlags.length}` : EMPTY_VALUE}
              icon="shield"
              color={
                knownComplianceFlags.length === 0
                  ? 'blue'
                  : knownComplianceFlags.length === COMPLIANCE_FRAMEWORK_COUNT &&
                    compliantCount === COMPLIANCE_FRAMEWORK_COUNT
                  ? 'green'
                  : 'yellow'
              }
              description={
                knownComplianceFlags.length === 0
                  ? NOT_AVAILABLE
                  : knownComplianceFlags.length < COMPLIANCE_FRAMEWORK_COUNT
                  ? `${knownComplianceFlags.length} of ${COMPLIANCE_FRAMEWORK_COUNT} frameworks reported`
                  : 'Compliance frameworks'
              }
            />
          </div>

          {/* Revenue at Risk Details */}
          {revenueAtRisk.data && revenueAtRisk.data.affectedIncidents.length === 0 && isUnavailable(unavailable, 'revenueAtRisk') && (
            <UnavailableNotice label="Revenue at risk details" />
          )}
          {revenueAtRisk.data && revenueAtRisk.data.affectedIncidents.length > 0 && (
            <Section
              title="Revenue at Risk"
              description={`Total annual revenue: ${formatCurrency(revenueAtRisk.data.totalAnnualRevenue)}`}
            >
              <div className="space-y-2">
                {revenueAtRisk.data.affectedIncidents.map((incident: any) => (
                  <div
                    key={incident.id}
                    className="flex items-center justify-between rounded-lg bg-[var(--hh-bg-elevated)] p-3"
                  >
                    <div className="flex items-center gap-2">
                      <Icon name="warning" size={16} className="text-[var(--hh-error-text)]" />
                      <span className="text-sm font-medium">Incident {incident.id}</span>
                      <Badge variant={incident.priority === 'P1' ? 'danger' : 'warning'}>
                        {incident.priority}
                      </Badge>
                    </div>
                    <span className="text-sm font-bold text-[var(--hh-error-text)]">
                      {formatCurrency(incident.estimatedImpact)} at risk
                    </span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Compliance Status */}
          {complianceStatus.data && (
            <Section
              title="Compliance Status"
              description={`Last audit: ${
                complianceStatus.data.lastAuditDate
                  ? new Date(complianceStatus.data.lastAuditDate).toLocaleDateString()
                  : NOT_AVAILABLE
              }`}
            >
              <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">
                {[
                  { name: 'PCI', value: complianceStatus.data.pciCompliant },
                  { name: 'HIPAA', value: complianceStatus.data.hipaaCompliant },
                  { name: 'SOX', value: complianceStatus.data.soxCompliant },
                  { name: 'GDPR', value: complianceStatus.data.gdprCompliant },
                ].map((compliance) => (
                  <div
                    key={compliance.name}
                    className="flex flex-col items-center gap-2 rounded-lg bg-[var(--hh-bg-elevated)] p-4 text-center"
                  >
                    <IconWell
                      tone={compliance.value === true ? 'success' : compliance.value === false ? 'danger' : 'neutral'}
                      icon={compliance.value === true ? 'check-circle' : compliance.value === false ? 'x-circle' : 'minus'}
                    />
                    <p className="text-sm font-medium">{compliance.name}</p>
                    <Badge
                      variant={
                        compliance.value === true ? 'success' : compliance.value === false ? 'danger' : 'neutral'
                      }
                    >
                      {compliance.value === true
                        ? 'Compliant'
                        : compliance.value === false
                        ? 'Non-Compliant'
                        : NOT_AVAILABLE}
                    </Badge>
                  </div>
                ))}
              </div>
              {(complianceStatus.data.nonCompliantItems?.length ?? 0) > 0 && (
                <div>
                  <SectionHeading level={3} className="mb-3">
                    Non-Compliant Items
                  </SectionHeading>
                  <div className="space-y-2">
                    {complianceStatus.data.nonCompliantItems?.map((item: any, index: number) => (
                      <div key={index} className="rounded-lg bg-[var(--hh-error-bg)] p-3 text-[var(--hh-error-text)]">
                        <p className="text-sm font-medium">{item.requirement}</p>
                        <p className="mt-1 text-xs">
                          Status: {item.status} | Remediation: {item.remediation}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Section>
          )}

          {/* Value Stream Health */}
          {valueStreamHealth.data && (
            <Section
              title="Value Stream Health"
              description={`Flow rate: ${isKnown(valueStreamHealth.data.flowRate) ? `${formatCount(valueStreamHealth.data.flowRate)} requests/day` : EMPTY_VALUE} | Cycle time: ${isKnown(valueStreamHealth.data.cycleTime) ? `${formatDecimal(valueStreamHealth.data.cycleTime)}h` : EMPTY_VALUE}`}
            >
              {valueStreamHealth.data.stages.length === 0 && isUnavailable(unavailable, 'valueStreamHealth') && (
                <UnavailableNotice label="Value stream stages" />
              )}
              <div className="space-y-4">
                {valueStreamHealth.data.stages.map((stage: any, index: number) => (
                  <div key={stage.name}>
                    <div className="mb-2 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{stage.name}</span>
                        {stage.bottleneck && <Badge variant="danger">Bottleneck</Badge>}
                      </div>
                      <span className="text-sm">
                        Health: <span className="font-bold">{formatPercent(stage.healthScore, 0)}</span> | Throughput: {isKnown(stage.throughput) ? `${stage.throughput}/day` : EMPTY_VALUE}
                      </span>
                    </div>
                    {isKnown(stage.healthScore) ? (
                      <ProgressBar
                        aria-label={`${stage.name} health`}
                        value={stage.healthScore}
                        tone={healthTone(stage.healthScore) as 'success' | 'warning' | 'danger'}
                      />
                    ) : (
                      <div aria-hidden="true" className="h-1.5 w-full rounded-full bg-[var(--hh-soft-bg)]" />
                    )}
                    {index < (valueStreamHealth.data?.stages?.length ?? 0) - 1 && (
                      <div className="my-2 text-center text-[var(--hh-text-muted)]">↓</div>
                    )}
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Dependency Map */}
          <Section
            title="Service Dependency Map"
            description="Business service dependencies and health propagation"
          >
            {serviceDependencies.loading ? (
              <QueryState what="service dependencies" loading />
            ) : serviceDependencies.data && serviceDependencies.data.nodes.length > 0 ? (
              <div
                id="dependency-graph"
                className="rounded-lg border border-[var(--hh-border)]"
                style={{ width: '100%', height: '600px' }}
              ></div>
            ) : (
              <EmptyState label="No dependency data available for this service" />
            )}
            <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
              {anyHealthKnown && (
                <>
                  <Badge variant="success" dot>Healthy (&gt;80%)</Badge>
                  <Badge variant="warning" dot>Warning (60-80%)</Badge>
                  <Badge variant="danger" dot>Critical (&lt;60%)</Badge>
                </>
              )}
              {anyHealthUnknown && (
                <Badge variant="neutral" dot>Health: {NOT_AVAILABLE}</Badge>
              )}
            </div>
          </Section>
        </>
      )}

      {!selectedService && (
        <Section title="Select a Business Service">
          <EmptyState
            icon="pulse"
            description="Click on a service in the heat map above to view detailed metrics, compliance status, and dependencies."
          />
        </Section>
      )}
    </div>
  );
};

export default BusinessServiceDashboard;
