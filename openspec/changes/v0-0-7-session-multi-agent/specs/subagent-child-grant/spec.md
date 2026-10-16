# Spec Delta

## Purpose

Enforces permission narrowing through ChildGrant intersection, binds specialized role presets to scenario model routing, and imposes absolute depth ceiling limits to prevent recursive delegation cycles.

## ADDED Requirements

### Requirement: ChildGrant permission intersection
The runtime SHALL derive sub-agent permissions by strictly intersecting the parent effective policy with the requested ChildGrant, and MUST NOT allow a sub-agent to widen permissions beyond its parent.

#### Scenario: Read-only parent spawns implement role
- **WHEN** a parent session in Approval mode with read-only rules spawns a sub-agent requesting implement role
- **THEN** the sub-agent inherits the parent's read-only restrictions and any write attempt is rejected with permission denied

#### Scenario: Sub-agent tool allowlist narrowing
- **WHEN** spawn_agent specifies an allowed_tools subset
- **THEN** the sub-agent tool registry includes only tools present in both the parent registry and the specified allowlist

### Requirement: Role presets and scenario model routing
The runtime SHALL provide authoritative role presets (explore, planner, implement, advisor, custom) that bind to configured scenario model routing (fast, planning, execution).

#### Scenario: Spawning explore role
- **WHEN** a sub-agent is spawned with role: explore
- **THEN** the sub-agent is assigned the fast scenario profile with strictly read-only capabilities and no shell write permissions

#### Scenario: Spawning advisor role
- **WHEN** a sub-agent is spawned with role: advisor
- **THEN** the sub-agent receives an empty tool registry, executing pure model reasoning with the planning scenario profile

### Requirement: Absolute depth ceiling enforcement
The runtime SHALL track the delegation depth of each session starting from 0 at the root, and MUST completely omit spawn_agent from the tool registry when depth reaches the maximum spawn depth limit.

#### Scenario: Sub-agent reaches depth limit
- **WHEN** a sub-agent is initialized at depth equal to maxSpawnDepth (default 3)
- **THEN** the spawn_agent tool is excluded from its tool registry and any invocation fails with unknown tool

### Requirement: Approval bubbling to parent terminal
When a sub-agent attempts to invoke a tool requiring interactive approval, the runtime SHALL route the approval request to the parent session approval channel with sub-agent attribution.

#### Scenario: Sub-agent tool triggers interactive approval
- **WHEN** a sub-agent invokes an action requiring approval under Approval mode
- **THEN** the request bubbles up to the parent terminal input coordinator showing the sub-agent role and description, blocking until the user accepts or rejects
