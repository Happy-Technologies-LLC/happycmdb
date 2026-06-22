// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Impact Prediction Panel Component
 * Proactive change impact prediction and risk assessment tool
 */

import React, { useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { impactApi } from '../../api/impact';
import { useImpactAnalysis } from '../../hooks/useCIRelationships';
import { Icon } from '@happy-technologies/design-system';
import { LiquidGlass } from '@/components/ui/liquid-glass';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import CITypeBadge from '../ci/CITypeBadge';
import CIStatusBadge from '../ci/CIStatusBadge';
import {
  Treemap,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
} from 'recharts';
import Cytoscape from 'cytoscape';

interface ImpactPredictionPanelProps {
  ciId: string;
  ciName: string;
}

const CHANGE_TYPES = [
  {
    value: 'CONFIGURATION_CHANGE',
    label: 'Configuration Change',
    description: 'Update configuration settings',
    icon: '⚙️'
  },
  {
    value: 'VERSION_UPGRADE',
    label: 'Version Upgrade',
    description: 'Upgrade to new version',
    icon: '⬆️'
  },
  {
    value: 'RESTART',
    label: 'Service Restart',
    description: 'Restart the service',
    icon: '🔄'
  },
  {
    value: 'DECOMMISSION',
    label: 'Decommission',
    description: 'Remove from production',
    icon: '🗑️'
  },
  {
    value: 'NETWORK_CHANGE',
    label: 'Network Change',
    description: 'Modify network configuration',
    icon: '🌐'
  },
  {
    value: 'SECURITY_CHANGE',
    label: 'Security Change',
    description: 'Update security settings',
    icon: '🔒'
  },
  {
    value: 'PERFORMANCE_TUNING',
    label: 'Performance Tuning',
    description: 'Optimize performance',
    icon: '⚡'
  },
];

interface TreemapData {
  name: string;
  size: number;
  type: string;
  status: string;
  environment: string;
}

const CustomTreemapContent = (props: any) => {
  const { x, y, width, height, name, type, status } = props;

  if (width < 60 || height < 30 || !name) return null;

  const typeColors: Record<string, string> = {
    server: '#1976d2',
    'virtual-machine': '#9c27b0',
    container: '#0288d1',
    application: '#f57c00',
    service: '#388e3c',
    database: '#d32f2f',
    'network-device': '#512da8',
    storage: '#00796b',
    'load-balancer': '#c2185b',
    'cloud-resource': '#5e35b1',
  };

  const bgColor = typeColors[type] || '#757575';
  const borderColor = status === 'active' ? '#4caf50' : '#f44336';

  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        style={{
          fill: bgColor,
          stroke: borderColor,
          strokeWidth: 2,
          opacity: 0.8,
        }}
      />
      {width > 80 && height > 40 && (
        <text
          x={x + width / 2}
          y={y + height / 2}
          textAnchor="middle"
          fill="#fff"
          fontSize={12}
        >
          {name.length > 15 ? `${name.substring(0, 15)}...` : name}
        </text>
      )}
    </g>
  );
};

