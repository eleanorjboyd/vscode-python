// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import {
    FileCoverage,
    FileCoverageDetail,
    Range,
    StatementCoverage,
    TestCoverageCount,
    TestRun,
    Uri,
} from 'vscode';
import { CoveragePayload, FileCoverageMetrics } from './types';

/**
 * TestCoverageHandler processes coverage payloads and creates coverage objects.
 *
 * This is a stateless handler that can be shared across all workspaces.
 *
 * Responsibilities:
 * - Parse CoveragePayload and create FileCoverage objects
 * - Generate detailed coverage information
 * - Return coverage data for caller to store/use
 */
export class TestCoverageHandler {
    /**
     * Process coverage payload.
     * Pure function - returns coverage data without storing it.
     *
     * @param payload Coverage payload from Python subprocess
     * @param runInstance VS Code TestRun instance
     * @returns Map of file path to detailed coverage information
     */
    processCoverage(payload: CoveragePayload, runInstance: TestRun): Map<string, FileCoverageDetail[]> {
        const detailedCoverageMap = new Map<string, FileCoverageDetail[]>();

        if (payload.result === undefined) {
            return detailedCoverageMap;
        }

        for (const [key, value] of Object.entries(payload.result)) {
            const fileNameStr = key;
            const fileCoverageMetrics: FileCoverageMetrics = value;
            const linesCovered = fileCoverageMetrics.lines_covered ? fileCoverageMetrics.lines_covered : []; // undefined if no lines covered
            const linesMissed = fileCoverageMetrics.lines_missed ? fileCoverageMetrics.lines_missed : []; // undefined if no lines missed
            const executedBranches = fileCoverageMetrics.executed_branches;
            const totalBranches = fileCoverageMetrics.total_branches;

            // Create FileCoverage and add to run instance
            const uri = Uri.file(fileNameStr);
            const fileCoverage = this.createFileCoverage(
                uri,
                linesCovered,
                linesMissed,
                executedBranches,
                totalBranches,
            );
            runInstance.addCoverage(fileCoverage);

            // Create detailed coverage array for this file
            const detailedCoverageArray = this.createDetailedCoverage(linesCovered, linesMissed);
            detailedCoverageMap.set(uri.fsPath, detailedCoverageArray);
        }

        return detailedCoverageMap;
    }

    /**
     * Create FileCoverage object from metrics.
     *
     * @param uri File URI
     * @param linesCovered Array of covered line numbers
     * @param linesMissed Array of missed line numbers
     * @param executedBranches Number of executed branches
     * @param totalBranches Total number of branches (-1 if branch coverage disabled)
     * @returns FileCoverage object
     */
    private createFileCoverage(
        uri: Uri,
        linesCovered: number[],
        linesMissed: number[],
        executedBranches: number,
        totalBranches: number,
    ): FileCoverage {
        const lineCoverageCount = new TestCoverageCount(linesCovered.length, linesCovered.length + linesMissed.length);

        if (totalBranches === -1) {
            // branch coverage was not enabled and should not be displayed
            return new FileCoverage(uri, lineCoverageCount);
        }
        const branchCoverageCount = new TestCoverageCount(executedBranches, totalBranches);
        return new FileCoverage(uri, lineCoverageCount, branchCoverageCount);
    }

    /**
     * Create detailed coverage array for a file.
     *
     * @param linesCovered Array of covered line numbers
     * @param linesMissed Array of missed line numbers
     * @returns Array of FileCoverageDetail objects
     */
    private createDetailedCoverage(linesCovered: number[], linesMissed: number[]): FileCoverageDetail[] {
        const detailedCoverageArray: FileCoverageDetail[] = [];

        // Go through all covered lines, create new StatementCoverage, and add to array
        for (const line of linesCovered) {
            // line is 1-indexed, so we need to subtract 1 to get the 0-indexed line number
            // true value means line is covered
            const statementCoverage = new StatementCoverage(
                true,
                new Range(line - 1, 0, line - 1, Number.MAX_SAFE_INTEGER),
            );
            detailedCoverageArray.push(statementCoverage);
        }

        // Go through all missed lines
        for (const line of linesMissed) {
            // line is 1-indexed, so we need to subtract 1 to get the 0-indexed line number
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
