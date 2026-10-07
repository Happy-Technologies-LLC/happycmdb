// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Pattern Validator
 * Tests and validates generated patterns before activation
 */

import { DiscoveryPattern } from './types';
import { logger } from '@cmdb/common';
import { detectWithPlan, parseDetectionPlan, parseDiscoveryPlan, UNSUPPORTED_PATTERN_PLAN } from './pattern-plan';

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  testResults: TestResult[];
}

export interface TestResult {
  testName: string;
  passed: boolean;
  actual: any;
  expected: any;
  error?: string;
}

export class PatternValidator {
  /**
   * Validate pattern comprehensively
   */
  async validate(pattern: DiscoveryPattern): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const testResults: TestResult[] = [];

    logger.info('Validating pattern', { patternId: pattern.patternId });

    const syntaxCheck = this.validateSyntax(pattern);
    errors.push(...syntaxCheck.errors);
    if (errors.length === 0 && pattern.testCases?.length) {
      const testCheck = await this.runTestCases(pattern);
      testResults.push(...testCheck.results);
      errors.push(...testCheck.errors);
    } else if (!pattern.testCases?.length) {
      warnings.push('No test cases defined for pattern');
    }

    const isValid = errors.length === 0;

    logger.info('Pattern validation complete', {
      patternId: pattern.patternId,
      isValid,
      errors: errors.length,
      warnings: warnings.length,
    });

    return {
      isValid,
      errors,
      warnings,
      testResults,
    };
  }

  /** Validate the fixed plan schema, without evaluating pattern text. */
  private validateSyntax(pattern: DiscoveryPattern): {
    errors: string[];
    warnings: string[];
  } {
    try {
      parseDetectionPlan(pattern.detectionCode);
      parseDiscoveryPlan(pattern.discoveryCode);
      return { errors: [], warnings: [] };
    } catch {
      return { errors: [UNSUPPORTED_PATTERN_PLAN], warnings: [] };
    }
  }
  /**
   * Run test cases against pattern
   */
  private async runTestCases(pattern: DiscoveryPattern): Promise<{
    results: TestResult[];
    errors: string[];
    warnings: string[];
  }> {
    const results: TestResult[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const testCase of pattern.testCases) {
      try {
        const result = await this.runSingleTest(pattern, testCase);
        results.push(result);

        if (!result.passed) {
          errors.push(`Test "${testCase.name}" failed: ${result.error || 'Assertion failure'}`);
        }
      } catch (error) {
        results.push({
          testName: testCase.name,
          passed: false,
          actual: null,
          expected: testCase.expected,
          error: error instanceof Error ? error.message : String(error),
        });
        errors.push(`Test "${testCase.name}" threw error: ${error}`);
      }
    }

    return { results, errors, warnings };
  }

  /**
   * Run a single test case
   */
  private async runSingleTest(
    pattern: DiscoveryPattern,
    testCase: any
  ): Promise<TestResult> {
    const testName = testCase.name || 'Unnamed test';

    try {
      const detectionResult = detectWithPlan(parseDetectionPlan(pattern.detectionCode), testCase.input);
      // Check expectations
      const expected = testCase.expected;
      let passed = true;
      let error: string | undefined;

      if (expected.matches !== undefined) {
        if (detectionResult.matches !== expected.matches) {
          passed = false;
          error = `Expected matches=${expected.matches}, got ${detectionResult.matches}`;
        }
      }

      if (expected.confidenceMin !== undefined) {
        if (detectionResult.confidence < expected.confidenceMin) {
          passed = false;
          error = `Expected confidence >=${expected.confidenceMin}, got ${detectionResult.confidence}`;
        }
      }

      if (expected.confidenceMax !== undefined) {
        if (detectionResult.confidence > expected.confidenceMax) {
          passed = false;
          error = `Expected confidence <=${expected.confidenceMax}, got ${detectionResult.confidence}`;
        }
      }

      return {
        testName,
        passed,
        actual: detectionResult,
        expected,
        error,
      };
    } catch (error) {
      return {
        testName,
        passed: false,
        actual: null,
        expected: testCase.expected,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }


  /** Quick plan validation without test-case execution. */
  async quickValidate(pattern: DiscoveryPattern): Promise<{
    isValid: boolean;
    errors: string[];
  }> {
    const errors: string[] = [];

    const syntaxCheck = this.validateSyntax(pattern);
    errors.push(...syntaxCheck.errors);


    return {
      isValid: errors.length === 0,
      errors,
    };
  }
}
