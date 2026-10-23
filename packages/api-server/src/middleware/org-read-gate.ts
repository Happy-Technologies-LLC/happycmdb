// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import type { NextFunction, Request, Response } from 'express';
import { requestOrganizationId } from './auth.middleware';

// HAP-850 (X-29): frozen by signed ruling, no config surface. Per verified organization, per process.
const MAX_ACTIVE = 2;
const SPACING_MS = 50; // minimum gap between one organization's queued admissions
const MAX_WAITING = 64;
const WAIT_MS = 5000;

type OrgGate = {
  active: number; waiting: Array<() => void>; lastQueuedAdmit: number; timer?: ReturnType<typeof setTimeout>;
};
const gates = new Map<string, OrgGate>();

/** Admit the oldest waiter once a slot is free and the pacing gap passed (a timer, never a spin). */
function pump(org: string, gate: OrgGate): void {
  if (gate.timer || gate.active >= MAX_ACTIVE) return;
  if (gate.waiting.length === 0) {
    if (gate.active === 0) gates.delete(org);
    return;
  }
  const delay = gate.lastQueuedAdmit + SPACING_MS - performance.now(); // monotonic: immune to wall-clock steps
  if (delay > 0) {
    gate.timer = setTimeout(() => { gate.timer = undefined; pump(org, gate); }, delay);
    return;
  }
  gate.lastQueuedAdmit = performance.now();
  gate.waiting.shift()!();
  pump(org, gate);
}

/**
 * Bound one verified organization's concurrent gated reads; mount after requireOrganization and
 * validation. `work` must settle when the handler's work settles, not when its response was sent: the
 * slot is released only then. Overflow and wait-deadline rejections send the route's existing static
 * body, and a waiter whose client disconnected is removed without ever running.
 */
export function orgReadGate(status: number, body: unknown, work: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const org = requestOrganizationId(req);
    const gate = gates.get(org) ?? { active: 0, waiting: [], lastQueuedAdmit: -Infinity };
    gates.set(org, gate);
    const run = () => {
      gate.active++;
      work(req, res).catch(next).finally(() => { gate.active--; pump(org, gate); });
    };
    if (gate.active < MAX_ACTIVE && gate.waiting.length === 0) return run();
    if (gate.waiting.length >= MAX_WAITING) {
      res.status(status).json(body);
      return;
    }
    if (req.socket.destroyed) return;
    const leave = () => {
      clearTimeout(deadline);
      res.off('close', leave);
      const index = gate.waiting.indexOf(admit);
      if (index >= 0) gate.waiting.splice(index, 1);
      pump(org, gate);
    };
    const admit = () => {
      clearTimeout(deadline);
      res.off('close', leave);
      run();
    };
    const deadline = setTimeout(() => { leave(); res.status(status).json(body); }, WAIT_MS);
    res.once('close', leave);
    gate.waiting.push(admit);
  };
}
