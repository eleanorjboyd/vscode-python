import json
import os
import pathlib
import sys
from typing import Dict, List, Literal, Optional, Tuple, Union

import pytest
from _pytest.doctest import DoctestItem
from testing_tools import socket_manager

DEFAULT_PORT = "45454"
script_dir = pathlib.Path(__file__).parent.parent
sys.path.append(os.fspath(script_dir))
sys.path.append(os.fspath(script_dir / "lib" / "python"))

from testing_tools import socket_manager


class TestData(Dict):
    name: str
    path: str
    type_: Literal["class", "file", "folder", "test", "doc_file"]
    id_: str


class TestItem(TestData):
    lineno: str
    runID: str


class TestNode(TestData):
    """
    A general class that handles all test data which contains children.
    """

    children: "List[Union[TestNode, TestItem]]"

# for pytest the outcome for a test is only 'passed', 'skipped' or 'failed'
class TestOutcome(Dict):
    """
    A class that handles outcome for a single test.
    """
    test: str
    outcome: Literal["success", "failure", "skipped"]
    message: str
    duration: float
    traceback: str

def create_test_outcome(
    test: str,
    outcome: str,
    message: str,
    duration: float,
    traceback: str,
) -> TestOutcome:
    """
    A function that creates a TestOutcome object.
    """
    return TestOutcome(
        test=test,
        outcome=outcome,
        message=message,
        duration=duration,
        traceback=traceback,
    )

class testRunResultDict(Dict):
    """
    A class that stores all test run results.
    """
    outcome: str
    tests: TestOutcome

collected_tests = testRunResultDict()
def pytest_report_teststatus(report, config):
    """
     A pytest hook that is called when a test is called. It is called 3 times per test,
       during setup, call, and teardown.

     Keyword arguments:
     report -- the report on the test setup, call, and teardown.
     config -- configuration object.
     """
    if report.when == 'call':
        report_value = "skipped"
        if report.passed:
            report_value = "success"
        elif report.failed:
            report_value = "failure"
        item_result = create_test_outcome(report.nodeid, report_value, report.longreprtext, report.duration, "traceback")
        collected_tests[report.nodeid] = item_result

def pytest_sessionfinish(session, exitstatus):
    """
     A pytest hook that is called after pytest has fulled finished.

     Keyword arguments:
     session -- the pytest session object.
     exitstatus -- the status code of the session.
     """
    cwd = os.getcwd()
    # TODO: add error checking.
    if exitstatus == 0:
        # This occurs when only collection is done.
        session_node: Union[TestNode, None] = build_test_tree(session)[0]
        if session_node:
            discovery_post(os.fsdecode(cwd), session_node)
    if exitstatus != 0:
        execution_post(cwd, exitstatus.name, collected_tests)

def build_test_tree(session) -> Tuple[Union[TestNode, None], List[str]]:
    """
    Builds a tree made up of testing nodes from the pytest session.

    Keyword arguments:
    session -- the pytest session object.
    """
    errors: List[str] = []
    session_node = create_session_node(session)
    session_children_dict: Dict[str, TestNode] = {}
    file_nodes_dict: Dict[pytest.Module, TestNode] = {}
    class_nodes_dict: Dict[str, TestNode] = {}

    for test_case in session.items:
        test_node = create_test_node(test_case)
        if isinstance(test_case, DoctestItem):
            if test_case.parent and isinstance(test_case.parent, pytest.Module):
                try:
                    parent_test_case = file_nodes_dict[test_case.parent]
                except KeyError:
                    parent_test_case = create_doc_file_node(test_case.parent)
                    file_nodes_dict[test_case.parent] = parent_test_case
                parent_test_case["children"].append(test_node)
        elif isinstance(test_case.parent, pytest.Module):
            try:
                parent_test_case = file_nodes_dict[test_case.parent]
            except KeyError:
                parent_test_case = create_file_node(test_case.parent)
                file_nodes_dict[test_case.parent] = parent_test_case
            parent_test_case["children"].append(test_node)
        else:  # should be a pytest.Class
            try:
                test_class_node = class_nodes_dict[test_case.parent.name]
            except KeyError:
                test_class_node = create_class_node(test_case.parent)
                class_nodes_dict[test_case.parent.name] = test_class_node
            test_class_node["children"].append(test_node)
            parent_module: pytest.Module = test_case.parent.parent
            # Create a file node that has the class as a child.
            try:
                test_file_node = file_nodes_dict[parent_module]
            except KeyError:
                test_file_node = create_file_node(parent_module)
                file_nodes_dict[parent_module] = test_file_node
            test_file_node["children"].append(test_class_node)
            # Check if the class is already a child of the file node.
            if test_class_node not in test_file_node["children"]:
                test_file_node["children"].append(test_class_node)
    created_files_folders_dict: Dict[str, TestNode] = {}
    for file_module, file_node in file_nodes_dict.items():
        # Iterate through all the files that exist and construct them into nested folders.
        root_folder_node: TestNode = build_nested_folders(
            file_module, file_node, created_files_folders_dict, session
        )
        # The final folder we get to is the highest folder in the path and therefore we add this as a child to the session.
        root_id = root_folder_node.get("id_")
        if root_id and root_id not in session_children_dict:
            session_children_dict[root_id] = root_folder_node
    session_node["children"] = list(session_children_dict.values())
    return session_node, errors


