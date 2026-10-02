# Identity Resolution - Test Suite

Comprehensive test coverage for the Identity Reconciliation Engine.

## Test Structure

```
tests/
├── unit/                           # Unit tests (mocked dependencies)
│   ├── identity-reconciliation-engine.test.ts   # Core engine tests
│   ├── matching-strategies.test.ts              # Match algorithm tests
│   └── merge-strategies.test.ts                 # Field merging tests
├── integration/                    # Integration tests (real databases)
│   └── reconciliation-workflow.test.ts          # End-to-end workflows
└── fixtures/                       # Test data and factories
    ├── duplicate-ci-scenarios.ts                # Realistic duplicate scenarios
    └── ci-factory.ts                            # Test data builders
```

## Test Coverage Summary

- **Total Test Files**: 6 (3 unit, 1 integration, 2 fixtures)
- **Total Test Cases**: 74+
- **Target Coverage**: 80%+ (statements, branches, functions, lines)

## Test Scenarios Covered

### Unit Tests (58 test cases)

#### 1. Configuration Loading (2 tests)
- ✅ Load configuration from database
- ✅ Use default configuration if none found

#### 2. Matching Algorithms (30 tests)
**Strategy 1: External ID Match (6 tests)**
- ✅ AWS instance ID matching
- ✅ Azure VM resource ID matching
- ✅ GCP instance ID matching
- ✅ Source-specific external ID validation
- ✅ External ID with 100% confidence
- ✅ No match for missing external ID

**Strategy 2: Serial Number Match (4 tests)**
- ✅ VMware VM serial number
- ✅ Dell server BIOS serial
- ✅ HP server serial number
- ✅ 95% confidence for serial match

**Strategy 3: UUID Match (3 tests)**
- ✅ VMware BIOS UUID
- ✅ System UUID from dmidecode
- ✅ 95% confidence for UUID match

**Strategy 4: MAC Address Match (4 tests)**
- ✅ Single MAC address matching
- ✅ Multi-NIC server matching
- ✅ MAC address normalization (different formats)
- ✅ 85% confidence for MAC match

**Strategy 5: FQDN Match (3 tests)**
- ✅ Fully qualified domain name matching
- ✅ Case-insensitive FQDN matching
- ✅ 80% confidence for FQDN match

**Strategy 6: Composite Fuzzy Match (10 tests)**
- ✅ Exact hostname + exact IP match
- ✅ Similar hostname + exact IP match
- ✅ No match for very different hostnames
- ✅ Multiple candidate selection (best match)
- ✅ Hostname case variations
- ✅ Fuzzy score threshold validation
- ✅ 65%+ confidence for composite match

#### 3. CI Lifecycle (4 tests)
- ✅ Create new CI when no match found
- ✅ Record source lineage on creation
- ✅ Update existing CI when match found
- ✅ Emit CI discovered/updated events

#### 4. Merge Strategies (12 tests)
**Authority-Based Merging (4 tests)**
- ✅ Higher authority overwrites lower authority
- ✅ Lower authority cannot overwrite higher
- ✅ Equal authority prefers most recent
- ✅ Field addition from any source

**Multi-Source Reconciliation (2 tests)**
- ✅ Merge from 3+ sources based on authority
- ✅ Sequential discovery consistency

**Conflict Resolution (2 tests)**
- ✅ Detect field value conflicts
- ✅ Handle significant value differences

**Source Lineage (2 tests)**
- ✅ Track all discovery sources
- ✅ Update last_seen_at on rediscovery

**Edge Cases (2 tests)**
- ✅ Handle null vs empty string
- ✅ Handle array and object fields

#### 5. Match Strategy Priority (3 tests)
- ✅ External ID preferred over all others
- ✅ Cascade through strategies until match
- ✅ Try serial_number if external_id not found

#### 6. Error Handling (3 tests)
- ✅ Handle Neo4j connection errors
- ✅ Close sessions on error
- ✅ Handle PostgreSQL query failures

#### 7. Edge Cases (4 tests)
- ✅ CI with no identifiers
- ✅ Empty MAC address array
- ✅ Null/undefined identifier values
- ✅ Minimal identifier scenarios

### Integration Tests (16 test cases)

#### Scenario 1: Physical Server Multi-Source Discovery (2 tests)
- ✅ Reconcile same server from VMware, AWS, SSH, SNMP
- ✅ Handle out-of-order discovery (low confidence first)

#### Scenario 2: Cloud VM with Hostname Variations (2 tests)
- ✅ Match VMs despite hostname case differences
- ✅ Prioritize external_id over fuzzy hostname match

#### Scenario 3: Network Device with Multiple IPs (1 test)
- ✅ Reconcile device discovered via different management IPs

#### Scenario 4: Database with Conflicting Metadata (2 tests)
- ✅ Merge metadata based on source authority
- ✅ Prevent low-authority from overwriting high-authority

#### Scenario 5: Containerized Application (1 test)
- ✅ Reconcile container discovered via Docker and Kubernetes

#### Scenario 6: Application with Fuzzy Matching (2 tests)
- ✅ Match applications with similar names
- ✅ Prevent matching very different applications

#### Performance Tests (2 tests)
- ✅ Handle bulk reconciliation efficiently (<5s for 12 CIs)
- ✅ Maintain consistency under concurrent reconciliation

