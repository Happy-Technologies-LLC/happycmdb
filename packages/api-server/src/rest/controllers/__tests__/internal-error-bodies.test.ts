// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1733: a 5xx body never carries error text. Every handler of the listed
 * controllers runs against dependencies that throw an Error quoting SECRET;
 * whatever it answers with a 5xx must not contain SECRET or a stack, and the
 * detail must still reach logger.error. Handlers are discovered from the
 * prototype, so a new handler is covered without editing this file.
 */

import type { Request, Response } from 'express';
import { SECRET, loggedErrors } from '../../../__tests__/support/throwing-deps';

jest.mock('@cmdb/database', () => require('../../../__tests__/support/throwing-deps').databaseModule());
jest.mock('../../../read-admission', () => require('../../../__tests__/support/throwing-deps').readAdmissionModule());
jest.mock('@cmdb/common', () => require('../../../__tests__/support/throwing-deps').commonModule());

import { CIController } from '../ci.controller';
import { ITILController } from '../itil.controller';
import { AIPatternController } from '../ai-pattern.controller';
import { AnalyticsController } from '../analytics.controller';
import { DriftImpactController } from '../drift-impact.controller';
import { UnifiedCredentialController } from '../unified-credential.controller';
import { CredentialSetController } from '../credential-set.controller';
import { TBMController } from '../tbm.controller';
import { SettingsController } from '../settings.controller';
import { RelationshipController } from '../relationship.controller';
import { AnomalyController } from '../anomaly.controller';
import { AuthController } from '../../auth.controller';
import { throwing } from '../../../__tests__/support/throwing-deps';

const ORG = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const ID = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';

/** Any params key is a valid id; query/body start empty (overrides add what a handler validates). */
function request(overrides: Record<string, unknown> = {}): Request {
  return {
    params: new Proxy({}, { get: (_t, key) => (typeof key === 'string' ? ID : undefined) }),
    query: {}, body: {}, headers: {}, ip: '127.0.0.1', method: 'GET', path: '/', originalUrl: '/',
    user: { _userId: ID, _username: 'alice', _role: 'admin', _type: 'access', _organizationId: ORG },
    ...overrides,
  } as unknown as Request;
}

function response(jsonThrowsOnce: boolean) {
  const out = { status: 200, body: undefined as unknown };
  const res: Record<string, unknown> = {};
  let armed = jsonThrowsOnce;
  res['status'] = (code: number) => { out.status = code; return res; };
  res['json'] = (body: unknown) => {
    if (armed) { armed = false; throw new Error(SECRET); }
    out.body = body;
    return res;
  };
  for (const name of ['send', 'set', 'setHeader', 'header', 'type', 'end', 'cookie', 'clearCookie']) res[name] = () => res;
  return { res: res as unknown as Response, out };
}

const controllers: Array<[string, () => object]> = [
  ['CIController', () => new CIController()],
  ['ITILController', () => new ITILController()],
  ['AIPatternController', () => new AIPatternController(throwing(), throwing(), throwing(), throwing())],
  ['AnalyticsController', () => new AnalyticsController()],
  ['DriftImpactController', () => new DriftImpactController()],
  ['UnifiedCredentialController', () => new UnifiedCredentialController()],
  ['CredentialSetController', () => new CredentialSetController()],
  ['TBMController', () => new TBMController()],
  ['SettingsController', () => new SettingsController()],
  ['RelationshipController', () => new RelationshipController()],
  ['AnomalyController', () => new AnomalyController()],
  // Constructor only wires routes; the handlers use authService alone.
  ['AuthController', () => Object.assign(Object.create(AuthController.prototype), { authService: throwing() })],
];

/**
 * What a handler needs to get past its own validation so a dependency can fail.
 * jsonThrows: the handler has no failing dependency, so its first res.json() fails instead.
 */
