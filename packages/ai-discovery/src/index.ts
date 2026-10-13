// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * AI Discovery Package
 * Provider-agnostic AI-powered infrastructure discovery
 *
 * Supports:
 * - Anthropic Claude (claude-sonnet, claude-opus, claude-haiku)
 * - OpenAI (gpt-4, gpt-3.5-turbo)
 * - Custom/Private LLMs (vLLM, Ollama, LocalAI, etc.)
 *
 * Phase 2 Features:
 * - Pattern matching for fast discovery (<1 second)
 * - Hybrid routing (Pattern → AI → Fallback)
 * - Industry-standard pattern library
 * - Cost-controlled AI discovery
 *
 * Pattern analysis is restricted to attributed discovery sessions. Active
 * patterns are available to the internal matcher; shared pattern lifecycle
 * writes are unavailable until platform authority exists.
 */

export * from './types';
export * from './providers';
export * from './tools';
export * from './ai-agent-coordinator';
export * from './pattern-matcher';
export * from './pattern-storage';
export * from './hybrid-discovery-orchestrator';
export * from './pattern-analyzer';
export * from './pattern-validator';
export * from './pattern-workflow';

// Main exports for easy usage
export { AIAgentCoordinator } from './ai-agent-coordinator';
export {
  createLLMProvider,
  getDefaultLLMConfig,
  testLLMConnection,
} from './providers';
export { getAllDiscoveryTools, getBasicDiscoveryTools } from './tools';
export { PatternMatcher } from './pattern-matcher';
export { PatternStorageService } from './pattern-storage';
export { HybridDiscoveryOrchestrator } from './hybrid-discovery-orchestrator';
export { PatternAnalyzer } from './pattern-analyzer';
export { PatternValidator } from './pattern-validator';
export { PatternWorkflow } from './pattern-workflow';

// Re-export key types for convenience
export type {
  ILLMProvider,
  LLMConfig,
  LLMProvider,
  DiscoveryTool,
  AIDiscoveryContext,
  AIDiscoveryResult,
  AIDiscoverySession,
  DiscoveryPattern,
  PatternMatch,
  IPatternMatcher,
} from './types';
