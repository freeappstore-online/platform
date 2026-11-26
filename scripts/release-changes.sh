# Shared by the publish workflow and its tests: decide releases from what npm
# actually has (#780, #803). A version-sync or bump commit on main says nothing
# about which source was packed, so the published source is read from the npm
# provenance attestation instead (the commit the publishing run checked out).

# Prints the commit <package>@<version> was published from, or nothing.
published_source_sha() {
  curl -fsS --retry 3 "https://registry.npmjs.org/-/npm/v1/attestations/${1/\//%2f}@$2" 2>/dev/null |
    node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        try {
          const a = JSON.parse(s).attestations.find((a) => a.predicateType.startsWith("https://slsa.dev/provenance/"));
          const p = JSON.parse(Buffer.from(a.bundle.dsseEnvelope.payload, "base64"));
          console.log(p.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit);
        } catch {}
      });
    '
}

# Succeeds when <package dir> at HEAD differs from <published sha> beyond the
# version stamps. An unknown source counts as changed: an extra patch release is
# harmless, a missed one is not.
changed_since_published() {
  local dir="$1" published="$2"
  if [ -z "$published" ] || ! git cat-file -e "$published^{commit}" 2>/dev/null; then return 0; fi
  # npm already holds this commit (or a later one): nothing new to release.
  if git merge-base --is-ancestor HEAD "$published"; then return 1; fi
  ! git diff --quiet -I'^ *"version": ' -I"^export const SDK_VERSION = '" "$published" HEAD -- "$dir"
}
