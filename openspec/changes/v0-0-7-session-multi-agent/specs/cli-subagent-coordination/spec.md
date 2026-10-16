# Spec Delta

## Purpose

Extends the CLI with sub-agent lifecycle management tools, interactive slash commands for branching and archiving, cancellable FIFO approval queuing, and compact terminal progress rendering.

## ADDED Requirements

### Requirement: Model-facing sub-agent management tools
The runtime SHALL register list_agents, wait_agent, and cancel_agent tools declaring agent:spawn capability to enable inspecting, waiting on, and cancelling delegated sub-agent tasks.

#### Scenario: Inspecting sub-agent task tree
- **WHEN** the model or user calls list_agents
- **THEN** the system returns active tasks belonging to the current task tree, including role, status, elapsed duration, and pending approvals

#### Scenario: Waiting for specific sub-agents
- **WHEN** wait_agent is invoked with agent IDs and a timeout between 1 and 60 seconds
- **THEN** execution pauses until the specified tasks complete or the timeout elapses, returning state updates without terminating running tasks on timeout

#### Scenario: Cancelling a running sub-agent
- **WHEN** cancel_agent is called with a target agent ID
- **THEN** the runtime cancels the target task and all its descendants, returning confirmed cancellation and cleanup status

### Requirement: Interactive CLI commands for branching and archiving
The CLI SHALL provide /branch, /fork, /archive, and /agents commands integrated with the REPL dispatcher and input coordinator.

#### Scenario: Visualizing session DAG tree
- **WHEN** the user executes /history --tree
- **THEN** the CLI renders an ASCII tree visualization of conversation branches, indicating the active leaf and branch points

#### Scenario: Managing session archives
- **WHEN** the user runs /archive <id> on an idle session
- **THEN** the session is marked as archived and hidden from default history lists until restored via /archive restore <id>

### Requirement: Cancellable FIFO approval queue
The host CLI SHALL queue sub-agent interactive approval requests in a cancellable FIFO queue, presenting them serially to the user input coordinator without race conditions.

#### Scenario: Serial presentation of concurrent approvals
- **WHEN** multiple background sub-agents request interactive tool approvals simultaneously
- **THEN** the CLI queues requests in FIFO order, presenting one approval at a time, ensuring approval decisions are never cross-assigned
