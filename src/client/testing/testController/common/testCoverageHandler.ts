// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { FileCoverage, FileCoverageDetail, Range, StatementCoverage, TestCoverageCount, TestRun, Uri } from 'vscode';
import { CoveragePayload, FileCoverageMetrics } from './types';

/**
 * TestCoverageHandler processes coverage payloads and builds FileCoverage objects.
 *
 * This class is STATELESS - it has no instance variables that persist between calls.
 * All state is returned to the caller to manage.
 *
 * Ownership: One shared instance created at the module/service level, reused by all resolvers/adapters.
 *
 * Responsibilities:
 * - Parse CoveragePayload and create FileCoverage objects
 * - Build detailed coverage arrays (per-line coverage status)
 * - Return coverage data for caller to store
 */
export class TestCoverageHandler {
    /**
     * Process coverage payload and update test run with coverage data.
     * Pure function - no instance state used.
     * Returns detailed coverage map for caller to store.
     *
     * @param payload The coverage payload from the Python test run
     * @param runInstance The VS Code TestRun to add coverage to
     * @returns Map of file paths to detailed coverage information
     */
    public processCoverage(payload: CoveragePayload, runInstance: TestRun): Map<string, FileCoverageDetail[]> {
        const detailedCoverageMap = new Map<string, FileCoverageDetail[]>();

        if (payload.result === undefined) {
            return detailedCoverageMap;
        }

        for (const [key, value] of Object.entries(payload.result)) {
            const fileNameStr = key;
            const fileCoverageMetrics: FileCoverageMetrics = value;

            // Process and add file coverage to test run
            const fileCoverage = this.createFileCoverage(fileNameStr, fileCoverageMetrics);
            runInstance.addCoverage(fileCoverage);

            // Build detailed coverage array for this file
            const detailedCoverageArray = this.createDetailedCoverage(fileCoverageMetrics);
            detailedCoverageMap.set(Uri.file(fileNameStr).fsPath, detailedCoverageArray);
        }

        return detailedCoverageMap;
    }

    /**
     * Create a FileCoverage object from coverage metrics.
     */
    private createFileCoverage(fileName: string, metrics: FileCoverageMetrics): FileCoverage {
        const linesCovered = metrics.lines_covered ?? [];
        const linesMissed = metrics.lines_missed ?? [];
        const executedBranches = metrics.executed_branches;
        const totalBranches = metrics.total_branches;

        const lineCoverageCount = new TestCoverageCount(linesCovered.length, linesCovered.length + linesMissed.length);

        const uri = Uri.file(fileName);

        if (totalBranches === -1) {
            // Branch coverage was not enabled and should not be displayed
            return new FileCoverage(uri, lineCoverageCount);
        } else {
            const branchCoverageCount = new TestCoverageCount(executedBranches, totalBranches);
            return new FileCoverage(uri, lineCoverageCount, branchCoverageCount);
        }
    }

    /**
     * Create detailed coverage array (per-line coverage status) for a file.
     * Only includes line coverage, not branch coverage.
     */
    private createDetailedCoverage(metrics: FileCoverageMetrics): FileCoverageDetail[] {
        const detailedCoverageArray: FileCoverageDetail[] = [];
        const linesCovered = metrics.lines_covered ?? [];
        const linesMissed = metrics.lines_missed ?? [];

        // Process covered lines
        for (const line of linesCovered) {
            // Line is 1-indexed from Python, convert to 0-indexed for VS Code
            // true value means line is covered
            const statementCoverage = new StatementCoverage(
                true,
                new Range(line - 1, 0, line - 1, Number.MAX_SAFE_INTEGER),
            );
            detailedCoverageArray.push(statementCoverage);
        }

        // Process missed lines
        for (const line of linesMissed) {
            // Line is 1-indexed from Python, convert to 0-indexed for VS Code
            // false value means line is NOT covered
            const statementCoverage = new StatementCoverage(
                false,
                new Range(line - 1, 0, line - 1, Number.MAX_SAFE_INTEGER),
            );
            detailedCoverageArray.push(statementCoverage);
        }

        return detailedCoverageArray;
    }
}
