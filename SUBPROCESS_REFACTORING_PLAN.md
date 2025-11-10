# Pytest Subprocess Refactoring Plan

## Overview
This document outlines the refactoring approach to prepare for running multiple pytest subprocesses in parallel.

## Current State
The `pytestExecutionAdapter.ts` file currently manages test execution with scattered state that would need to be duplicated per subprocess.

## Refactored Architecture

### New Class: `PytestSubprocessInstance`
**Location**: `src/client/testing/testController/pytest/pytestSubprocessInstance.ts`

This class encapsulates all state and resources needed for a single subprocess instance:

#### Instance-Specific Properties
- `deferred: Deferred<ExecutionTestPayload>` - Promise for execution result
- `process: ChildProcess` - The running subprocess
- `cancellationToken: { cancelled: boolean }` - Cancellation state
- `testRun: TestRun` - VS Code test run context
- `debugBool: boolean` - Whether this is a debug session
- `workspaceUri: Uri` - Workspace root
- `server: ITestServer` - Server connection (shared or per-instance)
- `outputChannel: ITestOutputChannel` - Output channel (shared or per-instance)

#### Methods
- `handleDataReceivedEvent(data: DataReceivedEvent)` - Process server data
- `setProcess(process: ChildProcess)` - Set the subprocess
- `setCancellationToken(token)` - Set cancellation token
- `isCancelled()` - Check cancellation state
- `dispose()` - Clean up resources (kill process)
- `getExecutionPromise()` - Get the execution promise

## Migration Path

### Phase 1: Extract Instance Class ✅
- Create `PytestSubprocessInstance` class
- Define all instance-specific properties and methods

### Phase 2: Refactor PytestExecutionAdapter
Update `pytestExecutionAdapter.ts` to use the new class:

```typescript
export class PytestExecutionAdapter implements ITestExecutionAdapter {
    // Shared resources
    private configSettings: IConfigurationService;
    private outputChannel: ITestOutputChannel;
    private server: ITestServer;

    // Active subprocess instances
    private activeInstances: Map<string, PytestSubprocessInstance>;

    // Create new instance for each execution
    public async runTests(testRun: TestRun, ...): Promise<ExecutionTestPayload> {
        const instance = new PytestSubprocessInstance(
            testRun,
            debugBool,
            workspaceUri,
            this.server,
            this.outputChannel
        );

        // Register instance
        this.activeInstances.set(instanceId, instance);

        // Execute tests
        const process = await this.spawnPytestProcess(instance, ...);
        instance.setProcess(process);

        // Wait for completion
        const result = await instance.getExecutionPromise();

        // Cleanup
        this.activeInstances.delete(instanceId);
        instance.dispose();

        return result;
    }
}
```

### Phase 3: Support Multiple Parallel Subprocesses
- Modify server communication to route messages to correct instance
- Add instance ID to all communication
- Implement parallel execution logic
- Add resource pooling/limits

## Benefits of This Refactoring

1. **Clear Boundaries**: All per-subprocess state is encapsulated in one class
2. **Easy to Scale**: Can create multiple instances without state conflicts
3. **Better Resource Management**: Each instance manages its own lifecycle
4. **Testability**: Can test subprocess instances in isolation
5. **Future-Proof**: Ready for parallel execution with minimal additional changes

## Next Steps

1. ✅ Create `PytestSubprocessInstance` class
2. Update `pytestExecutionAdapter.ts` to use the new class
3. Update server message routing to support multiple instances
4. Add instance ID generation and tracking
5. Implement parallel execution coordinator
6. Add configuration for max parallel subprocesses
7. Update tests to cover parallel execution scenarios

## Considerations

### Server Communication
- **Option A**: Shared server with instance routing (use UUID in messages)
- **Option B**: One server per subprocess (more isolation, more overhead)
- **Recommendation**: Start with Option A, easier to manage

### Output Channel
- **Option A**: Shared output channel with prefixed messages
- **Option B**: Separate output channels per subprocess
- **Recommendation**: Option A for simplicity, Option B for debugging

### Resource Limits
- Add configuration for max parallel subprocesses (default: 4)
- Queue additional requests when limit reached
- Monitor memory/CPU usage per subprocess

### Error Handling
- Each instance handles its own errors
- Failed subprocess doesn't affect others
- Aggregate errors at adapter level
