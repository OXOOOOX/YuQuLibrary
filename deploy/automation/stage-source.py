"""Stage only the files the image needs, checking them against the commit's Git tree."""
import hashlib
import json
from pathlib import Path
import sys
import tarfile


BUILD_FILES = {
    ".dockerignore", "package.json", "package-lock.json", "tsconfig.json",
    "workers/codex-bridge/package.json", "deploy/Dockerfile", "deploy/compose.yaml",
}
BUILD_DIRS = ("apps/web/", "packages/", "db/", "scripts/", "workers/ingestion/")
HOST_FILES = {
    "deploy/automation/ssh-entry", "deploy/automation/request", "deploy/automation/deploy-main.sh",
    "deploy/automation/stage-source.py", "deploy/upgrade-schema.sh", "deploy/compose.yaml",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def blob_digest(size):
    return hashlib.sha1(f"blob {size}\0".encode("ascii"))


def stage(run, revision, tree_sha, destination, trusted):
    manifest = json.loads((run / "tree.json").read_bytes())
    require(manifest["truncated"] is False and manifest["sha"] == tree_sha, "Incomplete Git tree")
    files = {}
    for entry in manifest["tree"]:
        name = entry["path"]
        if name not in BUILD_FILES | HOST_FILES and not name.startswith(BUILD_DIRS):
            continue
        require(all(part not in ("", ".", "..") for part in name.split("/")), "Invalid source path")
        if entry["type"] == "tree":
            continue
        require(entry["type"] == "blob" and entry["mode"] in ("100644", "100755"), "Unsupported source entry")
        require(name not in files, "Duplicate Git entry")
        files[name] = entry
    require((BUILD_FILES | HOST_FILES) <= files.keys(), "Required files missing from commit")
    for name in HOST_FILES:
        content = (trusted / Path(name).name).read_bytes()
        digest = blob_digest(len(content))
        digest.update(content)
        require(digest.hexdigest() == files[name]["sha"], "Install the reviewed host tools first: " + name)

    pending = {name: entry for name, entry in files.items() if name in BUILD_FILES or name.startswith(BUILD_DIRS)}
    root = f"YuQuLibrary-{revision}"
    seen = set()
    with tarfile.open(run / "source.tar.gz", "r|gz") as archive:
        for member in archive:
            require(archive.pax_headers.get("comment") == revision, "Archive revision differs")
            if member.name == root and member.isdir():
                continue
            require(member.name.startswith(root + "/"), "Unexpected archive root")
            name = member.name[len(root) + 1:]
            require(all(part not in ("", ".", "..") for part in name.split("/")), "Invalid archive path")
            require(name not in seen, "Duplicate archive member")
            seen.add(name)
            if name not in pending:
                continue
            entry = pending.pop(name)
            require(member.isreg() and not member.issparse() and member.size == entry["size"], "Invalid archived file")
            executable = entry["mode"] == "100755"
            require(bool(member.mode & 0o111) == executable, "Archived mode differs")
            output = destination / name
            output.parent.mkdir(parents=True, exist_ok=True)
            digest = blob_digest(member.size)
            with archive.extractfile(member) as source, output.open("xb") as target:
                while chunk := source.read(1024 * 1024):
                    digest.update(chunk)
                    target.write(chunk)
            require(digest.hexdigest() == entry["sha"], "Archived content differs: " + name)
            output.chmod(0o755 if executable else 0o644)
    require(not pending, "Missing source files")


if __name__ == "__main__":
    run, revision, tree_sha, destination, trusted = sys.argv[1:]
    stage(Path(run), revision, tree_sha, Path(destination), Path(trusted))