def build_nested_folders(
    file_module: pytest.Module,
    file_node: TestNode,
    created_files_folders_dict: Dict[str, TestNode],
    session: pytest.Session,
) -> TestNode:
    """
    Takes a file or folder and builds the nested folder structure for it.

    Keyword arguments:
    file_module -- the created module for the file we  are nesting.
    file_node -- the file node that we are building the nested folders for.
    created_files_folders_dict -- Dictionary of all the folders and files that have been created.
    session -- the pytest session object.
    """
    prev_folder_node = file_node

    # Begin the i_path iteration one level above the current file.
    iterator_path = file_module.path.parent
    while iterator_path != session.path:
        curr_folder_name = iterator_path.name
        try:
            curr_folder_node = created_files_folders_dict[curr_folder_name]
        except KeyError:
            curr_folder_node = create_folder_node(curr_folder_name, iterator_path)
            created_files_folders_dict[curr_folder_name] = curr_folder_node
        if prev_folder_node not in curr_folder_node["children"]:
            curr_folder_node["children"].append(prev_folder_node)
        iterator_path = iterator_path.parent
        prev_folder_node = curr_folder_node
    return prev_folder_node


def create_test_node(
    test_case: pytest.Item,
) -> TestItem:
    """
    Creates a test node from a pytest test case.

    Keyword arguments:
    test_case -- the pytest test case.
    """
    test_case_loc: str = (
        "" if test_case.location[1] is None else str(test_case.location[1] + 1)
    )
    return TestItem(
        {
            "name": test_case.name,
            "path": os.fsdecode(test_case.path),
            "lineno": test_case_loc,
            "type_": "test",
            "id_": test_case.nodeid,
            "runID": test_case.nodeid,
        }
    )


def create_session_node(session: pytest.Session) -> TestNode:
    """
    Creates a session node from a pytest session.

    Keyword arguments:
    session -- the pytest session.
    """
    return TestNode(
        {
            "name": session.name,
            "path": os.fsdecode(session.path),
            "type_": "folder",
            "children": [],
            "id_": str(session.path),
        }
    )


def create_class_node(class_module: pytest.Class) -> TestNode:
    """
    Creates a class node from a pytest class object.

    Keyword arguments:
    class_module -- the pytest object representing a class module.
    """
    return TestNode(
        {
            "name": class_module.name,
            "path": os.fsdecode(class_module.path),
            "type_": "class",
            "children": [],
            "id_": class_module.nodeid,
        }
    )


def create_file_node(file_module: pytest.Module) -> TestNode:
    """
    Creates a file node from a pytest file module.

    Keyword arguments:
    file_module -- the pytest file module.
    """
    return TestNode(
        {
            "name": file_module.path.name,
            "path": os.fsdecode(file_module.path),
            "type_": "file",
            "id_": str(file_module.path),
            "children": [],
        }
    )


def create_doc_file_node(file_module: pytest.Module) -> TestNode:
    """
    Creates a doc file node from a pytest doc test file module.

    Keyword arguments:
    file_module -- the module for the doc test file.
    """
    return TestNode(
        {
            "name": file_module.path.name,
            "path": os.fsdecode(file_module.path),
            "type_": "doc_file",
            "id_": str(file_module.path),
            "children": [],
        }
    )


def create_folder_node(folderName: str, path_iterator: pathlib.Path) -> TestNode:
    """
    Creates a folder node from a pytest folder name and its path.

    Keyword arguments:
    folderName -- the name of the folder.
    path_iterator -- the path of the folder.
    """
    return TestNode(
        {
            "name": folderName,
            "path": os.fsdecode(path_iterator),
            "type_": "folder",
            "id_": str(path_iterator),
            "children": [],
        }
    )


class DiscoveryPayloadDict(Dict):
    """
    A dictionary that is used to send a discovery post request to the server.
    """
    cwd: str
    status: Literal["success", "error"]
    tests: Optional[TestNode]
    errors: Optional[List[str]]

class ExecutionPayloadDict(Dict):
    """
    A dictionary that is used to send a execution post request to the server.
    """
    cwd: str
    status: Literal["success", "error"]
    result: Dict[str, Dict[str, str | None]]
    not_found: Optional[List[str]] #Currently unused need to check
    error: Optional[str] #Currently unused need to check

def execution_post(cwd, status, tests):
    """
    Sends a post request to the server after the tests have been executed.

    Keyword arguments:
    cwd -- the current working directory.
    session_node -- the status of running the tests
    tests -- the tests that were run and their status.
    """
    testPort = os.getenv("TEST_PORT", 45454)
    testuuid = os.getenv("TEST_UUID")
    payload: ExecutionPayloadDict = {"cwd": cwd, "status": status, "result": tests}
    addr = ("localhost", int(testPort))
    data = json.dumps(payload)
    request = f"""POST / HTTP/1.1
Host: localhost:{testPort}
Content-Length: {len(data)}
Content-Type: application/json
Request-uuid: {testuuid}

{data}"""
    with socket_manager.SocketManager(addr) as s:
        if s.socket is not None:
            s.socket.sendall(request.encode("utf-8"))  # type: ignore


def discovery_post(cwd: str, session_node: TestNode) -> None:
    """
    Sends a post request to the server following a discovery session.

    Keyword arguments:
    cwd -- the current working directory.
    session_node -- the session node, which is the top of the testing tree.
    """
    payload = DiscoveryPayloadDict({"cwd": "cwd", "status": "success", "tests": session_node})
    testPort: Union[str, int] = os.getenv("TEST_PORT", 45454)
    testuuid: Union[str, None] = os.getenv("TEST_UUID")
    addr = "localhost", int(testPort)
    data = json.dumps(payload)
    request = f"""POST / HTTP/1.1
Host: localhost:{testPort}
Content-Length: {len(data)}
Content-Type: application/json
Request-uuid: {testuuid}

{data}"""
    with socket_manager.SocketManager(addr) as s:
        if s.socket is not None:
            s.socket.sendall(request.encode("utf-8"))  # type: ignore