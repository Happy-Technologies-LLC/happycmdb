// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * AI Discovery Types
 * Provider-agnostic types for AI-powered infrastructure discovery
 */

/**
 * Supported LLM providers
 */
export enum LLMProvider {
  ANTHROPIC = 'anthropic',
  OPENAI = 'openai',
  CUSTOM = 'custom', // For private/self-hosted models
}

/**
 * LLM model configuration
 */
export interface LLMConfig {
  provider: LLMProvider;
  model: string; // e.g., 'claude-sonnet-4.5', 'gpt-4', 'llama-3-70b'
  apiKey?: string; // Optional for private models with no auth
  baseURL?: string; // For custom/private deployments
  temperature?: number;
  maxTokens?: number;
  timeout?: number; // milliseconds
}

/**
 * Discovery tool definition (for LLM tool calling)
 */
export interface DiscoveryTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  execute: (params: any) => Promise<any>;
}

/**
 * AI discovery context
 */
export interface AIDiscoveryContext {
  targetHost: string;
  targetPort: number;
  scanResult?: any; // Initial scan data (from NMAP, etc.)
  credentials?: any; // Available credentials
  tags?: Record<string, string>;
  maxCost?: number; // Maximum cost in USD for this discovery
  timeout?: number; // Maximum time in milliseconds
}

/**
 * AI tool call (logged for pattern learning)
 */
export interface AIToolCall {
  id: string;
  toolName: string;
  input: any;
  output: any;
  success: boolean;
  executionTime: number; // milliseconds
  timestamp: Date;
  error?: string;
}

/**
 * AI discovery session (tracks one discovery job)
 */
export interface AIDiscoverySession {
  id: string;
  sessionId: string;
  targetHost: string;
  targetPort: number;
  status: 'running' | 'completed' | 'failed';
  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;

  // AI details
  aiModel: string;
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  estimatedCost?: number;

  // Results
  discoveredCIs?: any[];
  confidenceScore?: number;

  // Trace (for pattern learning)
  toolCalls: AIToolCall[];
  aiReasoning?: string;
  patternMatched?: string;

  // Error handling
  errorMessage?: string;
  retryCount: number;
}

/**
 * Discovery pattern (learned or manually created)
 */
export interface DiscoveryPattern {
  id: string;
  patternId: string;
  name: string;
  version: string;
  category: string;

  // Strict JSON detection-v1/discovery-v1 plans in legacy column names; executable code is unsupported.
  detectionCode: string;
  discoveryCode: string;

  // Metadata
  description?: string;
  author: string;
  license: string;

  // Quality metrics
  confidenceScore: number;
  usageCount: number;
  successCount: number;
  failureCount: number;
  avgExecutionTimeMs?: number;

  // Learning provenance
  learnedFromSessions?: string[];
  aiModel?: string;

  // Lifecycle
  status: 'draft' | 'review' | 'approved' | 'active' | 'deprecated';
  isActive: boolean;

  // Community (if synced)
  registryUrl?: string;
  communityUpvotes?: number;
  communityDownvotes?: number;

  // Validation
  testCases?: any[];

  createdAt: Date;
  updatedAt: Date;
  approvedAt?: Date;
  approvedBy?: string;
}

/**
 * Pattern match result
 */
export interface PatternMatch {
  patternId: string;
  patternVersion: string;
  confidence: number;
  matchedIndicators: string[];
  /** Hash of the active plans used to produce this match; guards match-to-execution races. */
  activeSetHash: string;
}

/**
 * AI discovery result
 */
export interface AIDiscoveryResult {
  success: boolean;
  session: AIDiscoverySession;
  discoveredCIs: any[];
  confidence: number;
  executionTimeMs: number;
  cost?: number;
  error?: string;
}

/**
 * LLM provider interface (implemented by each provider)
 */
export interface ILLMProvider {
  /**
   * Provider name
   */
  readonly name: string;

  /**
   * Execute discovery with tool calling
   */
  discover(
    context: AIDiscoveryContext,
    tools: DiscoveryTool[],
    systemPrompt: string,
    userPrompt: string
  ): Promise<{
    reasoning: string;
    toolCalls: AIToolCall[];
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    cost: number;
  }>;

  /**
   * Test connection to LLM provider
   */
  testConnection(): Promise<boolean>;
}

/**
 * Pattern matcher interface
 */
export interface IPatternMatcher {
  /**
   * Load patterns from storage
   */
  loadPatterns(): Promise<void>;

  /**
   * Match scan result against patterns
   */
  match(scanResult: any): Promise<PatternMatch | null>;

  /**
   * Execute matched pattern
   */
  executePattern(
    patternId: string,
    context: AIDiscoveryContext,
    expectedActiveSetHash?: string
  ): Promise<any[]>;

  /**
   * Add new pattern
   */
  addPattern(pattern: DiscoveryPattern): Promise<void>;
}

/**
 * Pattern compiler interface
 */
export interface IPatternCompiler {
  /**
   * Analyze discovery session to see if it's a pattern
   */
  analyzeSession(session: AIDiscoverySession): Promise<boolean>;

  /**
   * Compile pattern from AI discovery traces
   */
  compilePattern(sessions: AIDiscoverySession[]): Promise<DiscoveryPattern>;

  /**
   * Validate generated pattern
   */
  validatePattern(pattern: DiscoveryPattern): Promise<{
    isValid: boolean;
    errors: string[];
  }>;
}
