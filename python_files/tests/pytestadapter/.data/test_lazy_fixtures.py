# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

import pytest
from packaging import version

# Parse the pytest version.
pytest_version = version.parse(pytest.__version__)

# Check if the pytest version is compatible with the following tests we are trying to run.
# Must use this method instead of pytest skip since evaluating fixtures throws error in pytest < 7.4.4.
compatible = pytest_version <= version.parse("7.4.4")

if compatible:
    from pytest_lazyfixture import lazy_fixture


    @pytest.fixture
    def fixture_a():
        return "a"


    @pytest.fixture
    def fixture_b():
        return "b"


    @pytest.fixture
    def fixture_c():
        return "c"


    class TestA:
        @pytest.fixture(
            scope="class",
            params=[lazy_fixture("fixture_a"), lazy_fixture("fixture_b")],
        )
        def fixt(self, request):
            return request.param

        def test_a(self, fixt): # test_marker--TestA::test_a
            assert fixt in ["a", "b"]


    class TestB:
        @pytest.fixture(
            scope="class",
            params=[lazy_fixture("fixture_a"), lazy_fixture("fixture_c")],
        )
        def fixt(self, request):
            return request.param

        def test_a(self, fixt): # test_marker--TestB::test_a
            assert fixt in ["a", "c"]


