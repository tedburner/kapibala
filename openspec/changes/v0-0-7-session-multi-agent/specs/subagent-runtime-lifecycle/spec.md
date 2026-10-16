# Spec Delta

## Purpose

Manages the background execution of delegated sub-agents, handling task tree hierarchy, acceptance transaction closure, waiting for descendant completion, cascading cancellation, and guaranteed process tree cleanup.

## ADDED Requirements

### Requirement: Acceptance transaction closure for spawn_agent
When spawn_agent is invoked, the runtime SHALL validate parameters and capacity, persist the acceptance intent, and immediately return a tool result containing the agentId to close the parent tool transaction.

#### Scenario: Sub-agent dispatch closes parent tool call
- **WHEN** the parent model invokes spawn_agent with valid task instructions
- **THEN** the parent session receives an acceptance tool_result with the new agentId, closes the tool transaction, and allows the parent model to proceed with subsequent reasoning turns

#### Scenario: Rejection when capacity is exceeded
- **WHEN** spawn_agent is called but the active sub-agent capacity limit has been reached
- **THEN** the call fails immediately with an AGENT_CAPACITY_EXCEEDED tool error without launching background tasks

### Requirement: Task tree lifecycle and waiting for descendants
A sub-agent whose primary conversational turns have finished while having active descendants SHALL transition to waiting_children state, continuing to occupy its active slot until all descendants conclude and roll up.

#### Scenario: Child agent waits for grand-children
- **WHEN** a sub-agent completes its own steps but has spawned child tasks still in progress
- **THEN** the sub-agent enters waiting_children state and withholds its final completion notification to the parent until all descendants finish and clean up

### Requirement: Cascading cancellation and process tree recovery
When a parent session run is explicitly aborted or cancel_agent is called, the runtime SHALL cascade the abort signal to all descendant tasks and forcefully reclaim all spawned child process trees.

#### Scenario: Aborting an in-flight sub-agent task tree
- **WHEN** a user triggers Ctrl+C or cancels a parent run that launched active sub-agents
- **THEN** the runtime issues abort signals to the sub-agent tree, reclaims process trees via platform process guards (taskkill on Windows, SIGKILL on POSIX), and marks final states as cancelled

### Requirement: Crash recovery and state reconciliation
Following an abnormal process termination, the runtime SHALL reconcile unconfirmed sub-agent tasks against parent logs, closing incomplete tool transactions with OUTCOME_UNKNOWN without blindly replaying side effects.

#### Scenario: Recovering from process crash during sub-agent execution
- **WHEN** a session is reopened after an unclean process crash during sub-agent execution
- **THEN** unconfirmed active sub-agents are marked as interrupted, side effects are flagged as unknown, and no automatic model re-execution is triggered