#### Edge Cases (4 tests)
- ✅ Handle CI with minimal identifiers
- ✅ Handle CI rediscovery after long period
- ✅ Verify source lineage tracking
- ✅ Verify field sources tracking

## Test Fixtures

### Duplicate CI Scenarios (6 realistic scenarios)
1. **Physical Server Duplicates** (4 discoveries)
   - VMware vCenter, AWS Systems Manager, SSH, SNMP
   - Tests serial number, UUID, MAC address, FQDN matching

2. **Cloud VM with Variations** (2 discoveries)
   - AWS API (external_id), SSH (hostname case variation)
   - Tests external_id priority and case-insensitive matching

3. **Network Device Duplicates** (2 discoveries)
   - Same Cisco switch via two management IPs
   - Tests serial number matching across multiple IPs

4. **Database with Conflicts** (2 discoveries)
   - Datadog (high authority), SSH (low authority)
   - Tests conflict resolution and authority-based merging

5. **Containerized App Duplicates** (2 discoveries)
   - Docker API, Kubernetes API
   - Tests container ID and IP-based matching

6. **Application Fuzzy Match** (2 discoveries)
   - ServiceNow CMDB, Datadog APM
   - Tests fuzzy matching with weak identifiers

### CI Factory Functions
- `createBaseCI()` - Base CI with defaults
- `createServerWithStrongIdentifiers()` - Server with serial, UUID, MAC
- `createServerWithWeakIdentifiers()` - Server with only hostname
- `createDuplicateServers()` - Generate N duplicates with shared identifiers
- `createNetworkDevice()` - Network device with serial and multiple IPs
- `createDatabase()` - Database with configurable authority
- `createCloudVM()` - Cloud VM for AWS/Azure/GCP
- `createContainer()` - Docker/Kubernetes container
- `createApplication()` - Application with weak identifiers
- `createConflictingCIs()` - Generate CIs with field conflicts
- `createCIBatch()` - Generate N CIs for performance testing

## Running Tests

### Unit Tests Only
```bash
npm run test:unit
```

### Integration Tests Only
```bash
npm run test:integration
```

### All Tests with Coverage
```bash
npm run test:coverage
```

### Run Specific Test File
```bash
npx jest identity-reconciliation-engine.test.ts
```

## Test Coverage Targets

| Metric     | Target | Purpose                           |
|------------|--------|-----------------------------------|
| Statements | 80%    | All code paths executed           |
| Branches   | 80%    | All conditional paths tested      |
| Functions  | 80%    | All functions invoked             |
| Lines      | 80%    | All lines executed                |

## Test Patterns Used

### TDD London School (Mockist)
- All external dependencies mocked (Neo4j, PostgreSQL, Redis)
- Focus on interactions and behavior
- Fast execution (<100ms per unit test)

### Integration Tests
- Real database interactions via Testcontainers
- Isolated test environments
- Slower execution (~1-5s per test)

### Arrange-Act-Assert Pattern
```typescript
it('should match by serial number', async () => {
  // Arrange
  const identifiers = { serial_number: 'SN-12345' };
  mockSession.run.mockResolvedValueOnce({ records: [/*...*/] });

  // Act
  const result = await engine.findExistingCI(identifiers, ci, ORG);

  // Assert
  expect(result?.match_strategy).toBe('serial_number');
  expect(result?.confidence).toBe(95);
});
```

## Key Reconciliation Scenarios Tested

### 1. Multi-Source Deduplication
- ✅ Same server discovered 4 times → 1 CI created
- ✅ Attributes merged based on source authority
- ✅ All sources tracked in lineage

### 2. Matching Algorithm Coverage
- ✅ All 6 matching strategies tested
- ✅ Cascading logic verified
- ✅ Confidence scores validated

### 3. Conflict Resolution
- ✅ Field conflicts resolved by authority
- ✅ Lower authority cannot overwrite higher
- ✅ Equal authority prefers most recent

### 4. Edge Cases
- ✅ Minimal identifiers (hostname only)
- ✅ No identifiers (should not crash)
- ✅ Null/empty field values
- ✅ Array and object fields
- ✅ Case variations in strings

### 5. Performance
- ✅ Bulk reconciliation (12 CIs in <5s)
- ✅ Concurrent reconciliation (10 parallel)
- ✅ Session cleanup on errors

## Coverage Estimation

Based on test suite analysis:

| Component                           | Est. Coverage |
|-------------------------------------|---------------|
| Configuration Loading               | 90%           |
| External ID Matching                | 95%           |
| Serial Number Matching              | 90%           |
| UUID Matching                       | 90%           |
| MAC Address Matching                | 90%           |
| FQDN Matching                       | 85%           |
| Composite Fuzzy Matching            | 85%           |
| CI Creation                         | 90%           |
| CI Update                           | 90%           |
| Field Merging                       | 85%           |
| Source Lineage Tracking             | 90%           |
| Error Handling                      | 80%           |
| **Overall Estimated Coverage**      | **87%**       |

## Notes

- Unit tests use mocked databases (fast, isolated)
- Integration tests require Neo4j and PostgreSQL (Testcontainers)
- Fixtures provide realistic duplicate scenarios from real-world cases
- CI factory functions support property-based testing
- All tests follow TDD London School principles
