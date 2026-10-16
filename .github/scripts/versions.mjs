// The release rules, decided from what the registry already has
// (docs/development.md "Versions and releases"). Every release workflow
// asks this script, in direct and mirror mode alike, and the npm mirrors
// carry a copy (export-*.mjs), so one rule decides everywhere.
//
//   node versions.mjs plan <npm|pypi> <package> <version>
//     → JSON { final, line, npmTag, mirrorBranch }, or exit 1 with the
//       reason the release is refused
//   node versions.mjs sdk-for-cli <package> <cli version>
//     → the SDK version a mirrored CLI builds on
//   node versions.mjs await-tag <package> <dist-tag> <version>
//     → after `npm publish`: waits until npm shows the tag on the version
//       (validation takes minutes), exit 1 if it never does
//
// A version is X.Y.Z, or a candidate: npm's X.Y.Z-rc.N (any semver
// pre-release) or PyPI's X.Y.ZrcN (a, b or rc). Its line is X.Y.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const NPM = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const PYPI = /^(\d+)\.(\d+)\.(\d+)(?:(a|b|rc)(\d+))?$/;

/** { major, minor, patch, pre: null | identifiers[] }, or null if not a release version. */
export function parse(version, registry = "npm") {
  if (registry === "pypi") {
    const m = PYPI.exec(version);
    if (!m) return null;
    // a < b < rc, which also sorts as text.
    return {
      major: +m[1],
      minor: +m[2],
      patch: +m[3],
      pre: m[4] ? [m[4], +m[5]] : null,
    };
  }
  const m = NPM.exec(version);
  if (!m) return null;
  return {
    major: +m[1],
    minor: +m[2],
    patch: +m[3],
    pre: m[4]
      ? m[4].split(".").map((id) => (/^\d+$/.test(id) ? +id : id))
      : null,
  };
}

/** Semver order: numbers numerically, a candidate before its final, rc.10 after rc.9. */
export function compare(a, b) {
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (!a.pre || !b.pre) return a.pre ? -1 : b.pre ? 1 : 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = typeof x === "number";
    const yn = typeof y === "number";
    if (xn !== yn) return xn ? -1 : 1; // numbers sort before words
    return x < y ? -1 : 1;
  }
  return 0;
}

const lineOf = (v) => `${v.major}.${v.minor}`;
const lineCompare = (a, b) =>
  a.major !== b.major ? a.major - b.major : a.minor - b.minor;
const highest = (versions) =>
  versions.reduce((top, v) => (!top || compare(v, top) > 0 ? v : top), null);

/**
 * How `version` is released, given every version already `published`:
 *
 * - refused unless it is higher than everything already in its own line
 *   (no going back within 1.0.x; a patch to an older line is fine);
 * - npm tag: a final takes `latest` when it is the highest final, else
 *   `latest-X.Y`; a candidate takes `latest` while no final exists yet
 *   (as pip does) and it is the highest, else `next` on the newest line
 *   and `next-X.Y` on an older one;
 * - mirror branch: `main` for the newest line, `release/X.Y` for an
 *   older one, so a patch to 1.0 never puts 1.0 code on main.
 */
export function plan(registry, version, published) {
  const v = parse(version, registry);
  if (!v) throw new Error(`${version} is not a release version`);
  const all = published
    .map((p) => parse(p, registry))
    .filter(Boolean)
    // npm's placeholder for a staged first publish is no release.
    .filter((p) => !(p.major === 0 && p.minor === 0 && p.patch === 0));
  if (published.includes(version)) {
    throw new Error(`${version} is already published; release the next number`);
  }
  const line = lineOf(v);
  const top = highest(all.filter((p) => lineOf(p) === line));
  if (top && compare(v, top) < 0) {
    throw new Error(
      `${version} is lower than ${format(top, registry)}, already released in the ${line} line; release a higher number`,
    );
  }
  const newestLine = all.every((p) => lineCompare(v, p) >= 0);
  const finals = all.filter((p) => !p.pre);
  const final = !v.pre;
  let npmTag;
  if (final) {
    npmTag = finals.every((p) => compare(v, p) > 0)
      ? "latest"
      : `latest-${line}`;
  } else if (finals.length === 0 && all.every((p) => compare(v, p) > 0)) {
    npmTag = "latest";
  } else {
    npmTag = newestLine ? "next" : `next-${line}`;
  }
  return {
    final,
    line,
    npmTag,
    mirrorBranch: newestLine ? "main" : `release/${line}`,
  };
}

