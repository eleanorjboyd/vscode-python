// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as util from 'util';
import { CancellationToken, MarkdownString, TestController, TestItem, Uri } from 'vscode';
import { DiscoveredTestPayload, ITestResultResolver } from './types';
import { TestProvider } from '../../types';
import { traceError } from '../../../logging';
import { Testing } from '../../../common/utils/localize';
import { createErrorTestItem } from './testItemUtilities';
import { sendTelemetryEvent } from '../../../telemetry';
import { EventName } from '../../../telemetry/constants';
import { buildErrorNodeOptions, populateTestTree } from './utils';
import { TestItemIndex } from './testItemIndex';

/**
 * TestDiscoveryHandler processes discovery payloads and builds/updates the TestItem tree.
 *
 * This class is STATELESS - it has no instance variables that persist between calls.
 * All state is passed as parameters or stored in the caller (resolver or index).
 *
 * Ownership: One shared instance created at the module/service level, reused by all resolvers/adapters.
 *
 * Responsibilities:
 * - Parse DiscoveredTestPayload and create/update TestItems
 * - Call TestItemIndex.registerTestItem() for each discovered test (via populateTestTree)
 * - Handle discovery errors and create error nodes
 * - Populate test tree structure
 */
export class TestDiscoveryHandler {
    /**
     * Process discovery payload and update test tree.
     * Pure function - no instance state used.
     *
     * @param payload The discovery payload from the Python test discovery
     * @param testController The VS Code TestController to update
     * @param testItemIndex The index to register test items in
     * @param workspaceUri The workspace URI for this discovery
     * @param testProvider The test provider type ('pytest' or 'unittest')
     * @param resultResolver The result resolver (for backward compatibility with populateTestTree)
     * @param token Optional cancellation token
     */
    public processDiscovery(
        payload: DiscoveredTestPayload,
        testController: TestController,
        testItemIndex: TestItemIndex,
        workspaceUri: Uri,
        testProvider: TestProvider,
        resultResolver: ITestResultResolver,
        token?: CancellationToken,
    ): void {
        if (!payload) {
            return;
        }

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

            // Clear existing mappings before rebuilding test tree
            testItemIndex.clear();

            // Populate the test tree using the shared utility function.
            // The populateTestTree function accesses resultResolver.runIdToTestItem etc.
            // which now delegate to testItemIndex, so the mappings are properly registered.
            if (payload.tests) {
                populateTestTree(testController, payload.tests, undefined, resultResolver, token);
            }
        }

        sendTelemetryEvent(EventName.UNITTEST_DISCOVERY_DONE, undefined, {
            tool: testProvider,
            failed: false,
        });
    }

    /**
     * Handle discovery errors by creating and displaying an error node.
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
     *
     * @param testController The TestController to create the error item in
     * @param workspaceUri The workspace URI
     * @param message The error message to display
     * @param testProvider The test provider type
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
        return errorNode;
    }
}
