"""Run dependency-free JavaScript behavior tests from the standard test command."""
from pathlib import Path
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


class CarouselRuntimeTests(unittest.TestCase):
    def test_carousel_behavior(self):
        node = shutil.which('node')
        if node is None:
            self.skipTest('Node.js 18+ is required for carousel runtime checks')
        result = subprocess.run([node, '--test', 'tests/carousels.test.cjs'],
                                cwd=ROOT, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
