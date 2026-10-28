"""Kleine black-box-test met een tijdelijke Claude-logfixture; geen echte sessies lezen."""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).with_name("sessie-samenvatting.py")


class SessieSamenvattingTest(unittest.TestCase):
    def test_zoek_en_samenvat_op_tijdelijke_fixture(self):
        with tempfile.TemporaryDirectory() as tijdelijke_home:
            log = pathlib.Path(tijdelijke_home) / ".claude/projects/lab-proef/sessie-123.jsonl"
            log.parent.mkdir(parents=True)
            regels = [
                {"type": "custom-title", "customTitle": "Kleine proef"},
                {"type": "assistant", "timestamp": "2026-10-28T09:00:00Z", "message": {"id": "m1", "model": "test", "usage": {"input_tokens": 3, "output_tokens": 5}, "content": []}},
            ]
            log.write_text("".join(json.dumps(r) + "\n" for r in regels))
            env = {**os.environ, "HOME": tijdelijke_home}
            zoek = subprocess.run([sys.executable, str(SCRIPT), "zoek", "--project", "lab-proef"], env=env, text=True, capture_output=True, check=True)
            self.assertIn("sessie-123", zoek.stdout)
            samenvat = subprocess.run([sys.executable, str(SCRIPT), "samenvat", str(log), "--geen-subagents"], env=env, text=True, capture_output=True, check=True)
            self.assertIn("# sessie sessie-123", samenvat.stdout)
            self.assertIn("beurten 1", samenvat.stdout)


if __name__ == "__main__": unittest.main()
