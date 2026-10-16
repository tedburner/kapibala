# Spec Delta

## Purpose

Captures contextual exploration and troubleshooting summaries when branching away from abandoned conversation paths, and enables exporting independent session files via path-isolated fork operations.

## ADDED Requirements

### Requirement: Branch contextual summary capture
When creating a new branch from an earlier ancestor, the system SHALL support capturing an optional branch_summary record summarizing the abandoned path between the former leaf and the common ancestor.

#### Scenario: Branching with summary generation
- **WHEN** branchWithSummary is invoked with a target record ID and summary text
- **THEN** the store moves the leaf pointer to the target record, appends a branch_summary record linked to the target, and exposes the summary to subsequent model turns on the new branch

#### Scenario: Summary generation failure or cancellation
- **WHEN** summary generation fails or is aborted before completion
- **THEN** the store does not advance the leaf pointer and preserves the existing branch state without partial summary writes

### Requirement: Standalone session export via forkSession
The session manager SHALL allow exporting the active branch path from root to the specified leaf into a brand-new independent session file with its own conversation identifier.

#### Scenario: Exporting a clean fork session
- **WHEN** forkSession is executed on a valid leaf of an idle session
- **THEN** a new session file is created with new conversationId, recording parentSessionId and forkPointRecordId in its header, replicating only path-ancestor records

#### Scenario: State isolation in forked session
- **WHEN** a forked session is initialized
- **THEN** active approval caches, pending background tasks, and unconsumed notifications are not transferred to the new session