type Case = { req?: Record<string, unknown>; jsonThrows?: boolean };
const CASES: Record<string, Case> = {
  'CIController.searchCIs': { req: { body: { query: 'x' } } },
  'AnomalyController.updateAnomalyStatus': { req: { body: { status: 'resolved' } } },
  'DriftImpactController.createBaseline': { req: { body: { ci_id: ID, snapshot_type: 'configuration' } } },
  'DriftImpactController.predictImpact': { req: { body: { ci_id: ID, change_type: 'restart' } } },
  'ITILController.updateIncident': { req: { body: { status: 'resolved' } } },
  'ITILController.createChange': { req: { body: { affectedCIIds: [ID] } } },
  'ITILController.updateChange': { req: { body: { status: 'implemented' } } },
  'ITILController.createBaseline': { req: { body: { ciIds: [ID] } } },
  'RelationshipController.getRelationshipsByType': { req: { params: { type: 'DEPENDS_ON' } } },
  'SettingsController.updateDiscoveryProviderSettings': { req: { params: { provider: 'aws' }, body: { credentials: { a: 'b' } } } },
  'TBMController.allocateCosts': { req: { body: { sourceId: ID, targetType: 'ci', targetIds: [ID] } } },
  'TBMController.importGLData': { req: { body: { records: [{ accountCode: '1' }] } }, jsonThrows: true },
  'SettingsController.testDiscoveryConnection': { req: { body: { provider: 'aws', credentials: {} } }, jsonThrows: true },
  'TBMController.getCostAllocations': { jsonThrows: true },
};

/** Handlers that, with the generic request, answer below 500 (validation, auth) and so cannot show a 5xx body. */
const NO_5XX = [
  'AnalyticsController.getChangeHistory', 'AnalyticsController.getHealthMetrics', 'AnomalyController.queryAggregate',
  'AnomalyController.runAnomalyDetection', 'AuthController.changePassword', 'AuthController.login',
  'AuthController.logout', 'AuthController.refreshToken', 'AuthController.updateProfile', 'CIController.createCI',
  'ITILController.restoreFromBaseline', 'ITILController.scheduleAudit',
  'RelationshipController.createRelationship', 'RelationshipController.deleteRelationship',
  'SettingsController.getDatabaseStatus',
];
/** Two-argument private helpers that discovery picks up; they are not request handlers. */
const HELPERS = new Set(['TBMController.allocateEqual', 'UnifiedCredentialController.refusedC4']);
const without5xx: string[] = [];
const with5xx = new Map<string, number>();

describe.each(controllers)('%s', (name, build) => {
  const instance = build() as Record<string, (req: Request, res: Response) => Promise<void>>;
  const proto = Object.getPrototypeOf(instance) as object;
  const handlers = Object.getOwnPropertyNames(proto).filter(
    key => key !== 'constructor' && !HELPERS.has(`${name}.${key}`) && typeof instance[key] === 'function' && instance[key]!.length === 2,
  );

  it.each(handlers)('%s', async handler => {
    const testCase = CASES[`${name}.${handler}`] ?? {};
    const { res, out } = response(testCase.jsonThrows === true);
    loggedErrors.length = 0;
    // A handler may throw after answering (a failing session.close() in finally); the body is still what the client got.
    await instance[handler]!(request(testCase.req), res).catch(() => undefined);
    if (out.status < 500) {
      without5xx.push(`${name}.${handler}`);
      return;
    }
    with5xx.set(name, (with5xx.get(name) ?? 0) + 1);
    const body = JSON.stringify(out.body ?? null);
    expect(body).not.toContain(SECRET);
    expect(body).not.toMatch(/"stack"|\\n\s+at |\.ts:\d+/);
    expect(loggedErrors.length).toBeGreaterThan(0);
  });
});

// 4xx bodies keep their contract (HAP-1733 does not touch them), so only 5xx rows are asserted. A handler
// that stops reaching its 5xx path (or a new one that never does) must be listed or given a CASE.
it('the handlers that cannot show a 5xx are exactly the known ones; every controller shows some', () => {
  expect(without5xx.sort()).toEqual(NO_5XX);
  expect([...with5xx.keys()].sort()).toEqual(controllers.map(([name]) => name).sort());
});
