import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from zipfile import ZipFile

from import_arkarys import ARCHIVE_ROOT, ROOT, TRACKS, prepare


class ArkarysImportTests(unittest.TestCase):
    def make_archive(self, path, *, changed_track=False):
        config = {"tracks": {}}
        for name, (count, folder, _) in TRACKS.items():
            config["tracks"][name] = {
                "levels": count + int(changed_track and name == "logic"),
                "src": f"../assets/tutorials/{folder}/index.html",
            }
        catalog = f'<script type="application/json" id="tut-config">{json.dumps(config)}</script>'
        translations = {
            "label": {"learn": "What you'll learn"},
            "courses": {
                track: {"title": f"Fixture {track}", "learn": r"Fixture: \'quoted'", "story": "Fixture"}
                for track in TRACKS
            },
        }
        locales = json.loads((ROOT / "data/i18n/locales.json").read_text(encoding="utf-8"))
        with ZipFile(path, "w") as archive:
            archive.writestr(f"{ARCHIVE_ROOT}tutorials/index.html", catalog)
            for locale in locales:
                archive.writestr(f'{ARCHIVE_ROOT}source/i18n/{locale["code"]}.json', json.dumps(translations))
            for folder in {folder for _, folder, _ in TRACKS.values()}:
                archive.writestr(f"{ARCHIVE_ROOT}assets/tutorials/{folder}/index.html", "PRIVATE_EXERCISE_SENTINEL")
                archive.writestr(f"{ARCHIVE_ROOT}assets/tutorials/{folder}/engine.js", "PRIVATE_SCRIPT_SENTINEL")
            archive.writestr("../../ZIP_TRAVERSAL_SENTINEL", "This is never extracted.")

    def test_outputs_only_preview_copy_and_stable_private_mapping(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "source.zip"
            self.make_archive(archive)
            self.assertEqual(prepare(archive, root / "first"), 19)
            self.assertEqual(prepare(archive, root / "second"), 19)

            outputs = ("arkarys-preview-seed.sql", "arkarys-workshop-map.json")
            self.assertEqual(sorted(path.name for path in (root / "first").iterdir()), sorted(outputs))
            for name in outputs:
                content = (root / "first" / name).read_bytes()
                self.assertEqual(content, (root / "second" / name).read_bytes())
                self.assertNotIn(b"SENTINEL", content)
            self.assertFalse((root / "ZIP_TRAVERSAL_SENTINEL").exists())

            seed = (root / "first" / outputs[0]).read_text(encoding="utf-8")
            self.assertIn("What you''ll learn", seed)
            self.assertIn(r"Fixture: \\''quoted''", seed)
            self.assertIn("(E'arkarys-logic', E'preview', 1,", seed)
            self.assertIn("'public', statement_timestamp()", seed)
            self.assertNotIn("'level-01'", seed)
            self.assertIn("on conflict (course_id, id) do nothing", seed)

            with (root / "first" / outputs[1]).open(encoding="utf-8") as file:
                mapping = json.load(file)
            self.assertEqual(len(mapping["courses"]), 8)
            self.assertEqual(sum(len(course["private_lessons"]) for course in mapping["courses"]), 111)
            logic = next(course for course in mapping["courses"] if course["legacy_track"] == "logic")
            self.assertEqual(logic["legacy_v1_compatible_levels"], 5)
            self.assertEqual(logic["private_lessons"][0], {"id": "level-01", "legacy_level": 1, "position": 2})
            self.assertEqual(logic["private_lessons"][-1], {"id": "level-50", "legacy_level": 50, "position": 51})

    def test_rejects_changed_level_map_without_writing_output(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "source.zip"
            self.make_archive(archive, changed_track=True)
            with self.assertRaisesRegex(ValueError, "Level count changed"):
                prepare(archive, root / "generated")
            self.assertFalse((root / "generated").exists())

    def test_preserves_existing_outputs_and_rejects_checkout_paths(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "source.zip"
            with self.assertRaisesRegex(ValueError, "outside the Git checkout"):
                prepare(archive, ROOT / "untracked-import")
            with self.assertRaisesRegex(ValueError, "already exists"):
                prepare(archive, root)


if __name__ == "__main__":
    unittest.main()
