#!/usr/bin/env python3
"""Validate a notarized ZIP before ditto sees it; never follow archive-controlled links."""
import pathlib
import posixpath
import stat
import sys
import zipfile
import unicodedata


def canonical(path):
    # APFS/HFS+ default volumes compare paths without case and Unicode normalization differences.
    return unicodedata.normalize('NFD', unicodedata.normalize('NFD', path).casefold())


def validate(path):
    seen = set()
    spellings = {}
    links = {}
    total = 0
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if not entries or len(entries) > 100000:
            raise ValueError('Invalid ZIP entry count')
        for entry in entries:
            name = entry.filename
            trimmed = name.rstrip('/')
            parts = pathlib.PurePosixPath(trimmed).parts
            if (not trimmed or '\\' in name or '\x00' in name or name.startswith('/') or
                    any(part in ('', '.', '..') for part in name.rstrip('/').split('/')) or
                    not parts or parts[0] not in ('FreeAppStore.app', '__MACOSX')):
                raise ValueError('Unsafe ZIP path')
            if parts[0] == '__MACOSX' and not (trimmed == '__MACOSX' and entry.is_dir()) and (len(parts) < 2 or parts[1] not in ('FreeAppStore.app', '._FreeAppStore.app')):
                raise ValueError('Unexpected ZIP sidecar')
            key = canonical(trimmed)
            if key in seen:
                raise ValueError('Duplicate or normalized ZIP path alias')
            # Include implicit directories: Foo/a and foo/b collide even without directory entries.
            for count in range(1, len(parts) + 1):
                prefix = '/'.join(parts[:count])
                alias = canonical(prefix)
                if alias in spellings and spellings[alias] != prefix:
                    raise ValueError('Case or Unicode ZIP path alias')
                spellings[alias] = prefix
            seen.add(key)
            total += entry.file_size
            if total > 4_000_000_000 or entry.file_size > 1_500_000_000 or entry.flag_bits & 1:
                raise ValueError('ZIP exceeds extraction bounds or is encrypted')
            mode = entry.external_attr >> 16
            kind = stat.S_IFMT(mode)
            if kind not in (0, stat.S_IFREG, stat.S_IFDIR, stat.S_IFLNK):
                raise ValueError('Unsupported ZIP entry type')
            if stat.S_ISLNK(mode):
                if entry.file_size > 4096:
                    raise ValueError('Oversized symlink')
                target = archive.read(entry).decode('utf-8')
                if not target or target.startswith('/') or '\\' in target or '\x00' in target:
                    raise ValueError('Unsafe ZIP symlink')
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(trimmed), target))
                resolved = canonical(resolved)
                if not resolved.startswith(canonical('FreeAppStore.app/')):
                    raise ValueError('Escaping ZIP symlink')
                links[key] = resolved
        if canonical('FreeAppStore.app/Contents/Info.plist') not in seen:
            raise ValueError('Missing app bundle')
        for path, target in links.items():
            # No archive entry can be extracted through an existing symlink.
            if any(name.startswith(path + '/') for name in seen):
                raise ValueError('ZIP entry beneath symlink')
            visited = {path}
            while True:
                if target in visited:
                    raise ValueError('Cyclic ZIP symlink')
                visited.add(target)
                components = target.split('/')
                linked_prefix = next((('/'.join(components[:i]), i)
                                      for i in range(1, len(components) + 1)
                                      if '/'.join(components[:i]) in links), None)
                if linked_prefix is None:
                    break
                prefix, count = linked_prefix
                target = posixpath.normpath(posixpath.join(links[prefix], *components[count:]))
                if len(visited) > len(links) + 2:
                    raise ValueError('Cyclic ZIP symlink')
            if target not in seen:
                raise ValueError('Dangling ZIP symlink')
    return len(seen)


if __name__ == '__main__':
    try:
        print(f'Validated {validate(sys.argv[1])} ZIP paths')
    except (ValueError, UnicodeError, zipfile.BadZipFile, OSError) as error:
        raise SystemExit(f'Unsafe Mac archive: {error}')
