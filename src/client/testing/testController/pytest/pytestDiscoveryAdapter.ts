// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import * as path from 'path';
import { CancellationToken, CancellationTokenSource, Uri } from 'vscode';
import * as fs from 'fs';
import { ChildProcess } from 'child_process';
import {
    ExecutionFactoryCreateWithEnvironmentOptions,
    IPythonExecutionFactory,
    SpawnOptions,
} from '../../../common/process/types';
import { IConfigurationService } from '../../../common/types';
import { createDeferred, Deferred } from '../../../common/utils/async';
import { EXTENSION_ROOT_DIR } from '../../../constants';
import { traceError, traceInfo, traceVerbose, traceWarn } from '../../../logging';
import { DiscoveredTestPayload, ITestDiscoveryAdapter, ITestResultResolver } from '../common/types';
import {
    createDiscoveryErrorPayload,
    createTestingDeferred,
    fixLogLinesNoTrailing,
    startDiscoveryNamedPipe,
    addValueIfKeyNotExist,
    hasSymlinkParent,
} from '../common/utils';
import { IEnvironmentVariablesProvider } from '../../../common/variables/types';
import { PythonEnvironment } from '../../../pythonEnvironments/info';
import { PythonEnvironment as EnvExtPythonEnvironment } from '../../../envExt/types';
import { useEnvExtension, getEnvironment, runInBackground, getEnvExtApi } from '../../../envExt/api.internal';

/**
 * Wrapper class for unittest test discovery. This is where we call `runTestCommand`. #this seems incorrectly copied
 */
export class PytestTestDiscoveryAdapter implements ITestDiscoveryAdapter {
    constructor(
        public configSettings: IConfigurationService,
        private readonly resultResolver?: ITestResultResolver,
        private readonly envVarsService?: IEnvironmentVariablesProvider,
    ) {}

    async discoverTests(
        uri: Uri,
        executionFactory: IPythonExecutionFactory,
        token?: CancellationToken,
        interpreter?: PythonEnvironment,
    ): Promise<void> {
        const cSource = new CancellationTokenSource();
        const deferredReturn = createDeferred<void>();

        token?.onCancellationRequested(() => {
            traceInfo(`Test discovery cancelled.`);
            cSource.cancel();
            deferredReturn.resolve();
        });

        // If using env extension, get the number of projects to discover upfront
        let expectedConnections = 1;
        if (useEnvExtension()) {
            try {
                const envExtApi = await getEnvExtApi();
                const allProjects = envExtApi.getPythonProjects();
                expectedConnections = allProjects.length > 0 ? allProjects.length : 1;
                traceInfo(
                    `Expecting ${expectedConnections} discovery connections for ${expectedConnections} Python projects`,
                );
            } catch (error) {
                traceVerbose(`Could not get project count, defaulting to 1 connection: ${error}`);
                expectedConnections = 1;
            }
        }

        const name = await startDiscoveryNamedPipe(
            (data: DiscoveredTestPayload) => {
                // if the token is cancelled, we don't want process the data
                if (!token?.isCancellationRequested) {
                    this.resultResolver?.resolveDiscovery(data);
                }
            },
            cSource.token,
            expectedConnections,
        );

        this.runPytestDiscovery(uri, name, cSource, executionFactory, interpreter, token).then(() => {
            deferredReturn.resolve();
        });

        return deferredReturn.promise;
    }

