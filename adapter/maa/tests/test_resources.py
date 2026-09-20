import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from resources import manifest, resource_roots, verify_material


class ResourceTest(unittest.TestCase):
    def test_platform_roots_and_content_fingerprint(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "resource").mkdir()
            index = root / "resource/item_index.json"
            index.write_text(json.dumps({"30012": {"name": "fixture"}}))
            pc = root / "resource/platform_diff/PC"
            (pc / "resource").mkdir(parents=True)
            (root / "cache/resource").mkdir(parents=True)
            self.assertNotIn(pc, resource_roots(root, "mumu"))
            self.assertIn(pc, resource_roots(root, "desktop"))
            before = manifest(root, "mumu")
            verify_material(root, "mumu", {"kind": "fight_material", "item_id": "30012"})
            with self.assertRaises(ValueError):
                verify_material(root, "mumu", {"kind": "fight_material", "item_id": "missing"})
            index.write_text(json.dumps({"30012": {"name": "changed"}}))
            self.assertNotEqual(before["sha256"], manifest(root, "mumu")["sha256"])


if __name__ == "__main__":
    unittest.main()
