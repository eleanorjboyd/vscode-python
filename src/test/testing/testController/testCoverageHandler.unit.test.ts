// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { TestRun, CancellationToken } from 'vscode';
import * as typemoq from 'typemoq';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { CoveragePayload } from '../../../client/testing/testController/common/types';
import { TestCoverageHandler } from '../../../client/testing/testController/common/testCoverageHandler';

suite('TestCoverageHandler tests', () => {
    let coverageHandler: TestCoverageHandler;
    let runInstance: typemoq.IMock<TestRun>;
    let cancelationToken: CancellationToken;

    setup(() => {
        coverageHandler = new TestCoverageHandler();

        cancelationToken = ({
            isCancellationRequested: false,
        } as unknown) as CancellationToken;

        // define functions within runInstance
        runInstance = typemoq.Mock.ofType<TestRun>();
        runInstance.setup((r) => r.name).returns(() => 'name');
        runInstance.setup((r) => r.token).returns(() => cancelationToken);
        runInstance.setup((r) => r.isPersisted).returns(() => true);
        runInstance.setup((r) => r.addCoverage(typemoq.It.isAny())).returns(() => undefined);
    });

    teardown(() => {
        sinon.restore();
    });

    suite('processCoverage', () => {
        test('returns empty map when payload has no result', async () => {
            const payload: CoveragePayload = {
                coverage: true,
                cwd: '/foo/bar',
                result: undefined,
                error: '',
            };

            const result = coverageHandler.processCoverage(payload, runInstance.object);

            assert.strictEqual(result.size, 0);
            runInstance.verify((r) => r.addCoverage(typemoq.It.isAny()), typemoq.Times.never());
        });

        test('returns empty map when payload result is empty object', async () => {
            const payload: CoveragePayload = {
                coverage: true,
                cwd: '/foo/bar',
                result: {},
                error: '',
            };

            const result = coverageHandler.processCoverage(payload, runInstance.object);

            assert.strictEqual(result.size, 0);
            runInstance.verify((r) => r.addCoverage(typemoq.It.isAny()), typemoq.Times.never());
        });

        // Note: Tests that require actual VS Code coverage APIs (TestCoverageCount, FileCoverage, etc.)
        // are tested via integration tests since the unit test mock doesn't provide these classes.
        // The coverage handler processes CoveragePayload correctly when these APIs are available.
    });
});
