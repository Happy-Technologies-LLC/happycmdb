import React, { useState, useEffect } from 'react';
import { Icon } from '@happy-technologies/design-system';
import { useBusinessServiceDashboard, useExportDashboard } from '@/hooks/useDashboardData';
import { KPICard } from '@/components/dashboard/KPICard';
import { LiquidGlass } from '@/components/ui/liquid-glass';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Eyebrow } from '@/components/ui/eyebrow';
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
                color: '#fff',
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

  if (error) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertDescription>
            Failed to load business service dashboard data: {error.message}
          </AlertDescription>
        </Alert>
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
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Eyebrow>Dashboards · Business Service</Eyebrow>
          <h1 className="mt-3 text-[1.9rem]">Business Service Dashboard</h1>
          <p className="mt-1.5 text-ink-soft">
            Business value, customer impact, and service health
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            className="px-4 py-2 border border-border rounded-md text-sm"
            value={selectedBusinessUnit}
            onChange={(e) => setSelectedBusinessUnit(e.target.value)}
          >
            <option value="">All Business Units</option>
            <option value="engineering">Engineering</option>
            <option value="sales">Sales</option>
            <option value="marketing">Marketing</option>
            <option value="finance">Finance</option>
            <option value="operations">Operations</option>
          </select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => exportToPDF('business-service', { selectedService, selectedBusinessUnit })}
          >
            <Icon name="download-simple" size={16} className="mr-2" />
            Export PDF
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => exportToExcel('business-service', { selectedService, selectedBusinessUnit })}
          >
            <Icon name="download-simple" size={16} className="mr-2" />
            Export Excel
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              serviceHealth.refetch();
              if (selectedService) {
                revenueAtRisk.refetch();
                customerImpact.refetch();
                complianceStatus.refetch();
              }
            }}
          >
            Refresh
          </Button>
        </div>
      </div>

      {/* Service Health Heat Map */}
      <LiquidGlass variant="default" rounded="xl">
        <div>
          <h3 className="text-lg font-semibold mb-1">Service Health by Business Unit</h3>
          <p className="text-sm text-muted-foreground mb-4">Click a service to view details</p>
          {loading ? (
            <div className="flex justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
          ) : serviceHealth.data && serviceHealth.data.length > 0 ? (
            <div className="space-y-4">
              {serviceHealth.data.map((bu: any) => (
                <div key={bu.businessUnit}>
                  <h4 className="font-semibold mb-2 capitalize">{bu.businessUnit}</h4>
                  <div className="grid grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2">
                    {bu.businessServices.map((service: any) => {
                      const healthKnown = isKnown(service.healthScore);
                      return (
                        <button
                          key={service.serviceId}
                          className={`p-3 rounded-lg text-center cursor-pointer transition-all hover:scale-105 ${
                            selectedService === service.serviceId
                              ? 'ring-2 ring-primary'
                              : ''
                          } ${healthKnown ? '' : 'bg-warm-alt text-ink-soft'}`}
                          style={
                            healthKnown
                              ? {
                                  backgroundColor:
                                    service.healthScore >= 80
                                      ? brand.success
                                      : service.healthScore >= 60
                                      ? brand.warning
                                      : brand.danger,
                                  color: '#fff',
                                }
                              : undefined
                          }
                          onClick={() => setSelectedService(service.serviceId)}
                          title={`${service.serviceName}: ${healthKnown ? `${service.healthScore}%` : NOT_AVAILABLE}`}
                        >
                          <p className="text-xs font-medium truncate">{service.serviceName}</p>
                          <p className="text-lg font-bold mt-1">
                            {healthKnown ? `${service.healthScore}%` : EMPTY_VALUE}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          ) : serviceHealth.data && isUnavailable(unavailable, 'serviceHealth') ? (
            <UnavailableNotice label="Service health" />
          ) : (
            <p className="text-center text-muted-foreground py-8">
              Select a business unit to view services
            </p>
          )}
        </div>
      </LiquidGlass>

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
            <LiquidGlass variant="default" rounded="xl">
              <div>
          <h3 className="text-lg font-semibold mb-1">Revenue at Risk</h3>
          <p className="text-sm text-muted-foreground mb-4">
                  Total annual revenue: {formatCurrency(revenueAtRisk.data.totalAnnualRevenue)}
                </p>
                <div className="space-y-2">
                  {revenueAtRisk.data.affectedIncidents.map((incident: any) => (
                    <div
                      key={incident.id}
                      className="flex items-center justify-between p-3 border border-border rounded-lg"
                    >
                      <div className="flex items-center gap-2">
                        <Icon name="warning" size={16} className="text-danger" />
                        <span className="text-sm font-medium">Incident {incident.id}</span>
                        <Badge
                          variant="outline"
                          className={
                            incident.priority === 'P1'
                              ? 'bg-danger-soft text-danger'
                              : 'bg-warning-soft text-warning-text'
                          }
                        >
                          {incident.priority}
                        </Badge>
                      </div>
                      <span className="text-sm font-bold text-danger">
                        {formatCurrency(incident.estimatedImpact)} at risk
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </LiquidGlass>
          )}

          {/* Compliance Status */}
          {complianceStatus.data && (
          <LiquidGlass variant="default" rounded="xl">
            <div>
          <h3 className="text-lg font-semibold mb-1">Compliance Status</h3>
          <p className="text-sm text-muted-foreground mb-4">
                Last audit: {complianceStatus.data.lastAuditDate
                  ? new Date(complianceStatus.data.lastAuditDate).toLocaleDateString()
                  : NOT_AVAILABLE}
              </p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                {[
                  { name: 'PCI', value: complianceStatus.data.pciCompliant },
                  { name: 'HIPAA', value: complianceStatus.data.hipaaCompliant },
                  { name: 'SOX', value: complianceStatus.data.soxCompliant },
                  { name: 'GDPR', value: complianceStatus.data.gdprCompliant },
                ].map((compliance) => (
                  <div key={compliance.name} className="p-4 border border-border rounded-lg text-center">
                    <div className="flex items-center justify-center mb-2">
                      {compliance.value === true ? (
                        <Icon name="check-circle" size={32} className="text-success" />
                      ) : compliance.value === false ? (
                        <Icon name="x-circle" size={32} className="text-danger" />
                      ) : (
                        <Icon name="minus" size={32} className="text-muted-foreground" />
                      )}
                    </div>
                    <p className="text-sm font-medium">{compliance.name}</p>
                    <Badge
                      variant={
                        compliance.value === true ? 'success' : compliance.value === false ? 'destructive' : 'outline'
                      }
                      className="mt-2"
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
                  <h4 className="font-semibold mb-3">Non-Compliant Items</h4>
                  <div className="space-y-2">
                    {complianceStatus.data.nonCompliantItems?.map((item: any, index: number) => (
                      <div key={index} className="p-3 border border-border rounded-lg bg-danger-soft">
                        <p className="text-sm font-medium">{item.requirement}</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          Status: {item.status} | Remediation: {item.remediation}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </LiquidGlass>
          )}

          {/* Value Stream Health */}
          {valueStreamHealth.data && (
            <LiquidGlass variant="default" rounded="xl">
              <div>
          <h3 className="text-lg font-semibold mb-1">Value Stream Health</h3>
          <p className="text-sm text-muted-foreground mb-4">
                  Flow rate: {isKnown(valueStreamHealth.data.flowRate) ? `${formatCount(valueStreamHealth.data.flowRate)} requests/day` : EMPTY_VALUE} | Cycle time: {isKnown(valueStreamHealth.data.cycleTime) ? `${formatDecimal(valueStreamHealth.data.cycleTime)}h` : EMPTY_VALUE}
                </p>
                {valueStreamHealth.data.stages.length === 0 && isUnavailable(unavailable, 'valueStreamHealth') && (
                  <UnavailableNotice label="Value stream stages" />
                )}
                <div className="space-y-4">
                  {valueStreamHealth.data.stages.map((stage: any, index: number) => (
                    <div key={stage.name}>
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{stage.name}</span>
                          {stage.bottleneck && (
                            <Badge variant="destructive" className="text-xs">
                              Bottleneck
                            </Badge>
                          )}
                        </div>
                        <span className="text-sm">
                          Health: <span className="font-bold">{formatPercent(stage.healthScore, 0)}</span> | Throughput: {isKnown(stage.throughput) ? `${stage.throughput}/day` : EMPTY_VALUE}
                        </span>
                      </div>
                      <div className="relative pt-1">
                        <div className="flex mb-2 items-center justify-between">
                          <div className="w-full">
                            <div className="overflow-hidden h-3 text-xs flex rounded bg-warm-alt">
                              {isKnown(stage.healthScore) && (
                                <div
                                  style={{
                                    width: `${stage.healthScore}%`,
                                    backgroundColor:
                                      stage.healthScore >= 80
                                        ? brand.success
                                        : stage.healthScore >= 60
                                        ? brand.warning
                                        : brand.danger,
                                  }}
                                  className="shadow-none flex flex-col text-center whitespace-nowrap text-white justify-center"
                                ></div>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                      {index < (valueStreamHealth.data?.stages?.length ?? 0) - 1 && (
                        <div className="text-center text-muted-foreground my-2">↓</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </LiquidGlass>
          )}

          {/* Dependency Map */}
          <LiquidGlass variant="default" rounded="xl">
            <div>
          <h3 className="text-lg font-semibold mb-1">Service Dependency Map</h3>
          <p className="text-sm text-muted-foreground mb-4">
                Business service dependencies and health propagation
              </p>
              {serviceDependencies.loading ? (
                <div className="flex justify-center py-8">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                </div>
              ) : serviceDependencies.data && serviceDependencies.data.nodes.length > 0 ? (
                <div
                  id="dependency-graph"
                  style={{ width: '100%', height: '600px', border: `1px solid ${brand.line}`, borderRadius: '8px' }}
                ></div>
              ) : (
                <p className="text-center text-muted-foreground py-8">
                  No dependency data available for this service
                </p>
              )}
              <div className="mt-4 flex items-center gap-4 text-sm">
                {anyHealthKnown && (
                  <>
                    <div className="flex items-center gap-2">
                      <div className="w-4 h-4 rounded-full bg-success"></div>
                      <span>Healthy (&gt;80%)</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-4 h-4 rounded-full bg-warning"></div>
                      <span>Warning (60-80%)</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-4 h-4 rounded-full bg-danger"></div>
                      <span>Critical (&lt;60%)</span>
                    </div>
                  </>
                )}
                {anyHealthUnknown && (
                  <div className="flex items-center gap-2">
                    <div
                      className="w-4 h-4 rounded-full"
                      style={{ backgroundColor: brand.inkSoft }}
                    ></div>
                    <span>Health: {NOT_AVAILABLE}</span>
                  </div>
                )}
              </div>
            </div>
          </LiquidGlass>
        </>
      )}

      {!selectedService && (
        <LiquidGlass variant="default" rounded="xl">
          <div className="py-12">
            <div className="text-center">
              <Icon name="pulse" size={64} className="mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2">Select a Business Service</h3>
              <p className="text-muted-foreground">
                Click on a service in the heat map above to view detailed metrics, compliance status, and dependencies.
              </p>
            </div>
          </div>
        </LiquidGlass>
      )}
    </div>
  );
};

export default BusinessServiceDashboard;
