# Spec Delta

## Purpose

Provides global cross-project session discovery across user session directories, bounded streaming full-text search through conversation messages, and durable session logical archiving.

## ADDED Requirements

### Requirement: Cross-project catalog discovery
The CrossProjectSessionCatalog SHALL discover session metadata across all project directories in ~/.kapibala/sessions/, validating metadata cache validity without loading full session transcripts into memory.

#### Scenario: Listing sessions across projects
- **WHEN** the catalog scans session directories with the --all flag
- **THEN** it aggregates metadata items across distinct project keys, correctly reporting git branches, active branches, and last activity timestamps

### Requirement: Bounded streaming full-text search
The search engine SHALL stream visible user/assistant message text and branch summaries across sessions, supporting tokens, quoted phrases, field filters, and bounded regex patterns without unbounded memory accumulation.

#### Scenario: Phrase search matching transcript content
- **WHEN** a search query with quoted phrase "memory leak" is executed
- **THEN** the search engine returns matching sessions with conversation ID, branch ID, record ID, and contextual text excerpts

#### Scenario: Execution of bounded regular expression
- **WHEN** a regex query prefixed with re: is executed against sessions
- **THEN** the search executes within bounded time limits and worker isolation, returning matches or aborting with a timeout error if pathological backtracking occurs

### Requirement: Logical session archiving
The session manager SHALL support marking sessions as archived via durable archive_state control records, excluding archived sessions from default history listings and resume candidates.

#### Scenario: Archiving an idle session
- **WHEN** archiveSession is invoked on an idle session possessing no active sub-agents or unconsumed notifications
- **THEN** an archive_state record { archived: true } is persisted, and the session is excluded from standard list outputs

#### Scenario: Attempting to archive a session with active sub-agents
- **WHEN** archiveSession is called on a session that has active running sub-agents
- **THEN** the operation is rejected with SESSION_IN_USE, requiring tasks to be completed or cancelled prior to archiving