function format(v, registry) {
  const base = `${v.major}.${v.minor}.${v.patch}`;
  if (!v.pre) return base;
  return registry === "pypi"
    ? `${base}${v.pre.join("")}`
    : `${base}-${v.pre.join(".")}`;
}

/**
 * The SDK a mirrored CLI is built on: the newest SDK of the CLI's major
 * version, finals only for a final CLI (a final never carries a
 * candidate), candidates allowed for a candidate CLI.
 */
export function sdkForCli(cliVersion, sdkVersions) {
  const cli = parse(cliVersion);
  if (!cli) throw new Error(`${cliVersion} is not a release version`);
  const usable = sdkVersions
    .map((s) => ({ s, v: parse(s) }))
    .filter(({ v }) => v && v.major === cli.major && (cli.pre || !v.pre));
  const best = usable.reduce(
    (top, x) => (!top || compare(x.v, top.v) > 0 ? x : top),
    null,
  );
  if (!best) {
    throw new Error(
      `no ${cli.pre ? "" : "final "}SDK ${cli.major}.x is published yet; release the SDK first`,
    );
  }
  return best.s;
}

/** Every version the registry has for a package ([] if it has none yet). */
export async function publishedVersions(registry, name) {
  if (registry === "pypi") {
    const response = await fetch(`https://pypi.org/pypi/${name}/json`);
    if (response.status === 404) return [];
    if (!response.ok)
      throw new Error(`PyPI answered ${response.status} for ${name}`);
    return Object.keys((await response.json()).releases);
  }
  try {
    const out = execFileSync("npm", ["view", name, "versions", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const versions = JSON.parse(out);
    return Array.isArray(versions) ? versions : [versions];
  } catch (error) {
    if (/E404/.test(String(error.stderr ?? error.stdout ?? ""))) return [];
    throw error;
  }
}

/** npm's dist-tags for a package ({} if it has none yet). */
function distTags(name) {
  try {
    return JSON.parse(
      execFileSync("npm", ["view", name, "dist-tags", "--json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch {
    return {};
  }
}

async function awaitTag(name, tag, version, minutes = 15) {
  const deadline = Date.now() + minutes * 60_000;
  for (;;) {
    const tags = distTags(name);
    if (tags[tag] === version) {
      console.log(`${name}@${tag} is ${version}`);
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `after ${minutes} minutes npm shows ${name}@${tag} as ${tags[tag] ?? "nothing"}, not ${version} (dist-tags: ${JSON.stringify(tags)}). A new package's first publish waits for approval under Staged Packages on npmjs.com.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20_000));
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "plan" && args.length === 3) {
    const [registry, name, version] = args;
    console.log(
      JSON.stringify(
        plan(registry, version, await publishedVersions(registry, name)),
      ),
    );
  } else if (command === "sdk-for-cli" && args.length === 2) {
    const [name, cliVersion] = args;
    console.log(sdkForCli(cliVersion, await publishedVersions("npm", name)));
  } else if (command === "await-tag" && args.length === 3) {
    await awaitTag(...args);
  } else {
    console.error(
      "usage: versions.mjs plan <npm|pypi> <package> <version> | sdk-for-cli <sdk package> <cli version> | await-tag <package> <dist-tag> <version>",
    );
    process.exit(2);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error.message ?? error);
    process.exit(1);
  });
}
