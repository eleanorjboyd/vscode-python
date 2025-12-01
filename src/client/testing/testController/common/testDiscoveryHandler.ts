// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { CancellationToken, MarkdownString, TestController, TestItem, Uri } from 'vscode';
import * as util from 'util';
import { DiscoveredTestPayload, ITestResultResolver } from './types';
import { TestProvider } from '../../types';
import { traceError } from '../../../logging';
import { Testing } from '../../../common/utils/localize';
import { createErrorTestItem } from './testItemUtilities';
import { sendTelemetryEvent } from '../../../telemetry';
import { EventName } from '../../../telemetry/constants';
import { buildErrorNodeOptions, populateTestTree } from './utils';

/**
 * TestDiscoveryHandler - Stateless processor for test discovery payloads.
 *
 * This handler processes discovery payloads and builds/updates the TestItem tree.
 * It is designed to be stateless and shared across all workspaces.
 *
 * Responsibilities:
 * - Parse DiscoveredTestPayload and create/update TestItems
 * - Handle discovery errors and create error nodes
 * - Populate test tree structure
 * - Send telemetry events for discovery completion
 *
 * The handler calls resultResolver methods to register test items in the index
 * as it builds the tree, maintaining the bridge between discovery and the
 * persistent state needed for execution.
 */
export class TestDiscoveryHandler {
    /**
     * Process discovery payload and update test tree.
     * This is the main entry point for handling discovery results.
     *
     * @param payload - The discovery payload from the Python subprocess
     * @param testController - VS Code TestController to update
     * @param resultResolver - Result resolver for registering test items (provides index access)
     * @param workspaceUri - URI of the workspace being discovered
     * @param testProvider - Test framework provider ('pytest' or 'unittest')
     * @param token - Optional cancellation token
     */
    public processDiscovery(
        payload: DiscoveredTestPayload,
        testController: TestController,
        resultResolver: ITestResultResolver,
        workspaceUri: Uri,
        testProvider: TestProvider,
        token?: CancellationToken,
    ): void {
        const workspacePath = workspaceUri.fsPath;

        // Check if there were any errors in the discovery process.
        if (payload.status === 'error') {
            this.handleDiscoveryError(payload, testController, workspaceUri, workspacePath, testProvider);
        } else {
            // Remove error node only if no errors exist.
            testController.items.delete(`DiscoveryError:${workspacePath}`);
        }

        if (payload.tests || payload.tests === null) {
            // If any tests exist, they should be populated in the test tree,
            // regardless of whether there were errors or not.
            // Parse and insert test data.

            // Clear existing mappings before rebuilding test tree
            // The maps are accessed via resultResolver's getters which delegate to TestItemIndex
            resultResolver.runIdToTestItem.clear();
            resultResolver.runIdToVSid.clear();
            resultResolver.vsIdToRunId.clear();

            // If the test root for this folder exists: Workspace refresh, update its children.
            // Otherwise, it is a freshly discovered workspace, and we need to create a new test root
            // and populate the test tree.
            populateTestTree(testController, payload.tests, undefined, resultResolver, token);
        }

        sendTelemetryEvent(EventName.UNITTEST_DISCOVERY_DONE, undefined, {
            tool: testProvider,
            failed: false,
        });
    }

    /**
     * Handle discovery errors by creating or updating error nodes in the test tree.
     *
     * @param payload - The discovery payload containing error information
     * @param testController - VS Code TestController to update
     * @param workspaceUri - URI of the workspace
     * @param workspacePath - File system path of the workspace
     * @param testProvider - Test framework provider
     */
    private handleDiscoveryError(
        payload: DiscoveredTestPayload,
        testController: TestController,
        workspaceUri: Uri,
        workspacePath: string,
        testProvider: TestProvider,
    ): void {
        const testingErrorConst =
            testProvider === 'pytest' ? Testing.errorPytestDiscovery : Testing.errorUnittestDiscovery;
        const { error } = payload;
        traceError(testingErrorConst, 'for workspace: ', workspacePath, '\r\n', error?.join('\r\n\r\n') ?? '');

        let errorNode = testController.items.get(`DiscoveryError:${workspacePath}`);
        const message = util.format(
            `${testingErrorConst} ${Testing.seePythonOutput}\r\n`,
            error?.join('\r\n\r\n') ?? '',
        );

        if (errorNode === undefined) {
            const options = buildErrorNodeOptions(workspaceUri, message, testProvider);
            errorNode = createErrorTestItem(testController, options);
            testController.items.add(errorNode);
        }

        const errorNodeLabel: MarkdownString = new MarkdownString(
            `[Show output](command:python.viewOutput) to view error logs`,
        );
        errorNodeLabel.isTrusted = true;
        errorNode.error = errorNodeLabel;
    }

    /**
     * Create an error node for discovery failures.
     * This is a convenience method that can be used by callers who need
     * to create error nodes outside of the main discovery flow.
     *
     * @param testController - VS Code TestController to create the item in
     * @param workspaceUri - URI of the workspace
     * @param message - Error message to display
     * @param testProvider - Test framework provider
     * @returns The created error TestItem
     */
    public createErrorNode(
        testController: TestController,
        workspaceUri: Uri,
        message: string,
        testProvider: TestProvider,
    ): TestItem {
        const options = buildErrorNodeOptions(workspaceUri, message, testProvider);
        const errorNode = createErrorTestItem(testController, options);
        testController.items.add(errorNode);

        const errorNodeLabel: MarkdownString = new MarkdownString(
            `[Show output](command:python.viewOutput) to view error logs`,
        );
        errorNodeLabel.isTrusted = true;
        errorNode.error = errorNodeLabel;

        return errorNode;
    }
}