    async runPytestDiscovery(
        uri: Uri,
        discoveryPipeName: string,
        cSource: CancellationTokenSource,
        executionFactory: IPythonExecutionFactory,
        interpreter?: PythonEnvironment,
        token?: CancellationToken,
    ): Promise<void> {
        const relativePathToPytest = 'python_files';
        const fullPluginPath = path.join(EXTENSION_ROOT_DIR, relativePathToPytest);
        const settings = this.configSettings.getSettings(uri);
        let { pytestArgs } = settings.testing;
        const cwd = settings.testing.cwd && settings.testing.cwd.length > 0 ? settings.testing.cwd : uri.fsPath;

        // check for symbolic path
        const stats = await fs.promises.lstat(cwd);
        const resolvedPath = await fs.promises.realpath(cwd);
        let isSymbolicLink = false;
        if (stats.isSymbolicLink()) {
            isSymbolicLink = true;
            traceWarn('The cwd is a symbolic link.');
        } else if (resolvedPath !== cwd) {
            traceWarn(
                'The cwd resolves to a different path, checking if it has a symbolic link somewhere in its path.',
            );
            isSymbolicLink = await hasSymlinkParent(cwd);
        }
        if (isSymbolicLink) {
            traceWarn("Symlink found, adding '--rootdir' to pytestArgs only if it doesn't already exist. cwd: ", cwd);
            pytestArgs = addValueIfKeyNotExist(pytestArgs, '--rootdir', cwd);
        }
        // if user has provided `--rootdir` then use that, otherwise add `cwd`
        // root dir is required so pytest can find the relative paths and for symlinks
        addValueIfKeyNotExist(pytestArgs, '--rootdir', cwd);

        // get and edit env vars
        const mutableEnv = {
            ...(await this.envVarsService?.getEnvironmentVariables(uri)),
        };
        // get python path from mutable env, it contains process.env as well
        const pythonPathParts: string[] = mutableEnv.PYTHONPATH?.split(path.delimiter) ?? [];
        const pythonPathCommand = [fullPluginPath, ...pythonPathParts].join(path.delimiter);
        mutableEnv.PYTHONPATH = pythonPathCommand;
        mutableEnv.TEST_RUN_PIPE = discoveryPipeName;
        traceInfo(
            `Environment variables set for pytest discovery: PYTHONPATH=${mutableEnv.PYTHONPATH}, TEST_RUN_PIPE=${mutableEnv.TEST_RUN_PIPE}`,
        );

        // delete UUID following entire discovery finishing.
        let execArgs = ['-m', 'pytest', '-p', 'vscode_pytest', '--collect-only'].concat(pytestArgs);
        traceVerbose(`Running pytest discovery with command: ${execArgs.join(' ')} for workspace ${uri.fsPath}.`);

        // Check if we should use the Python environments extension for multi-project discovery
        if (useEnvExtension()) {
            // Get the Python environment for the current workspace URI
            const pythonEnv = await getEnvironment(uri);

            if (pythonEnv) {
                execArgs = execArgs.slice(2);
                // === MULTI-PROJECT DISCOVERY IMPLEMENTATION ===
                // This section implements discovery across all Python projects detected by the
                // Python environments extension, rather than just the current workspace folder.
                // This ensures we find tests in all related Python projects, not just the main one.

                // Get the API to access all Python projects from the environments extension
                const envExtApi = await getEnvExtApi();
                const allProjects = envExtApi.getPythonProjects();

                traceInfo(`Found ${allProjects.length} Python projects for multi-project discovery`);

                // Create a set to track processed project paths to avoid running discovery
                // multiple times on the same directory (deduplication requirement)
                const processedProjects = new Set<string>();
                const discoveryPromises: Promise<void>[] = [];

                // Iterate through each Python project and run discovery for valid ones sequentially
                // Sequential execution prevents payload interleaving on the shared named pipe
                for (const project of allProjects) {
                    const projectUri = project.uri;
                    const projectPath = projectUri.fsPath;

                    // Skip duplicates: if we've already processed this path, don't do it again
                    // This handles cases where the same directory might be registered as multiple projects
                    if (processedProjects.has(projectPath)) {
                        traceVerbose(`Skipping duplicate project path: ${projectPath}`);
                        continue;
                    }
                    processedProjects.add(projectPath);

                    // Verify the project directory actually exists on disk before attempting discovery
                    try {
                        const projectStats = await fs.promises.stat(projectPath);
                        if (projectStats.isDirectory()) {
                            traceInfo(`Running pytest discovery for project: ${project.name} at ${projectPath}`);

                            // Set the current project path in the result resolver
                            this.resultResolver?.setCurrentProjectPath(projectPath);

                            // Run discovery for this specific project sequentially
                            // Each discovery completes before the next one starts, ensuring clean pipe communication
                            await this.runSingleProjectDiscovery(
                                projectUri,
                                discoveryPipeName,
                                cSource,
                                token,
                                pythonEnv,
                                execArgs,
                                mutableEnv,
                                cwd,
                            );
                            discoveryPromises.push(Promise.resolve());
                        }
                    } catch (error) {
                        // Project directory doesn't exist on disk, skip it gracefully
                        traceWarn(`Project directory ${projectPath} does not exist, skipping discovery.`);
                    }
                }

                // Fallback: If no valid projects were found, run discovery on the original URI
                // This ensures we always run discovery somewhere, even if project detection fails
                if (discoveryPromises.length === 0) {
                    traceWarn('No valid Python projects found, falling back to original URI discovery');
                    await this.runSingleProjectDiscovery(
                        uri,
                        discoveryPipeName,
                        cSource,
                        token,
                        pythonEnv,
                        execArgs,
                        mutableEnv,
                        cwd,
                    );
                }

                // Signal the result resolver that all projects have finished discovering
                this.resultResolver?.setCurrentProjectPath(undefined);
                this.resultResolver?.endDiscovery();
                return;
            } else {
                traceError(`Python Environment not found for: ${uri.fsPath}`);
                return;
            }
            return;
        }

        const spawnOptions: SpawnOptions = {
            cwd,
            throwOnStdErr: true,
            env: mutableEnv,
            token,
        };

        // Create the Python environment in which to execute the command.
        const creationOptions: ExecutionFactoryCreateWithEnvironmentOptions = {
            allowEnvironmentFetchExceptions: false,
            resource: uri,
            interpreter,
        };
        const execService = await executionFactory.createActivatedEnvironment(creationOptions);

        const execInfo = await execService?.getExecutablePath();
        traceVerbose(`Executable path for pytest discovery: ${execInfo}.`);

        const deferredTillExecClose: Deferred<void> = createTestingDeferred();

        let resultProc: ChildProcess | undefined;

        token?.onCancellationRequested(() => {
            traceInfo(`Test discovery cancelled, killing pytest subprocess for workspace ${uri.fsPath}`);
            // if the resultProc exists just call kill on it which will handle resolving the ExecClose deferred, otherwise resolve the deferred here.
            if (resultProc) {
                resultProc?.kill();
            } else {
                deferredTillExecClose.resolve();
                cSource.cancel();
            }
        });
        const result = execService?.execObservable(execArgs, spawnOptions);
        resultProc = result?.proc;

        // Take all output from the subprocess and add it to the test output channel. This will be the pytest output.
        // Displays output to user and ensure the subprocess doesn't run into buffer overflow.

        result?.proc?.stdout?.on('data', (data) => {
            const out = fixLogLinesNoTrailing(data.toString());
            traceInfo(out);
        });
        result?.proc?.stderr?.on('data', (data) => {
            const out = fixLogLinesNoTrailing(data.toString());
            traceError(out);
        });
        result?.proc?.on('exit', (code, signal) => {
            if (code !== 0) {
                traceError(
                    `Subprocess exited unsuccessfully with exit code ${code} and signal ${signal} on workspace ${uri.fsPath}.`,
                );
            }
        });
        result?.proc?.on('close', (code, signal) => {
            // pytest exits with code of 5 when 0 tests are found- this is not a failure for discovery.
            if (code !== 0 && code !== 5) {
                traceError(
                    `Subprocess exited unsuccessfully with exit code ${code} and signal ${signal} on workspace ${uri.fsPath}. Creating and sending error discovery payload`,
                );
                this.resultResolver?.resolveDiscovery(createDiscoveryErrorPayload(code, signal, cwd));
            }
            // due to the sync reading of the output.
            deferredTillExecClose?.resolve();
        });
        await deferredTillExecClose.promise;
    }

