import subprocess
import os
import sys
from typing import Union

from pythonFiles.unittestadapter.execution import VSCodeUnittestError

def setup_django_env(start_dir: Union[str, None]):
    """Configures the Django environment to run Django tests.

    If Django is not installed or if manage.py can not be found, the function fails quietly.

    Args:
        start_dir (str): The root directory of the Django project.

    Returns:
        boolean: either succeeded or failed.
    """

    # To avoid false positive ModuleNotFoundError from django.setup() due to missing current workspace in sys.path
    sys.path.insert(0, os.getcwd())

    try:
        import django
    except ImportError:
        return False

    # Get path to manage.py if set as an env var, otherwise use the default
    manage_py_path = os.environ.get("MANAGE_PY_PATH")

    if manage_py_path is None:
        # Search for default manage.py path at the root of the workspace
        if not start_dir:
            print(
                "Error running Django, no start_dir provided or value for MANAGE_PY_PATH"
            )

        cwd = os.path.abspath(start_dir)
        manage_py_path = os.path.join(cwd, "manage.py")

    django_settings_module = os.environ.get("DJANGO_SETTINGS_MODULE", None)

    if django_settings_module is None:
        print("Warning running Django, missing django settings module in environment, reading from manage.py")

        import re
        try:
            with open(manage_py_path, "r") as f:
                manage_py_module = f.readlines()
        except FileNotFoundError:
            print("Error running Django, manage.py not found")
            return False

        pattern = r"^os\.environ\.setdefault\((\'|\")DJANGO_SETTINGS_MODULE(\'|\"), (\'|\")(?P<settings_path>[\w.]+)(\'|\")\)$"
        for line in manage_py_module:
            matched = re.match(pattern, line.strip())
            if matched is not None:
                django_settings_module = matched.groupdict().get("settings_path", None)
                break

    if django_settings_module is None:
        print("Error running Django, django settings module not found")
        return False

    os.environ.setdefault("DJANGO_SETTINGS_MODULE", django_settings_module)

    try:
        django.setup()
    except ModuleNotFoundError:
        print("Error running Django, Drat!")
        return False

    return True

def django_execution_runner(start_dir: Union[str, None]):

    _ = setup_django_env(start_dir)

    try:
        # Get path to the custom_test_runner.py parent folder, add to sys.path.

        # TODO: Check backward compatibility https://docs.python.org/3/library/pathlib.html -> New in version 3.4.
        # import pathlib
        # custom_test_runner_dir = pathlib.Path(__file__).parent
        # sys.path.insert(0, custom_test_runner_dir)

        sys.path.insert(
            0,
            os.path.dirname(  # pythonFiles/unittestadapter
                    os.path.abspath(__file__)  # this file
                )
        )
        custom_test_runner = "django_test_runner.CustomTestRunner"

        # Build command to run 'python manage.py test'.
        python_executable = sys.executable
        command = [
            python_executable,
            "manage.py",
            "test",
            "--testrunner",
            custom_test_runner,
        ]
        print("Running Django run tests with command: ", command)
        try:
            subprocess.run(" ".join(command), shell=True, check=True)
        except subprocess.CalledProcessError as e:
            print(f"Error running 'manage.py test': {e}")
            raise VSCodeUnittestError(f"Error running 'manage.py test': {e}")
    except Exception as e:
        print(f"Error configuring Django test runner: {e}")
        raise VSCodeUnittestError(f"Error configuring Django test runner: {e}")
