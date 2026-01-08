// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import { Uri } from 'vscode';
import * as workspaceApis from '../../../../client/common/vscodeApis/workspaceApis';
import {
    findProjectRoots,
    isFileInProject,
    findProjectForTestItem,
    ProjectRoot,
} from '../../../../client/testing/testController/common/projectRootFinder';

suite('Project Root Finder Tests', () => {
    let findFilesStub: sinon.SinonStub;

    setup(() => {
        findFilesStub = sinon.stub(workspaceApis, 'findFiles');
    });

    teardown(() => {
        sinon.restore();
    });

    suite('findProjectRoots', () => {
        test('should return workspace root when no project markers found', async () => {
            const workspaceUri = Uri.file('/workspace');
            findFilesStub.resolves([]);

            const result = await findProjectRoots(workspaceUri, 'pytest');

            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].uri.fsPath, workspaceUri.fsPath);
            assert.strictEqual(result[0].markerFile, 'none');
        });

        test('should detect single pytest project with pytest.ini', async () => {
            const workspaceUri = Uri.file('/workspace');
            const projectMarker = Uri.file('/workspace/pytest.ini');
            
            let callCount = 0;
            findFilesStub.callsFake(() => {
                // Return marker on first call (pytest.ini), empty on others
                if (callCount++ === 0) {
                    return Promise.resolve([projectMarker]);
                }
                return Promise.resolve([]);
            });

            const result = await findProjectRoots(workspaceUri, 'pytest');

            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].uri.fsPath, workspaceUri.fsPath);
            assert.strictEqual(result[0].markerFile, 'pytest.ini');
        });

        test('should detect multiple projects with different markers', async () => {
            const workspaceUri = Uri.file('/workspace');
            const project1Marker = Uri.file('/workspace/project1/pyproject.toml');
            const project2Marker = Uri.file('/workspace/project2/setup.py');
            
            findFilesStub.callsFake((pattern: any) => {
                const patternStr = pattern.pattern || pattern;
                if (typeof patternStr === 'string' && patternStr.includes('pyproject.toml')) {
                    return Promise.resolve([project1Marker]);
                } else if (typeof patternStr === 'string' && patternStr.includes('setup.py')) {
                    return Promise.resolve([project2Marker]);
                }
                return Promise.resolve([]);
            });

            const result = await findProjectRoots(workspaceUri, 'pytest');

            assert.strictEqual(result.length, 2);
            const paths = result.map(p => p.uri.fsPath).sort();
            assert.strictEqual(paths[0], path.join(workspaceUri.fsPath, 'project1'));
            assert.strictEqual(paths[1], path.join(workspaceUri.fsPath, 'project2'));
        });

        test('should filter out nested projects', async () => {
            const workspaceUri = Uri.file('/workspace');
            const parentMarker = Uri.file('/workspace/pyproject.toml');
            const nestedMarker = Uri.file('/workspace/subproject/pyproject.toml');
            
            findFilesStub.callsFake((pattern: any) => {
                const patternStr = pattern.pattern || pattern;
                if (typeof patternStr === 'string' && patternStr.includes('pyproject.toml')) {
                    return Promise.resolve([parentMarker, nestedMarker]);
                }
                return Promise.resolve([]);
            });

            const result = await findProjectRoots(workspaceUri, 'pytest');

            // Should only return the parent project, filtering out nested one
            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].uri.fsPath, workspaceUri.fsPath);
            assert.strictEqual(result[0].markerFile, 'pyproject.toml');
        });

        test('should use unittest markers for unittest provider', async () => {
            const workspaceUri = Uri.file('/workspace');
            const projectMarker = Uri.file('/workspace/setup.py');
            
            findFilesStub.callsFake((pattern: any) => {
                const patternStr = pattern.pattern || pattern;
                if (typeof patternStr === 'string' && patternStr.includes('setup.py')) {
                    return Promise.resolve([projectMarker]);
                }
                return Promise.resolve([]);
            });

            const result = await findProjectRoots(workspaceUri, 'unittest');

            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].markerFile, 'setup.py');
        });
    });

    suite('isFileInProject', () => {
        test('should return true for file in project root', () => {
            const projectRoot: ProjectRoot = {
                uri: Uri.file('/workspace/project1'),
                markerFile: 'pyproject.toml',
            };
            const filePath = path.join('/workspace', 'project1', 'test_file.py');

            const result = isFileInProject(filePath, projectRoot);

            assert.strictEqual(result, true);
        });

        test('should return true for file in subdirectory of project', () => {
            const projectRoot: ProjectRoot = {
                uri: Uri.file('/workspace/project1'),
                markerFile: 'pyproject.toml',
            };
            const filePath = path.join('/workspace', 'project1', 'subdir', 'test_file.py');

            const result = isFileInProject(filePath, projectRoot);

            assert.strictEqual(result, true);
        });

        test('should return false for file outside project', () => {
            const projectRoot: ProjectRoot = {
                uri: Uri.file('/workspace/project1'),
                markerFile: 'pyproject.toml',
            };
            const filePath = path.join('/workspace', 'project2', 'test_file.py');

            const result = isFileInProject(filePath, projectRoot);

            assert.strictEqual(result, false);
        });

        test('should return true for exact project root path', () => {
            const projectRoot: ProjectRoot = {
                uri: Uri.file('/workspace/project1'),
                markerFile: 'pyproject.toml',
            };
            const filePath = '/workspace/project1';

            const result = isFileInProject(filePath, projectRoot);

            assert.strictEqual(result, true);
        });
    });

    suite('findProjectForTestItem', () => {
        test('should find correct project for test item', () => {
            const projects: ProjectRoot[] = [
                { uri: Uri.file('/workspace/project1'), markerFile: 'pyproject.toml' },
                { uri: Uri.file('/workspace/project2'), markerFile: 'setup.py' },
            ];
            const testItemUri = Uri.file('/workspace/project1/tests/test_foo.py');

            const result = findProjectForTestItem(testItemUri, projects);

            assert.ok(result);
            assert.strictEqual(result.uri.fsPath, projects[0].uri.fsPath);
        });

        test('should return deepest matching project for nested structure', () => {
            const projects: ProjectRoot[] = [
                { uri: Uri.file('/workspace'), markerFile: 'pyproject.toml' },
                { uri: Uri.file('/workspace/subproject'), markerFile: 'pyproject.toml' },
            ];
            const testItemUri = Uri.file('/workspace/subproject/tests/test_foo.py');

            const result = findProjectForTestItem(testItemUri, projects);

            assert.ok(result);
            assert.strictEqual(result.uri.fsPath, projects[1].uri.fsPath);
        });

        test('should return undefined when no matching project found', () => {
            const projects: ProjectRoot[] = [
                { uri: Uri.file('/workspace/project1'), markerFile: 'pyproject.toml' },
            ];
            const testItemUri = Uri.file('/different/workspace/test_foo.py');

            const result = findProjectForTestItem(testItemUri, projects);

            assert.strictEqual(result, undefined);
        });
    });
});
