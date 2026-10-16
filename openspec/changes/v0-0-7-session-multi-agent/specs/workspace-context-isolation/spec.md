# Spec Delta

## Purpose

Provides explicit workspace identity and directory parameterization, dedicated per-session path sandbox instances, and workspace write coordination to ensure safe concurrent multi-session and multi-agent execution.

## ADDED Requirements

### Requirement: Explicit workspace root and execution directory
The runtime SHALL require explicit absolute paths for workspace root and execution working directory, normalized via native realpath, and MUST NOT fallback to process.cwd() or relative dots.

#### Scenario: Initialization with missing workspace root
- **WHEN** an AgentSession is initialized without an explicit workspace root
- **THEN** the system throws a WORKSPACE_ROOT_REQUIRED error and aborts creation

#### Scenario: Normalization of Windows short paths
- **WHEN** a workspace path with Windows 8.3 short aliases is provided
- **THEN** the system resolves it using native realpath semantics to establish identical physical identity

### Requirement: Dedicated per-session path sandbox
Each AgentSession SHALL own a dedicated PathSandbox instance scoped strictly to its assigned workspace root, without sharing a global singleton sandbox cache.

#### Scenario: Concurrent execution across distinct workspaces
- **WHEN** two AgentSession instances execute filesystem operations in separate project directories concurrently within the same Node.js process
- **THEN** each session resolves relative paths strictly within its own workspace root and cannot access the other workspace without explicit authorization

### Requirement: Workspace write lease coordination
The runtime SHALL enforce a workspace write lease for sub-agents sharing the parent workspace, serializing write operations across file tools, shell execution, and write-capable external tools.

#### Scenario: Concurrent write attempt without worktree
- **WHEN** a sub-agent requests workspace write access while the parent workspace is shared and busy with active writes
- **THEN** the system requires acquisition of the write lease or rejects concurrent writes until the active lease is released

### Requirement: Architecture guard against implicit process environment
The build and verification pipeline SHALL statically inspect the Core source code and reject any non-explicit invocation of process.cwd().

#### Scenario: Build verification detects process.cwd call in Core
- **WHEN** pnpm check-architecture runs against the Core package containing an unapproved process.cwd() call
- **THEN** the check fails with an architectural violation error identifying the offending file and line
