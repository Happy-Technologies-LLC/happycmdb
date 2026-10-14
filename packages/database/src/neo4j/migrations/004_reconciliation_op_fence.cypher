// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HP1-S1 v16 §2.4: one durable decision per reconciliation operation.
// Manual operator schema step for existing databases, AFTER the reserved
// 002 credential decision fence and 003 User._id index. Do not run the seed
// initializer against an existing database. No application or deployment
// action is authorized by this file.
// Idempotent; confirm ONLINE with SHOW CONSTRAINTS before writer cutover.
CREATE CONSTRAINT reconciliation_op_fence_unique IF NOT EXISTS
FOR (o:ReconciliationOp) REQUIRE o.op_id IS UNIQUE;
