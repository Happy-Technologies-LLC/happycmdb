// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** "Good morning, Nick": the part of day from the local hour and the first word of the user's display name. */
export function greeting(now: Date, fullName: string): string {
  const hour = now.getHours();
  const part = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  const first = fullName.trim().split(/\s+/)[0];
  return first ? `Good ${part}, ${first}` : `Good ${part}`;
}
