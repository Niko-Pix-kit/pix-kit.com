"""Prepare private deployment inputs from the original Arkarys review ZIP."""

import argparse
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import tempfile
from zipfile import BadZipFile, ZipFile


ROOT = Path(__file__).resolve().parents[2]
ARCHIVE_ROOT = "PixKit-Arkarys/"
TRACKS = {
    "logic": (50, "route", 5),
    "makeblock": (12, "blocks", 0),
    "python": (12, "coding", 0),
    "web": (12, "coding", 0),
    "java": (3, "advanced", 3),
    "android": (5, "advanced", 5),
    "c": (5, "advanced", 5),
    "cpp": (12, "advanced", 0),
}
MAX_INPUT_BYTES = 512 * 1024


class CatalogConfig(HTMLParser):
    """Collect the embedded configuration without executing workshop scripts."""

    def __init__(self):
        super().__init__()
        self.configs = []
        self.current = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "script" and attrs.get("id") == "tut-config" and attrs.get("type") == "application/json":
            self.current = []

    def handle_data(self, data):
        if self.current is not None:
            self.current.append(data)

    def handle_endtag(self, tag):
        if tag == "script" and self.current is not None:
            self.configs.append("".join(self.current))
            self.current = None


def member(archive, path):
    name = ARCHIVE_ROOT + path
    matches = [entry for entry in archive.infolist() if entry.filename == name]
    if len(matches) != 1 or matches[0].is_dir():
        raise ValueError(f"Expected exactly one source file at {path}")
    return matches[0]


def source_text(archive, path):
    entry = member(archive, path)
    if entry.file_size > MAX_INPUT_BYTES:
        raise ValueError(f"Source file exceeds the allowed size at {path}")
    return archive.read(entry).decode("utf-8")


def text_field(source, key, limit):
    value = source[key]
    if not isinstance(value, str):
        raise ValueError(f"Expected source text for {key}")
    value = value.strip()
    if not value or len(value) > limit or "\x00" in value:
        raise ValueError(f"Source text length is invalid for {key}")
    return value


def read_source(archive, locales):
    parser = CatalogConfig()
    parser.feed(source_text(archive, "tutorials/index.html"))
    parser.close()
    if len(parser.configs) != 1 or parser.current is not None:
        raise ValueError("Expected one complete catalog configuration")

    tracks = json.loads(parser.configs[0])["tracks"]
    if set(tracks) != TRACKS.keys():
        raise ValueError("Track IDs differ from the supported Arkarys revision")
    for track, (count, folder, _) in TRACKS.items():
        workshop = f"assets/tutorials/{folder}/index.html"
        if type(tracks[track]["levels"]) is not int or tracks[track]["levels"] != count:
            raise ValueError(f"Level count changed for {track}. Review stable IDs before importing.")
        if tracks[track]["src"] not in (f"../{workshop}", f"/{workshop}"):
            raise ValueError(f"Workshop location changed for {track}")
        member(archive, workshop)

    rows = []
    for locale in locales:
        translations = json.loads(source_text(archive, f"source/i18n/{locale}.json"))
        preview_title = text_field(translations["label"], "learn", 160)
        for track in TRACKS:
            course = translations["courses"][track]
            title = text_field(course, "title", 160)
            description = text_field(course, "learn", 4000)
            story = text_field(course, "story", 4000)
            rows.append((locale, f"arkarys-{track}", title, description, preview_title, f"{story}\n\n{description}"))
    return rows


def sql_literal(value):
    if isinstance(value, int):
        return str(value)
    return "E'" + value.replace("\\", "\\\\").replace("'", "''") + "'"


def insert(table, columns, rows, conflict, *, publish=False):
    if publish:
        columns += ("published_at",)
    values = []
    for row in rows:
        fields = [sql_literal(value) for value in row]
        if publish:
            fields.append("statement_timestamp()")
        values.append(f"    ({', '.join(fields)})")
    return (
        f"insert into pixkit_private.{table} ({', '.join(columns)}) values\n"
        + ",\n".join(values)
        + f"\non conflict ({', '.join(conflict)}) do nothing;"
    )


def preview_seed(rows):
    english = [row for row in rows if row[0] == "en"]
    translated = [row for row in rows if row[0] != "en"]
    return "\n\n".join((
        "-- Private deployment input. Contains introductory copy only. Apply after the learning migration.",
        "begin;",
        insert("courses", ("id", "title", "description"),
               ((course, title, description) for _, course, title, description, _, _ in english),
               ("id",), publish=True),
        insert("course_translations", ("course_id", "language", "title", "description"),
               ((course, locale, title, description) for locale, course, title, description, _, _ in translated),
               ("course_id", "language")),
        insert("lessons", ("course_id", "id", "position", "title", "body", "access"),
               ((course, "preview", 1, title, body, "public") for _, course, _, _, title, body in english),
               ("course_id", "id"), publish=True),
        insert("lesson_translations", ("course_id", "lesson_id", "language", "title", "body"),
               ((course, "preview", locale, title, body) for locale, course, _, _, title, body in translated),
               ("course_id", "lesson_id", "language")),
        "commit;\n",
    ))


def workshop_map(digest):
    return {
        "format_version": 1,
        "source_sha256": digest,
        "legacy_storage": {
            "current_key": "pixkit.tutorial-progress.v2",
            "fallback_key": "pixkit.tutorial-progress.v1",
            "record": {"enabled": True, "levels": "track IDs mapped to completed integer levels"},
        },
        "courses": [
            {
                "id": f"arkarys-{track}",
                "legacy_track": track,
                "legacy_v1_compatible_levels": v1_limit,
                "workshop_entry": f"assets/tutorials/{folder}/index.html",
                "preview_lesson_id": "preview",
                "private_lessons": [
                    {"id": f"level-{level:02d}", "legacy_level": level, "position": level + 1}
                    for level in range(1, count + 1)
                ],
            }
            for track, (count, folder, v1_limit) in TRACKS.items()
        ],
    }


def prepare(archive_path, output_path):
    output_path = output_path.resolve()
    if output_path.is_relative_to(ROOT) or output_path in ROOT.parents:
        raise ValueError("Write generated deployment inputs to a new directory outside the Git checkout")
    if output_path.exists():
        raise ValueError("Output directory already exists. Use a new directory to preserve your files.")

    locales = [item["code"] for item in json.loads((ROOT / "data/i18n/locales.json").read_text(encoding="utf-8"))]
    with archive_path.open("rb") as source:
        with ZipFile(source) as archive:
            rows = read_source(archive, locales)
        source.seek(0)
        digest = hashlib.file_digest(source, "sha256").hexdigest()

    with tempfile.TemporaryDirectory(dir=output_path.parent) as temp:
        staged = Path(temp) / "generated"
        staged.mkdir(mode=0o700)
        (staged / "arkarys-preview-seed.sql").write_text(preview_seed(rows), encoding="utf-8")
        (staged / "arkarys-workshop-map.json").write_text(
            json.dumps(workshop_map(digest), indent=2) + "\n", encoding="utf-8"
        )
        staged.rename(output_path)
    return len(locales)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("output", type=Path, help="New directory outside the Git checkout")
    args = parser.parse_args()
    try:
        locale_count = prepare(args.archive, args.output)
    except (BadZipFile, KeyError, OSError, TypeError, ValueError) as error:
        parser.error(str(error))
    level_count = sum(count for count, _, _ in TRACKS.values())
    print(f"Prepared {len(TRACKS)} previews in {locale_count} locales and mapped {level_count} workshop levels.")


if __name__ == "__main__":
    main()
