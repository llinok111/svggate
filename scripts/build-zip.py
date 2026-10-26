"""Pack svggate into a source ZIP and write a sha256 sidecar.

The archive is the deliverable; it must be verifiable without trusting the
machine that produced it. So: python's zipfile (keeps directory structure and
dotfiles, unlike Compress-Archive), testzip() for CRCs, and a sidecar checksum
written with newline="\n" so `sha256sum -c` does not read a stray CR as part of
the filename.
"""

import hashlib
import os
import sys
import zipfile

SRC = os.environ.get("SVGGATE_SRC", "E:/WorkBuddy-Work/workbuddy-github-2/svggate")
OUT = os.environ.get("SVGGATE_OUT", "E:/WorkBuddy-Work/workbuddy-github-2/svggate-0.1.0-src.zip")
SKIP_DIRS = {"node_modules", "_out", ".git", "__pycache__"}
SKIP_FILES = {".DS_Store", "Thumbs.db"}

os.chdir(SRC)
files = []
for root, dirs, names in os.walk("."):
    dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
    for name in names:
        if name in SKIP_FILES:
            continue
        rel = os.path.relpath(os.path.join(root, name), ".").replace(os.sep, "/")
        files.append(rel)
files.sort()

with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for rel in files:
        archive.write(rel, "svggate/" + rel)

# Verify with a *fresh read handle*. Calling testzip() on the write handle reports
# bogus CRC failures, because its file position is at the end of the archive.
with zipfile.ZipFile(OUT) as check:
    broken = check.testzip()

if broken is not None:
    sys.exit("CRC failure in " + broken)

digest = hashlib.sha256(open(OUT, "rb").read()).hexdigest()
with open(OUT + ".sha256", "w", newline="\n", encoding="utf-8") as handle:
    handle.write("%s  %s\n" % (digest, os.path.basename(OUT)))

print("entries   %d" % len(files))
print("bytes     %d" % os.path.getsize(OUT))
print("sha256    %s" % digest)
print("sidecar   %s.sha256" % os.path.basename(OUT))
