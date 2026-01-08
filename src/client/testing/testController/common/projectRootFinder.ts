// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as path from 'path';
import { Uri, RelativePattern } from 'vscode';
import { traceVerbose } from '../../../logging';
import { TestProvider } from '../../types';
import * as workspaceApis from '../../../common/vscodeApis/workspaceApis';

/**
 * Markers that indicate a Python project root for different test frameworks
 */
const PYTEST_PROJECT_MARKERS = ['pytest.ini', 'pyproject.toml', 'setup.py', 'setup.cfg', 'tox.ini'];
const UNITTEST_PROJECT_MARKERS = ['pyproject.toml', 'setup.py', 'setup.cfg'];

/**
 * Represents a detected Python project within a workspace
 */
export interface ProjectRoot {
    /**
     * URI of the project root directory
     */
    uri: Uri;
    
    /**
     * Marker file that was used to identify this project
     */
    markerFile: string;
}

/**
 * Finds all Python project roots within a workspace folder.
 * A project root is identified by the presence of configuration files like
 * pyproject.toml, setup.py, pytest.ini, etc.
 * 
 * @param workspaceUri The workspace folder URI to search
 * @param testProvider The test provider (pytest or unittest) to determine which markers to look for
 * @returns Array of detected project roots, or a single element with the workspace root if no projects found
 */
export async function findProjectRoots(workspaceUri: Uri, testProvider: TestProvider): Promise<ProjectRoot[]> {
    const markers = testProvider === 'pytest' ? PYTEST_PROJECT_MARKERS : UNITTEST_PROJECT_MARKERS;
    const projectRoots: Map<string, ProjectRoot> = new Map();
    
    traceVerbose(`Searching for ${testProvider} project roots in workspace: ${workspaceUri.fsPath}`);
    
    // Search for each marker file type
    for (const marker of markers) {
        try {
            // Use VS Code's findFiles API to search for marker files
            // Exclude common directories to improve performance
            const pattern = `**/${marker}`;
            const exclude = '**/node_modules/**,**/.venv/**,**/venv/**,**/__pycache__/**,**/.git/**';
            const foundFiles = await workspaceApis.findFiles(
                new RelativePattern(workspaceUri, pattern),
                exclude,
                100, // Limit to 100 projects max
            );
            
            for (const fileUri of foundFiles) {
                // The project root is the directory containing the marker file
                const projectRootPath = path.dirname(fileUri.fsPath);
                
                // Only add if we haven't already found a project at this location
                if (!projectRoots.has(projectRootPath)) {
                    projectRoots.set(projectRootPath, {
                        uri: Uri.file(projectRootPath),
                        markerFile: marker,
                    });
                    traceVerbose(`Found ${testProvider} project root at ${projectRootPath} (marker: ${marker})`);
                }
            }
        } catch (error) {
            traceVerbose(`Error searching for ${marker}: ${error}`);
        }
    }
    
    // If no projects found, treat the entire workspace as a single project
    if (projectRoots.size === 0) {
        traceVerbose(`No project markers found, using workspace root as single project: ${workspaceUri.fsPath}`);
        return [{
            uri: workspaceUri,
            markerFile: 'none',
        }];
    }
    
    // Sort projects by path depth (shallowest first) to handle nested projects
    const sortedProjects = Array.from(projectRoots.values()).sort((a, b) => {
        const depthA = a.uri.fsPath.split(path.sep).length;
        const depthB = b.uri.fsPath.split(path.sep).length;
        return depthA - depthB;
    });
    
    // Filter out nested projects (projects contained within other projects)
    const filteredProjects = sortedProjects.filter((project, index) => {
        // Keep the project if no earlier project contains it
        for (let i = 0; i < index; i++) {
            const parentProject = sortedProjects[i];
            if (project.uri.fsPath.startsWith(parentProject.uri.fsPath + path.sep)) {
                traceVerbose(`Filtering out nested project at ${project.uri.fsPath} (contained in ${parentProject.uri.fsPath})`);
                return false;
            }
        }
        return true;
    });
    
    traceVerbose(`Found ${filteredProjects.length} ${testProvider} project(s) in workspace ${workspaceUri.fsPath}`);
    return filteredProjects;
}

/**
 * Checks if a file path belongs to a specific project root
 * @param filePath The file path to check
 * @param projectRoot The project root to check against
 * @returns true if the file belongs to the project
 */
export function isFileInProject(filePath: string, projectRoot: ProjectRoot): boolean {
    const normalizedFilePath = path.normalize(filePath);
    const normalizedProjectPath = path.normalize(projectRoot.uri.fsPath);
    
    return normalizedFilePath === normalizedProjectPath || 
           normalizedFilePath.startsWith(normalizedProjectPath + path.sep);
}

/**
 * Finds which project root a test item belongs to based on its URI
 * @param testItemUri The URI of the test item
 * @param projectRoots Array of project roots to search
 * @returns The matching project root, or undefined if not found
 */
export function findProjectForTestItem(testItemUri: Uri, projectRoots: ProjectRoot[]): ProjectRoot | undefined {
    // Find the most specific (deepest) project root that contains this test
    const matchingProjects = projectRoots
        .filter(project => isFileInProject(testItemUri.fsPath, project))
        .sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length); // Sort by path length descending
    
    return matchingProjects[0];
}
