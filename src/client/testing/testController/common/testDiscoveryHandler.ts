// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { CancellationToken, MarkdownString, TestController, TestItem, Uri } from 'vscode';
import * as util from 'util';
import { DiscoveredTestPayload, ITestIdMaps } from './types';
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
 * This is a stateless handler that can be shared across all workspaces.
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
     * @param payload Discovery payload from Python subprocess
     * @param testController VS Code TestController
     * @param testItemIndex TestItemIndex for storing ID mappings
     * @param workspaceUri Workspace URI
     * @param testProvider Test provider (pytest or unittest)
     * @param token Optional cancellation token
     */
    processDiscovery(
        payload: DiscoveredTestPayload,
        testController: TestController,
        testItemIndex: TestItemIndex,
        workspaceUri: Uri,
        testProvider: TestProvider,
        token?: CancellationToken,
    ): void {
        const workspacePath = workspaceUri.fsPath;
        const rawTestData = payload;

        // Check if there were any errors in the discovery process.
        if (rawTestData.status === 'error') {
            const testingErrorConst =
                testProvider === 'pytest' ? Testing.errorPytestDiscovery : Testing.errorUnittestDiscovery;
            const { error } = rawTestData;
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
        } else {
            // remove error node only if no errors exist.
            testController.items.delete(`DiscoveryError:${workspacePath}`);
        }

        if (rawTestData.tests || rawTestData.tests === null) {
            // if any tests exist, they should be populated in the test tree, regardless of whether there were errors or not.
            // parse and insert test data.

            // Clear existing mappings before rebuilding test tree
            testItemIndex.clear();

            // If the test root for this folder exists: Workspace refresh, update its children.
            // Otherwise, it is a freshly discovered workspace, and we need to create a new test root and populate the test tree.
            // Note: populateTestTree uses a result resolver interface that includes maps for backward compatibility.
            // We pass a shim that wraps the testItemIndex to maintain compatibility.
            const resultResolverShim = this.createResultResolverShim(testItemIndex);
            populateTestTree(testController, rawTestData.tests, undefined, resultResolverShim, token);
        }

        sendTelemetryEvent(EventName.UNITTEST_DISCOVERY_DONE, undefined, {
            tool: testProvider,
            failed: false,
        });
    }

    /**
     * Create an error node for discovery failures.
     *
     * @param testController VS Code TestController
     * @param workspaceUri Workspace URI
     * @param message Error message
     * @param testProvider Test provider (pytest or unittest)
     * @returns Created error TestItem
     */
    createErrorNode(
        testController: TestController,
        workspaceUri: Uri,
        message: string,
        testProvider: TestProvider,
    ): TestItem {
        const options = buildErrorNodeOptions(workspaceUri, message, testProvider);
        return createErrorTestItem(testController, options);
    }

    /**
     * Creates a shim object that implements the ITestIdMaps interface
     * for use with populateTestTree.
     *
     * @param testItemIndex TestItemIndex to wrap
     * @returns Object with runIdToTestItem, runIdToVSid, vsIdToRunId maps
     */
    private createResultResolverShim(testItemIndex: TestItemIndex): ITestIdMaps {
        return {
            runIdToTestItem: testItemIndex.runIdToTestItem,
            runIdToVSid: testItemIndex.runIdToVSid,
            vsIdToRunId: testItemIndex.vsIdToRunId,
        };
    }
}
