#!/usr/bin/env python3
"""Audit the resolved host registry graph against OSV, without installing tools."""
import json
import subprocess
import sys
import urllib.request


def main():
    host = next(line.split(": ", 1)[1] for line in subprocess.check_output(
        ["rustc", "-vV"], text=True).splitlines() if line.startswith("host: "))
    graph = json.loads(subprocess.check_output([
        "cargo", "metadata", "--manifest-path", "src-tauri/Cargo.toml", "--locked",
        "--format-version", "1", "--filter-platform", host,
    ], text=True))
    packages = [package for package in graph["packages"]
                if (package.get("source") or "").startswith("registry+")]
    queries = [{"package": {"name": package["name"], "ecosystem": "crates.io"},
                "version": package["version"]} for package in packages]
    request = urllib.request.Request("https://api.osv.dev/v1/querybatch",
                                     data=json.dumps({"queries": queries}).encode(),
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=60) as response:
        results = json.load(response)["results"]
    failures = 0
    details = {}
    for package, result in zip(packages, results):
        for vulnerability in result.get("vulns", []):
            identifier = vulnerability["id"]
            if identifier not in details:
                with urllib.request.urlopen("https://api.osv.dev/v1/vulns/" + identifier, timeout=30) as response:
                    details[identifier] = json.load(response)
            informational = [affected.get("database_specific", {}).get("informational")
                             for affected in details[identifier].get("affected", [])]
            maintenance = informational and all(value == "unmaintained" for value in informational)
            print("MAINTENANCE" if maintenance else "VULNERABILITY", package["name"], package["version"], identifier)
            failures += not maintenance
    print(f"Scanned {len(packages)} host registry packages; {failures} actionable advisories")
    return int(failures > 0)


if __name__ == "__main__":
    sys.exit(main())