export const ImpactPredictionPanel: React.FC<ImpactPredictionPanelProps> = ({
  ciId,
  ciName
}) => {
  const [selectedChangeType, setSelectedChangeType] = useState('CONFIGURATION_CHANGE');
  const [maxDepth, setMaxDepth] = useState(3);
  const [compareMode, setCompareMode] = useState(false);
  const [comparisonChanges, setComparisonChanges] = useState<string[]>([]);
  const [hasPredicted, setHasPredicted] = useState(false);
  const graphRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Cytoscape.Core | null>(null);

  // Fetch impact prediction (on-demand only)
  const { data: impactAnalysis, isLoading: isPredicting, refetch: runPrediction } = useQuery({
    queryKey: ['impact', 'predict', ciId, selectedChangeType],
    queryFn: () => impactApi.predict(ciId, selectedChangeType),
    enabled: false, // Disabled - only runs when manually triggered
  });

  // Fetch current upstream/downstream dependencies
  const { data: currentImpactAnalysis } = useImpactAnalysis(ciId);

  // Fetch dependency graph (only when prediction has run)
  const { data: graph, isLoading: isLoadingGraph } = useQuery({
    queryKey: ['impact', 'graph', ciId, maxDepth],
    queryFn: () => impactApi.getGraph(ciId, maxDepth),
    enabled: !!ciId && hasPredicted,
  });

  // Handler for running prediction
  const handleRunPrediction = async () => {
    setHasPredicted(true);
    await runPrediction();
  };

  // Initialize Cytoscape graph
  useEffect(() => {
    if (!graph || !graphRef.current) return;

    const elements = [
      ...graph.nodes.map((node) => ({
        data: {
          id: node.id,
          label: node.ci_name,
          type: node.ci_type,
          criticality: node.criticality,
        },
      })),
      ...graph.edges.map((edge, index) => ({
        data: {
          id: `edge-${index}`,
          source: edge.source_id,
          target: edge.target_id,
          label: edge.relationship_type,
          weight: edge.weight,
          critical: edge.is_critical,
        },
      })),
    ];

    if (cyRef.current) {
      cyRef.current.destroy();
    }

    cyRef.current = Cytoscape({
      container: graphRef.current,
      elements,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': (ele: any) => {
              const criticality = ele.data('criticality');
              if (criticality > 80) return '#EF4444';
              if (criticality > 60) return '#F59E0B';
              if (criticality > 40) return '#FBBF24';
              return '#3B82F6';
            },
            label: 'data(label)',
            color: '#fff',
            'text-valign': 'center',
            'text-halign': 'center',
            'font-size': '12px',
            width: (ele: any) => 30 + ele.data('criticality') / 3,
            height: (ele: any) => 30 + ele.data('criticality') / 3,
          },
        },
        {
          selector: 'edge',
          style: {
            width: 2,
            'line-color': (ele: any) => ele.data('critical') ? '#DC2626' : '#94A3B8',
            'target-arrow-color': (ele: any) => ele.data('critical') ? '#DC2626' : '#94A3B8',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            label: 'data(label)',
            'font-size': '10px',
            'text-rotation': 'autorotate',
            'text-margin-y': -10,
          },
        },
      ],
      layout: {
        name: 'cose',
        idealEdgeLength: 100,
        nodeOverlap: 20,
        refresh: 20,
        fit: true,
        padding: 30,
        randomize: false,
        componentSpacing: 100,
        nodeRepulsion: 400000,
        edgeElasticity: 100,
        nestingFactor: 5,
        gravity: 80,
        numIter: 1000,
        initialTemp: 200,
        coolingFactor: 0.95,
        minTemp: 1.0,
      },
    });

    return () => {
      if (cyRef.current) {
        cyRef.current.destroy();
      }
    };
  }, [graph]);

  const getRiskColor = (level: string) => {
    switch (level?.toLowerCase()) {
      case 'critical': return 'bg-red-500';
      case 'high': return 'bg-orange-500';
      case 'medium': return 'bg-yellow-500';
      case 'low': return 'bg-blue-500';
      case 'minimal': return 'bg-green-500';
      default: return 'bg-gray-500';
    }
  };

  const getRiskBadgeColor = (level: string) => {
    switch (level?.toLowerCase()) {
      case 'critical': return 'bg-red-100 text-red-800 border-red-200';
      case 'high': return 'bg-orange-100 text-orange-800 border-orange-200';
      case 'medium': return 'bg-yellow-100 text-yellow-800 border-yellow-200';
      case 'low': return 'bg-blue-100 text-blue-800 border-blue-200';
      case 'minimal': return 'bg-green-100 text-green-800 border-green-200';
      default: return 'bg-gray-100 text-gray-800 border-gray-200';
    }
  };

  const getRiskIcon = (level: string) => {
    switch (level?.toLowerCase()) {
      case 'critical': return <Icon name="x-circle" size={20} className="text-red-500" />;
      case 'high': return <Icon name="warning" size={20} className="text-orange-500" />;
      case 'medium': return <Icon name="warning-circle" size={20} className="text-yellow-500" />;
      case 'low': return <Icon name="check-circle" size={20} className="text-blue-500" />;
      case 'minimal': return <Icon name="check-circle" size={20} className="text-green-500" />;
      default: return <Icon name="warning-circle" size={20} className="text-gray-500" />;
    }
  };

  const getRecommendations = () => {
    if (!impactAnalysis) return [];

    const recommendations = [];
    const riskLevel = impactAnalysis.risk_level?.toLowerCase();

    if (riskLevel === 'critical' || riskLevel === 'high') {
      recommendations.push('🔴 Schedule during maintenance window');
      recommendations.push('📋 Require change approval from management');
      recommendations.push('🔙 Prepare rollback plan before execution');
      recommendations.push('👥 Notify all affected teams');
    }

    if (impactAnalysis.blast_radius > 10) {
      recommendations.push('📊 Review all affected CIs before proceeding');
    }

    if (impactAnalysis.estimated_downtime_minutes && impactAnalysis.estimated_downtime_minutes > 5) {
      recommendations.push(`⏱️ Plan for ${impactAnalysis.estimated_downtime_minutes} minutes of downtime`);
    }

    if (riskLevel === 'medium') {
      recommendations.push('⚠️ Review change with team lead');
      recommendations.push('📝 Document rollback procedure');
    }

    if (riskLevel === 'low' || riskLevel === 'minimal') {
      recommendations.push('✅ Safe to proceed with standard change process');
    }

    return recommendations;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Icon name="lightning" size={24} className="text-primary" />
            Impact Prediction
          </h3>
          <p className="text-muted-foreground mt-1">
            Analyze potential impact before making changes to <strong>{ciName}</strong>
          </p>
        </div>
        <Button
          variant={compareMode ? "default" : "outline"}
          onClick={() => setCompareMode(!compareMode)}
        >
          <Icon name="chart-bar" size={16} className="mr-2" />
          Compare Scenarios
        </Button>
      </div>

      {/* Change Type Selector */}
      <LiquidGlass variant="default" rounded="xl">
        <div className="flex items-center justify-between mb-4">
          <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            Select Change Type
          </h4>
          <Button
            onClick={handleRunPrediction}
            disabled={isPredicting}
            size="lg"
            className="shadow-lg"
          >
            {isPredicting ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                Analyzing...
              </>
            ) : (
              <>
                <Icon name="lightning" size={16} className="mr-2" />
                Run Impact Prediction
              </>
            )}
          </Button>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
          {CHANGE_TYPES.map((type) => (
            <button
              key={type.value}
              onClick={() => setSelectedChangeType(type.value)}
              className={`p-4 rounded-lg border-2 transition-all hover:scale-105 ${
                selectedChangeType === type.value
                  ? 'border-primary bg-primary/10 shadow-md'
                  : 'border-border bg-background hover:border-primary/50'
              }`}
            >
              <div className="text-3xl mb-2">{type.icon}</div>
              <div className="text-sm font-medium mb-1">{type.label}</div>
              <div className="text-xs text-muted-foreground">{type.description}</div>
            </button>
          ))}
        </div>
      </LiquidGlass>

      {/* Initial State - No prediction run yet */}
      {!hasPredicted && !isPredicting && (
        <LiquidGlass variant="default" rounded="xl">
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="bg-primary/10 p-6 rounded-full mb-4">
              <Icon name="lightning" size={48} className="text-primary" />
            </div>
            <h4 className="text-xl font-semibold mb-2">Ready to Analyze Impact</h4>
            <p className="text-muted-foreground max-w-md mb-6">
              Select a change type above and click "Run Impact Prediction" to analyze
              the potential impact of changes to <strong>{ciName}</strong>.
            </p>
            <p className="text-sm text-muted-foreground">
              This will analyze dependencies, blast radius, and provide recommendations.
            </p>
          </div>
        </LiquidGlass>
      )}

      {/* Loading State */}
      {isPredicting && (
        <LiquidGlass variant="default" rounded="xl">
          <div className="flex items-center justify-center py-8">
            <div className="text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
              <p className="text-muted-foreground">Analyzing impact...</p>
            </div>
          </div>
        </LiquidGlass>
      )}

      {/* Impact Summary */}
      {impactAnalysis && !isPredicting && hasPredicted && (
        <>
          {/* Risk Assessment */}
          <LiquidGlass variant="default" rounded="xl">
            <div className="flex items-center justify-between mb-6">
              <h4 className="text-lg font-semibold">Risk Assessment</h4>
              <div className="flex items-center gap-2">
                {getRiskIcon(impactAnalysis.risk_level)}
                <Badge className={getRiskBadgeColor(impactAnalysis.risk_level)}>
                  {impactAnalysis.risk_level?.toUpperCase()} RISK
                </Badge>
              </div>
            </div>

            {/* Risk Metrics */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
              <div className="bg-gradient-to-br from-blue-50 to-blue-100 dark:from-blue-900/20 dark:to-blue-800/20 p-4 rounded-lg border border-blue-200 dark:border-blue-800">
                <div className="flex items-center gap-2 mb-2">
                  <Icon name="trend-up" size={20} className="text-blue-600 dark:text-blue-400" />
                  <span className="text-sm font-medium text-muted-foreground">Impact Score</span>
                </div>
                <div className="text-3xl font-bold text-blue-600 dark:text-blue-400">
                  {impactAnalysis.impact_score}
                </div>
              </div>

              <div className="bg-gradient-to-br from-orange-50 to-orange-100 dark:from-orange-900/20 dark:to-orange-800/20 p-4 rounded-lg border border-orange-200 dark:border-orange-800">
                <div className="flex items-center gap-2 mb-2">
                  <Icon name="warning" size={20} className="text-orange-600 dark:text-orange-400" />
                  <span className="text-sm font-medium text-muted-foreground">Blast Radius</span>
                </div>
                <div className="text-3xl font-bold text-orange-600 dark:text-orange-400">
                  {impactAnalysis.blast_radius}
                </div>
                <div className="text-xs text-muted-foreground mt-1">CIs affected</div>
              </div>

              <div className="bg-gradient-to-br from-purple-50 to-purple-100 dark:from-purple-900/20 dark:to-purple-800/20 p-4 rounded-lg border border-purple-200 dark:border-purple-800">
                <div className="flex items-center gap-2 mb-2">
                  <Icon name="git-branch" size={20} className="text-purple-600 dark:text-purple-400" />
                  <span className="text-sm font-medium text-muted-foreground">Critical Path</span>
                </div>
                <div className="text-3xl font-bold text-purple-600 dark:text-purple-400">
                  {impactAnalysis.critical_path?.length || 0}
                </div>
                <div className="text-xs text-muted-foreground mt-1">Hops</div>
              </div>

              <div className="bg-gradient-to-br from-red-50 to-red-100 dark:from-red-900/20 dark:to-red-800/20 p-4 rounded-lg border border-red-200 dark:border-red-800">
                <div className="flex items-center gap-2 mb-2">
                  <Icon name="clock" size={20} className="text-red-600 dark:text-red-400" />
                  <span className="text-sm font-medium text-muted-foreground">Est. Downtime</span>
                </div>
                <div className="text-3xl font-bold text-red-600 dark:text-red-400">
                  {impactAnalysis.estimated_downtime_minutes || 0}
                </div>
                <div className="text-xs text-muted-foreground mt-1">Minutes</div>
              </div>
            </div>

            {/* Recommendations */}
            <div className="bg-muted/30 border border-border/50 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-3">
                <Icon name="shield" size={20} className="text-primary" />
                <h5 className="font-semibold">Recommendations</h5>
              </div>
              <ul className="space-y-2">
                {getRecommendations().map((rec, index) => (
                  <li key={index} className="text-sm text-foreground flex items-start gap-2">
                    <span className="mt-1">•</span>
                    <span>{rec}</span>
                  </li>
                ))}
              </ul>
            </div>
          </LiquidGlass>

          {/* Dependency Graph */}
          <LiquidGlass variant="default" rounded="xl">
            <div className="flex items-center justify-between mb-4">
              <h4 className="text-lg font-semibold">Impact Propagation Graph</h4>
              <div className="flex items-center gap-2">
                <label className="text-sm text-muted-foreground">Depth:</label>
                <select
                  value={maxDepth}
                  onChange={(e) => setMaxDepth(Number(e.target.value))}
                  className="px-3 py-1 border rounded-md text-sm"
                >
                  {[1, 2, 3, 4, 5].map((d) => (
                    <option key={d} value={d}>{d} Level{d > 1 ? 's' : ''}</option>
                  ))}
                </select>
              </div>
            </div>

            <div
              ref={graphRef}
              className="w-full h-[500px] border rounded-lg bg-muted/10"
            />

            {/* Legend */}
            <div className="mt-4 flex items-center gap-6 text-sm">
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 rounded-full bg-red-500"></div>
                <span>Critical (80-100)</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 rounded-full bg-orange-500"></div>
                <span>High (60-80)</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 rounded-full bg-yellow-500"></div>
                <span>Medium (40-60)</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 rounded-full bg-blue-500"></div>
                <span>Low (0-40)</span>
              </div>
            </div>
          </LiquidGlass>

          {/* Affected CIs Table */}
          {impactAnalysis.affected_cis && impactAnalysis.affected_cis.length > 0 && (
            <LiquidGlass variant="default" rounded="xl">
              <h4 className="text-lg font-semibold mb-4">
                Affected Configuration Items ({impactAnalysis.affected_cis.length})
              </h4>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-border">
                  <thead>
                    <tr className="bg-muted/30">
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        CI Name
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        Type
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        Impact Type
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        Hops
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        Probability
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        Estimated Impact
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-background divide-y divide-border">
                    {impactAnalysis.affected_cis.map((ci, index) => (
                      <tr key={index} className="hover:bg-muted/20 transition-colors">
                        <td className="px-4 py-3 whitespace-nowrap font-medium">
                          {ci.ci_name}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-muted-foreground">
                          {ci.ci_type}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <Badge
                            className={
                              ci.impact_type === 'direct'
                                ? 'bg-red-100 text-red-800'
                                : 'bg-yellow-100 text-yellow-800'
                            }
                          >
                            {ci.impact_type}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm">
                          {ci.hop_count}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm">
                          <div className="flex items-center gap-2">
                            <div className="w-16 h-2 bg-muted rounded-full overflow-hidden">
                              <div
                                className={`h-full ${
                                  ci.impact_probability > 75
                                    ? 'bg-red-500'
                                    : ci.impact_probability > 50
                                    ? 'bg-orange-500'
                                    : 'bg-yellow-500'
                                }`}
                                style={{ width: `${ci.impact_probability}%` }}
                              />
                            </div>
                            <span>{ci.impact_probability}%</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm text-muted-foreground">
                          {ci.estimated_impact}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </LiquidGlass>
          )}
        </>
      )}

      {/* Current Upstream/Downstream Dependencies */}
      {currentImpactAnalysis && currentImpactAnalysis.ci && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Upstream Dependencies */}
          {currentImpactAnalysis.upstream && currentImpactAnalysis.upstream.length > 0 && (
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Icon name="trend-up" size={20} className="text-primary" />
                  <CardTitle className="text-base">Upstream Dependencies</CardTitle>
                </div>
                <p className="text-xs text-muted-foreground">
                  CIs that {ciName} depends on ({currentImpactAnalysis.upstream.length})
                </p>
              </CardHeader>
              <CardContent>
                <Separator className="mb-4" />

                {/* Treemap Visualization */}
                <ResponsiveContainer width="100%" height={300}>
                  <Treemap
                    data={currentImpactAnalysis.upstream.map((ci) => ({
                      name: ci.name,
                      size: 100,
                      type: ci.type,
                      status: ci.status,
                      environment: ci.environment,
                    }))}
                    dataKey="size"
                    aspectRatio={4 / 3}
                    stroke="#fff"
                    content={<CustomTreemapContent />}
                  >
                    <RechartsTooltip
                      content={({ active, payload }) => {
                        if (active && payload && payload.length) {
                          const data = payload[0].payload;
                          return (
                            <Card className="p-3 shadow-lg">
                              <p className="text-sm font-bold mb-2">{data.name}</p>
                              <div className="flex gap-2 mb-1">
                                <CITypeBadge type={data.type} size="small" />
                                <CIStatusBadge status={data.status} size="small" />
                              </div>
                              <p className="text-xs text-muted-foreground">
                                Environment: {data.environment}
                              </p>
                            </Card>
                          );
                        }
                        return null;
                      }}
                    />
                  </Treemap>
                </ResponsiveContainer>

                {/* CI List */}
                <div className="mt-4 max-h-[200px] overflow-y-auto space-y-2">
                  {currentImpactAnalysis.upstream.map((ci) => (
                    <div key={ci.id} className="p-2 border rounded-md hover:bg-muted/20 transition-colors">
                      <p className="text-sm font-medium mb-1">{ci.name}</p>
                      <div className="flex gap-2">
                        <CITypeBadge type={ci.type} size="small" />
                        <CIStatusBadge status={ci.status} size="small" />
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Downstream Dependencies */}
          {currentImpactAnalysis.downstream && currentImpactAnalysis.downstream.length > 0 && (
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Icon name="trend-down" size={20} className="text-secondary" />
                  <CardTitle className="text-base">Downstream Dependencies</CardTitle>
                </div>
                <p className="text-xs text-muted-foreground">
                  CIs that depend on {ciName} ({currentImpactAnalysis.downstream.length})
                </p>
              </CardHeader>
              <CardContent>
                <Separator className="mb-4" />

                {/* Treemap Visualization */}
                <ResponsiveContainer width="100%" height={300}>
                  <Treemap
                    data={currentImpactAnalysis.downstream.map((ci) => ({
                      name: ci.name,
                      size: 100,
                      type: ci.type,
                      status: ci.status,
                      environment: ci.environment,
                    }))}
                    dataKey="size"
                    aspectRatio={4 / 3}
                    stroke="#fff"
                    content={<CustomTreemapContent />}
                  >
                    <RechartsTooltip
                      content={({ active, payload }) => {
                        if (active && payload && payload.length) {
                          const data = payload[0].payload;
                          return (
                            <Card className="p-3 shadow-lg">
                              <p className="text-sm font-bold mb-2">{data.name}</p>
                              <div className="flex gap-2 mb-1">
                                <CITypeBadge type={data.type} size="small" />
                                <CIStatusBadge status={data.status} size="small" />
                              </div>
                              <p className="text-xs text-muted-foreground">
                                Environment: {data.environment}
                              </p>
                            </Card>
                          );
                        }
                        return null;
                      }}
                    />
                  </Treemap>
                </ResponsiveContainer>

                {/* CI List */}
                <div className="mt-4 max-h-[200px] overflow-y-auto space-y-2">
                  {currentImpactAnalysis.downstream.map((ci) => (
                    <div key={ci.id} className="p-2 border rounded-md hover:bg-muted/20 transition-colors">
                      <p className="text-sm font-medium mb-1">{ci.name}</p>
                      <div className="flex gap-2">
                        <CITypeBadge type={ci.type} size="small" />
                        <CIStatusBadge status={ci.status} size="small" />
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
};

export default ImpactPredictionPanel;