    /**
     * Runs pytest discovery for a single Python project using the Python environments extension.
     *
     * This method handles the execution of pytest discovery for one specific project directory.
     * It sets up the appropriate working directory, environment variables, and executes pytest
     * with the '--collect-only' flag to discover tests without running them.
     *
     * @param projectUri - The URI of the project directory to run discovery in
     * @param discoveryPipeName - Named pipe for receiving discovery results
     * @param cSource - Cancellation token source for handling cancellation
     * @param executionFactory - Factory for creating Python execution services (unused in env extension mode)
     * @param interpreter - Python interpreter info (unused in env extension mode)
     * @param token - Cancellation token for cancelling the operation
     * @param pythonEnv - Python environment from the environments extension
     * @param execArgs - Arguments to pass to pytest (includes --collect-only and user args)
     * @param mutableEnv - Environment variables for the discovery process
     */
    private async runSingleProjectDiscovery(
        projectUri: Uri,
        discoveryPipeName: string,
        cSource: CancellationTokenSource,
        token?: CancellationToken,
        pythonEnv?: EnvExtPythonEnvironment,
        execArgs?: string[],
        mutableEnv?: { [key: string]: string | undefined },
        workspaceCwd?: string,
    ): Promise<void> {
        // Use workspace-level cwd for discovery to ensure relative paths in pytest args are resolved correctly
        // All projects discover from the same root directory
        const projectCwd = workspaceCwd || '/';

        // Clone the shared environment variables and customize for this specific project
        // Each project gets its own copy to avoid interference between concurrent discoveries
        const projectEnv = { ...mutableEnv };
        projectEnv.TEST_RUN_PIPE = discoveryPipeName; // Named pipe for this discovery session

        // Create a deferred promise to track when this discovery process completes
        const deferredTillExecClose: Deferred<void> = createTestingDeferred();

        // Register this promise with the result resolver so it can signal when discovery is done for this project
        const projectKey = projectUri.fsPath;
        this.resultResolver?.setDiscoveryPromise(projectKey, deferredTillExecClose);

        traceVerbose(
            `Running pytest discovery for project: ${projectUri.fsPath} with command: ${execArgs?.join(' ')}.`,
        );

        const finalArgs = ['-m', 'pytest', projectUri.fsPath, ...execArgs!];

        // DEBUG: Log the environment and command details
        traceInfo(`[DEBUG] Project discovery for: ${projectUri.fsPath}`);
        traceInfo(`[DEBUG] Project discovery command args: ${JSON.stringify(finalArgs)}`);
        traceInfo(`[DEBUG] Project discovery env vars - TEST_RUN_PIPE: ${projectEnv.TEST_RUN_PIPE}`);
        traceInfo(`[DEBUG] Project discovery env vars - PYTHONPATH: ${projectEnv.PYTHONPATH}`);
        traceInfo(`[DEBUG] Project discovery WORKSPACE cwd (used for all projects): ${projectCwd}`);

        // Execute pytest in the background using the Python environments extension
        // This runs: python -m pytest -p vscode_pytest --collect-only [user_args]
        const proc = await runInBackground(pythonEnv!, {
            cwd: projectCwd, // Working directory for this project
            args: finalArgs, // pytest arguments including --collect-only
            env: (projectEnv as unknown) as { [key: string]: string }, // Environment variables
        });

        // Set up cancellation handling: if the user cancels discovery, kill this project's process
        token?.onCancellationRequested(() => {
            traceInfo(`Test discovery cancelled, killing pytest subprocess for project ${projectUri.fsPath}`);
            proc.kill(); // Terminate the pytest process
            deferredTillExecClose.reject(new Error('Discovery cancelled'));
            cSource.cancel(); // Cancel the overall discovery operation
        });

        // Monitor stdout: pytest outputs test collection information here
        // This output is logged for debugging but the actual test data comes through the named pipe
        proc.stdout.on('data', (data) => {
            const out = fixLogLinesNoTrailing(data.toString());
            traceInfo(out); // Log pytest's stdout for debugging
        });

        // Monitor stderr: pytest outputs errors and warnings here
        proc.stderr.on('data', (data) => {
            const out = fixLogLinesNoTrailing(data.toString());
            traceError(out); // Log pytest's stderr for debugging
        });

        // Handle process completion: check exit code and send error payload if needed
        proc.onExit((code, signal) => {
            if (code !== 0) {
                traceError(
                    `Subprocess exited unsuccessfully with exit code ${code} and signal ${signal} on project ${projectUri.fsPath}`,
                );
                // Send error information back to VS Code's test explorer
                this.resultResolver?.resolveDiscovery(createDiscoveryErrorPayload(code, signal, projectCwd));
            }
            // Mark this project's discovery as complete (success or failure)
            deferredTillExecClose.resolve();
        });

        await deferredTillExecClose.promise;
    }
}
