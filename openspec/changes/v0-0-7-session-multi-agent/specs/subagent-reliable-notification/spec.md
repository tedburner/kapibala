# Spec Delta

## Purpose

Delivers sub-agent completion outcomes through a durable outbox-to-inbox pipeline, deduplicating deliveries and scheduling notification turns safely onto the origin conversation branch.

## ADDED Requirements

### Requirement: Durable Outbox and Inbox delivery
When a sub-agent reaches terminal state, the runtime SHALL persist a durable outbox record containing eventId, terminal state, outcome summary, and usage metrics, awaiting acknowledgment from the parent inbox.

#### Scenario: Sub-agent completes and dispatches notification
- **WHEN** a sub-agent completes all turns and process cleanup
- **THEN** it appends an outbox record with a unique eventId and dispatches the notification to the parent session coordinator

### Requirement: Background consumption message deduplication
The parent session coordinator SHALL record inbox receipts, deduplicate using eventId and deliveryId, and persist consumed notifications as background messages via MessageStore.append.

#### Scenario: Processing and acknowledging notification
- **WHEN** the parent session coordinator receives an outbox notification for an unconsumed eventId
- **THEN** it appends the message with source: subagent, persists an inbox_consumed event, and sends an acknowledgment back to the child outbox

#### Scenario: Preventing duplicate consumption on restart
- **WHEN** a notification is redelivered after a parent process crash that occurred after message append
- **THEN** the coordinator recognizes the existing deliveryId, suppresses duplicate message insertion, and re-issues the missing acknowledgment

### Requirement: Origin-branch-safe notification scheduling
The session coordinator SHALL schedule notification turns exclusively on the origin branch from which the sub-agent was spawned and only when the parent session is idle.

#### Scenario: Notification arrives while parent is active on another branch
- **WHEN** a sub-agent notification arrives but the parent session has switched to a different branch
- **THEN** the coordinator preserves the notification in pending state, presents a non-intrusive hint to the user, and does not inject the message or switch branches automatically

#### Scenario: Notification arrives while parent model stream is busy
- **WHEN** a notification arrives during an active model streaming or tool execution turn
- **THEN** the notification is queued and held until the current interaction turn safely finishes
