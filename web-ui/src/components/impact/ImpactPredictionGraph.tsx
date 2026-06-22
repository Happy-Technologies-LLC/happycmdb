// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Button } from "@/components/ui/button";
import { LiquidGlass } from "@/components/ui/liquid-glass";
import { Badge } from "@/components/ui/badge";
/**
 * Impact Prediction Graph Component
 * Visualize change impact analysis with dependency graphs
 */

import React, { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { impactApi } from '../../api/impact';
import { ImpactAnalysis, DependencyGraph } from '../../types';
import Cytoscape from 'cytoscape';
import { Icon } from '@happy-technologies/design-system';

interface ImpactPredictionGraphProps {
  ciId: string;
}

export const ImpactPredictionGraph: React.FC<ImpactPredictionGraphProps> = ({ ciId }) => {
  const [changeType, setChangeType] = useState('CONFIGURATION_CHANGE');
  const [maxDepth, setMaxDepth] = useState(3);
  const graphRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Cytoscape.Core | null>(null);

  const { data: impactAnalysis, isLoading: isLoadingImpact } = useQuery({
    queryKey: ['impact', 'predict', ciId, changeType],
    queryFn: () => impactApi.predict(ciId, changeType),
    enabled: !!ciId,
  });

  const { data: graph, isLoading: isLoadingGraph } = useQuery({
    queryKey: ['impact', 'graph', ciId, maxDepth],
    queryFn: () => impactApi.getGraph(ciId, maxDepth),
    enabled: !!ciId,
  });

  // Initialize Cytoscape graph
  useEffect(() => {
    if (!graph || !graphRef.current) return;

    const elements = [
      // Nodes
      ...graph.nodes.map((node) => ({
        data: {
          id: node.id,
          label: node.ci_name,
          type: node.ci_type,
          criticality: node.criticality,
        },
      })),
      // Edges
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
              if (criticality > 80) return '#EF4444'; // red
              if (criticality > 60) return '#F59E0B'; // orange
              if (criticality > 40) return '#FBBF24'; // yellow
              return '#3B82F6'; // blue
            },
            label: 'data(label)',
            color: '#fff',
            'text-valign': 'center',
            'text-halign': 'center',
            'font-size': '12px',
            width: (ele: any) => {
              const criticality = ele.data('criticality');
              return 30 + criticality / 3;
            },
            height: (ele: any) => {
              const criticality = ele.data('criticality');
              return 30 + criticality / 3;
            },
          },
        },
        {
          selector: 'edge',
          style: {
            width: 2,
            'line-color': (ele: any) =>
              ele.data('critical') ? '#DC2626' : '#94A3B8',
            'target-arrow-color': (ele: any) =>
              ele.data('critical') ? '#DC2626' : '#94A3B8',
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

  const getRiskLevelColor = (level: string) => {
    switch (level) {
      case 'critical':
        return 'bg-red-100 text-red-800 border-red-200';
      case 'high':
        return 'bg-orange-100 text-orange-800 border-orange-200';
      case 'medium':
        return 'bg-yellow-100 text-yellow-800 border-yellow-200';
      case 'low':
        return 'bg-blue-100 text-blue-800 border-blue-200';
      case 'minimal':
        return 'bg-green-100 text-green-800 border-green-200';
      default:
        return 'bg-gray-100 text-gray-800 border-gray-200';
    }
  };

  const changeTypes = [
    'CONFIGURATION_CHANGE',
    'VERSION_UPGRADE',
    'RESTART',
    'DECOMMISSION',
    'NETWORK_CHANGE',
    'SECURITY_CHANGE',
    'PERFORMANCE_TUNING',
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-3xl font-bold tracking-tight">Impact Prediction</h2>
        <p className="text-muted-foreground mt-1">
          Analyze the potential impact of changes on dependent CIs
        </p>
      </div>

      {/* Controls */}
      <div className="bg-white rounded-lg shadow-sm border p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-2">Change Type</label>
            <select
              value={changeType}
              onChange={(e) => setChangeType(e.target.value)}
              className="w-full px-3 py-2 border rounded focus:ring-2 focus:ring-blue-500"
            >
              {changeTypes.map((type) => (
                <option key={type} value={type}>
                  {type.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-2">Graph Depth</label>
            <select
              value={maxDepth}
              onChange={(e) => setMaxDepth(Number(e.target.value))}
              className="w-full px-3 py-2 border rounded focus:ring-2 focus:ring-blue-500"
            >
              <option value={1}>1 Level</option>
              <option value={2}>2 Levels</option>
              <option value={3}>3 Levels</option>
              <option value={4}>4 Levels</option>
              <option value={5}>5 Levels</option>
            </select>
          </div>
        </div>
      </div>

      {/* Impact Summary */}
      {impactAnalysis && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-white p-4 rounded-lg shadow-sm border">
            <div className="flex items-center gap-2 mb-2">
              <Icon name="trend-up" size={20} className="text-blue-500" />
              <span className="text-sm font-medium text-muted-foreground mt-1">Impact Score</span>
            </div>
            <div className="text-3xl font-bold">{impactAnalysis.impact_score}</div>
            <div className="mt-2">
              <span
                className={`px-2 py-1 rounded text-xs font-medium uppercase ${getRiskLevelColor(
                  impactAnalysis.risk_level
                )}`}
              >
                {impactAnalysis.risk_level} Risk
              </span>
            </div>
          </div>

          <div className="bg-white p-4 rounded-lg shadow-sm border">
            <div className="flex items-center gap-2 mb-2">
              <Icon name="warning" size={20} className="text-orange-500" />
              <span className="text-sm font-medium text-muted-foreground mt-1">Blast Radius</span>
            </div>
            <div className="text-3xl font-bold">{impactAnalysis.blast_radius}</div>
            <div className="text-sm text-gray-500 mt-1">Affected CIs</div>
          </div>

          <div className="bg-white p-4 rounded-lg shadow-sm border">
            <div className="flex items-center gap-2 mb-2">
              <Icon name="git-branch" size={20} className="text-purple-500" />
              <span className="text-sm font-medium text-muted-foreground mt-1">Critical Path</span>
            </div>
            <div className="text-3xl font-bold">{impactAnalysis.critical_path.length}</div>
            <div className="text-sm text-gray-500 mt-1">Dependency hops</div>
          </div>

          <div className="bg-white p-4 rounded-lg shadow-sm border">
            <div className="flex items-center gap-2 mb-2">
              <Icon name="clock" size={20} className="text-red-500" />
              <span className="text-sm font-medium text-muted-foreground mt-1">Est. Downtime</span>
            </div>
            <div className="text-3xl font-bold">
              {impactAnalysis.estimated_downtime_minutes || 0}
            </div>
            <div className="text-sm text-gray-500 mt-1">Minutes</div>
          </div>
        </div>
      )}

      {/* Dependency Graph */}
      <LiquidGlass variant="default" rounded="xl">
        <h3 className="text-lg font-semibold mb-4">Dependency Graph</h3>
        <div
          ref={graphRef}
          className="w-full h-[600px] border rounded bg-gray-50"
          style={{ minHeight: '600px' }}
        />
        <div className="mt-4 flex items-center gap-4 text-sm">
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
      {impactAnalysis && impactAnalysis.affected_cis.length > 0 && (
        <LiquidGlass variant="default" rounded="xl">
          <h3 className="text-lg font-semibold mb-4">Affected CIs</h3>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead>
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    CI Name
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Type
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Impact Type
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Hops
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Probability
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Impact
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {impactAnalysis.affected_cis.map((ci, index) => (
                  <tr key={index} className="hover:bg-accent/50 transition-colors">
                    <td className="px-4 py-3 whitespace-nowrap font-medium">{ci.ci_name}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-muted-foreground">
                      {ci.ci_type}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span
                        className={`px-2 py-1 text-xs rounded ${
                          ci.impact_type === 'direct'
                            ? 'bg-red-100 text-red-800'
                            : 'bg-yellow-100 text-yellow-800'
                        }`}
                      >
                        {ci.impact_type}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm">{ci.hop_count}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm">
                      {ci.impact_probability}%
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground mt-1">{ci.estimated_impact}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </LiquidGlass>
      )}
    </div>
  );
};
