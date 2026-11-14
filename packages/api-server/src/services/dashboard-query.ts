// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** Read bounds shared by the dashboard reads and the estate topology summary. */

/** Per-query read timeout for dashboard and topology reads. */
export const DASHBOARD_QUERY_TIMEOUT_MS = 5000;

/** Largest group set a dashboard aggregate may return before it is refused rather than truncated. */
export const MAX_DASHBOARD_GROUPS = 100;
