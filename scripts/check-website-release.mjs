import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.argv[2]
  ? path.resolve(process.argv[2])
  : fileURLToPath(new URL("../", import.meta.url));

function attribute(tag, name) {
  return tag.match(new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, "i"))?.[2];
}

try {
  const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
  if (typeof version !== "string" || !version.trim()) {
    throw new Error("package.json must contain a nonempty version.");
  }

  const html = readFileSync(path.join(root, "website/index.html"), "utf8")
    .replace(/<!--[\s\S]*?-->/g, "");
  const script = readFileSync(path.join(root, "website/main.js"), "utf8");
  const expectedUrl = `https://github.com/imboni/trivor/releases/tag/v${version}`;
  const failures = [];
  const siteVersion = attribute(html.match(/<html\b[^>]*>/i)?.[0] ?? "", "data-site-version");

  if (siteVersion !== version) {
    failures.push(`website/index.html data-site-version is ${JSON.stringify(siteVersion) ?? "missing"}; expected ${JSON.stringify(version)}.`);
  }

  const notesLinks = [...html.matchAll(/<a\b[^>]*>/gi)]
    .map(([tag]) => tag)
    .filter((tag) => attribute(tag, "data-href") === "release-notes");
  if (!notesLinks.length) {
    failures.push('website/index.html is missing a release notes link with data-href="release-notes".');
  }
  for (const tag of notesLinks) {
    const href = attribute(tag, "href");
    if (href !== expectedUrl) {
      failures.push(`website/index.html release notes href is ${JSON.stringify(href) ?? "missing"}; expected ${JSON.stringify(expectedUrl)}.`);
    }
  }

  const notesUrl = script.match(/^\s*const\s+RELEASE_NOTES_URL\s*=\s*(["'])(.*?)\1\s*;/m)?.[2];
  if (notesUrl !== expectedUrl) {
    failures.push(`website/main.js RELEASE_NOTES_URL is ${JSON.stringify(notesUrl) ?? "missing"}; expected ${JSON.stringify(expectedUrl)}.`);
  }

  for (const [pattern, name, resource] of [
    [/<script\b[^>]*>/gi, "src", "main.js"],
    [/<link\b[^>]*>/gi, "href", "styles.css"],
  ]) {
    const expectedResource = `${resource}?v=${encodeURIComponent(version)}`;
    const resourceUrls = [...html.matchAll(pattern)]
      .map(([tag]) => attribute(tag, name))
      .filter((url) => url?.split(/[?#]/)[0] === resource);
    if (!resourceUrls.length) {
      failures.push(`website/index.html is missing the ${resource} resource; expected ${name}=${JSON.stringify(expectedResource)}.`);
    }
    for (const url of resourceUrls) {
      if (url !== expectedResource) {
        failures.push(`website/index.html ${resource} resource URL is ${JSON.stringify(url)}; expected ${JSON.stringify(expectedResource)}.`);
      }
    }
  }

  if (failures.length) throw new Error(failures.join("\n"));
  console.log(`Website release metadata matches Trivor ${version}. Review both languages and verify the Pages deployment before completing the release.`);
} catch (error) {
  console.error(`Website release check failed:\n${error.message}\n\nUpdate the English and Chinese website copy for this release, its HTML fallback, data-site-version, both release notes URLs and the main.js/styles.css version queries. See docs/RELEASE.md and website/README.md.`);
  process.exitCode = 1;
}
