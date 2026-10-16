# Spec Delta

## Purpose

Defines Session Schema v2 for single-file append-only conversation trees, separating physical sequence from causal parentage, managing persistent branch navigation, and providing read-only v1 legacy session upgrade copies.

## ADDED Requirements

### Requirement: Schema v2 envelope separating physical and causal sequence
The session store SHALL persist session records with schemaVersion 2, recording physical sequence pointers (seq and prevRecordId) for append verification and logical pointers (parentId and branchId) for causal DAG navigation.

#### Scenario: Appending record to active branch
- **WHEN** a new message record is appended to the session
- **THEN** the store links prevRecordId to the physical file tail and parentId to the active branch leaf record

#### Scenario: Appending global control record
- **WHEN** a global control record such as branch creation or archive state is recorded
- **THEN** parentId is set to null and the active conversational branch leaf is not advanced

### Requirement: Decoupled three revision dimensions
The session store and manager SHALL maintain three distinct revision counters: logRevision for physical log tail, branchLeafId for the active branch tip, and contentRevision for model-visible conversational content.

#### Scenario: Sidecar increment validation
- **WHEN** validating a sidecar metadata cache against the underlying session file
- **THEN** the manager verifies the physical prevRecordId and logRevision without conflating them with branch-local content revisions

### Requirement: Persistent branch creation and switching
The session manager SHALL allow branching from any closed completed interaction boundary or the initial root, atomically updating the active branch pointer in the durable log.

#### Scenario: Switching active branch
- **WHEN** a user or host invokes selectBranch with an existing branch identifier
- **THEN** the store persists a branch_selected event, updates activeLeafId, and reconstructs the active canonical history projection

#### Scenario: Branch attempt on unclosed transaction
- **WHEN** branching is requested from a record within an incomplete tool transaction or in-flight model run
- **THEN** the operation is rejected with an invalid boundary error and no state is mutated

### Requirement: Read-only v1 legacy session upgrade copy
The system SHALL support read-only browsing of legacy v1 sessions, and upon the first write operation, create an upgraded v2 session copy leaving the original v1 file completely intact.

#### Scenario: Resuming and writing to a v1 legacy session
- **WHEN** a write operation is initiated on an existing schema v1 session
- **THEN** the manager acquires the source lock, generates a new v2 session copy with upgradeIdentity metadata, and writes to the new copy while keeping the v1 original file untouched
