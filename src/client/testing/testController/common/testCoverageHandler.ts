// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import {
    Uri,
    TestRun,
    TestCoverageCount,
    FileCoverage,
    FileCoverageDetail,
    StatementCoverage,
    Range,
} from 'vscode';
import { CoveragePayload, FileCoverageMetrics } from './types';

/**
 * TestCoverageHandler - Stateless processor for coverage payloads.
 *
 * This handler processes coverage payloads and creates coverage objects.
 * It is designed to be stateless and shared across all workspaces.
 *
 * Responsibilities:
 * - Parse CoveragePayload and create FileCoverage objects
 * - Generate detailed coverage information (line-level coverage)
 * - Return coverage data for caller to store/use
 *
 * The handler returns coverage data rather than storing it, allowing
 * the caller (resolver or adapter) to decide how to manage this data.
 */
export class TestCoverageHandler {
    /**
     * Process coverage payload and update test run with coverage data.
     * This is the main entry point for handling coverage results.
     *
     * @param payload - The coverage payload from the Python subprocess
     * @param runInstance - VS Code TestRun to add coverage to
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

            // Create file coverage and detailed coverage
            const { fileCoverage, detailedCoverageArray } = this.processFileCoverage(
                fileNameStr,
                fileCoverageMetrics,
            );

            // Add coverage to the test run
            runInstance.addCoverage(fileCoverage);

            // Store detailed coverage for the file
            detailedCoverageMap.set(fileCoverage.uri.fsPath, detailedCoverageArray);
        }

        return detailedCoverageMap;
    }

    /**
     * Process coverage for a single file.
     *
     * @param fileNameStr - Path to the file
     * @param metrics - Coverage metrics for the file
     * @returns Object containing FileCoverage and detailed coverage array
     */
    private processFileCoverage(
        fileNameStr: string,
        metrics: FileCoverageMetrics,
    ): { fileCoverage: FileCoverage; detailedCoverageArray: FileCoverageDetail[] } {
        // Handle undefined arrays (use empty arrays as defaults)
        const linesCovered = metrics.lines_covered ?? [];
        const linesMissed = metrics.lines_missed ?? [];
        const executedBranches = metrics.executed_branches;
        const totalBranches = metrics.total_branches;

        // Create line coverage count
        const lineCoverageCount = new TestCoverageCount(linesCovered.length, linesCovered.length + linesMissed.length);

        // Create FileCoverage object
        const uri = Uri.file(fileNameStr);
        let fileCoverage: FileCoverage;

        if (totalBranches === -1) {
            // Branch coverage was not enabled and should not be displayed
            fileCoverage = new FileCoverage(uri, lineCoverageCount);
        } else {
            const branchCoverageCount = new TestCoverageCount(executedBranches, totalBranches);
            fileCoverage = new FileCoverage(uri, lineCoverageCount, branchCoverageCount);
        }

        // Create detailed coverage array for line-level coverage (not branch level)
        const detailedCoverageArray = this.createDetailedCoverage(linesCovered, linesMissed);

        return { fileCoverage, detailedCoverageArray };
    }

    /**
     * Create detailed coverage array for a file.
     * This generates StatementCoverage objects for each covered and missed line.
     *
     * @param linesCovered - Array of 1-indexed line numbers that were covered
     * @param linesMissed - Array of 1-indexed line numbers that were not covered
     * @returns Array of FileCoverageDetail (StatementCoverage) objects
     */
    private createDetailedCoverage(linesCovered: number[], linesMissed: number[]): FileCoverageDetail[] {
        const detailedCoverageArray: FileCoverageDetail[] = [];

        // Process covered lines
        for (const line of linesCovered) {
            // Line is 1-indexed, so we need to subtract 1 to get the 0-indexed line number
            // true value means line is covered
            const statementCoverage = new StatementCoverage(
                true,
                new Range(line - 1, 0, line - 1, Number.MAX_SAFE_INTEGER),
            );
            detailedCoverageArray.push(statementCoverage);
        }

        // Process missed lines
        for (const line of linesMissed) {
            // Line is 1-indexed, so we need to subtract 1 to get the 0-indexed line number
            // false value means line is NOT covered
            const statementCoverage = new StatementCoverage(
                false,
                new Range(line - 1, 0, line - 1, Number.MAX_SAFE_INTEGER),
            );
            detailedCoverageArray.push(statementCoverage);
        }

        return detailedCoverageArray;
    }

    /**
     * Create FileCoverage object from metrics.
     * This is a convenience method that can be used by callers who need
     * to create FileCoverage objects outside of the main processing flow.
     *
     * @param uri - URI of the file
     * @param metrics - Coverage metrics for the file
     * @returns FileCoverage object
     */
    public createFileCoverage(uri: Uri, metrics: FileCoverageMetrics): FileCoverage {
        const linesCovered = metrics.lines_covered ?? [];
        const linesMissed = metrics.lines_missed ?? [];
        const executedBranches = metrics.executed_branches;
        const totalBranches = metrics.total_branches;

        const lineCoverageCount = new TestCoverageCount(linesCovered.length, linesCovered.length + linesMissed.length);

        if (totalBranches === -1) {
            return new FileCoverage(uri, lineCoverageCount);
        } else {
            const branchCoverageCount = new TestCoverageCount(executedBranches, totalBranches);
            return new FileCoverage(uri, lineCoverageCount, branchCoverageCount);
        }
    }
}
